/**
 * Stage 1 of the correction pipeline: heuristic recall pre-filter.
 *
 * Walks (user, assistant) turn pairs and returns user turns that look
 * like corrections. Optimized for *recall* — admits noise. The LLM
 * classification stage downstream filters to actionable corrections
 * with distilled rule text suitable for clustering.
 *
 * Pure. No I/O, no LLM. Deterministic given identical input.
 *
 * Internal model — labeling functions (LFs):
 *
 *   Each pattern family is exposed as a named labeling function (an
 *   `LabelingFunction` object: `name`, `kind`, `scope`, regexes,
 *   matchScope flag). The kernel iterates `CORRECTION_LFS` rather than
 *   inlining regex arrays into the scan loop. This is the "Snorkel-
 *   style data programming" shape (Ratner et al., VLDB 2017) without
 *   the framework dependency — each LF returns hits with metadata,
 *   the kernel unions them. Today the union is a simple "fire if any
 *   LF fires"; switching to a label model later would be a one-line
 *   change at the union site.
 *
 *   Why bother with the abstraction over inline regexes:
 *   - **Diagnostics for free.** `computeLfFiringStats` walks already-
 *     extracted `Correction[]` and counts per-LF firings + pairwise
 *     agreement — answers "which LF is dead weight?" and "which two
 *     LFs always co-fire and could be collapsed?" without recomputing.
 *   - **Per-LF testability.** Tests can target individual LFs in
 *     isolation rather than asserting on the full extractor's union.
 *   - **Programmatic enumeration.** `CORRECTION_LFS` is a public
 *     export — downstream audit/viewer code can list available LFs,
 *     show counts, or surface coverage gaps. No reflection needed.
 *
 * Adversarial-validation note: surface-form patterns mis-fire on
 *   - "no, that worked!"  → 'no' is affirmative-sense
 *   - "stop the dev server" → imperative-stop targeting tool, not behavior
 *   - "actually that's correct" → 'actually' is affirmative-sense
 * These are knowingly admitted; the LLM stage's `actionable` flag
 * removes them. Do not add ad-hoc exclusions here — that erodes recall.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type {
  Correction,
  CorrectionSignal,
  CorrectionSignalKind,
} from '@chat-arch/schema';
import { unwrapEnvelope } from './unwrapEnvelope.js';

/**
 * Bumped whenever the heuristic ruleset changes (new pattern family,
 * broadened regex, looksLikeUserPrompt rule change). Persisted in
 * `correction-candidates.json` as `heuristicRecallVersion`; the
 * exporter's incremental rescan uses it as a cache key — a version
 * mismatch invalidates the cache and forces every session to be
 * re-scanned.
 *
 * History:
 *   1 — initial release (explicit-stop / explicit-no with verb whitelist
 *       / instead-of / imperative-override / frustration / repeat-instruction)
 *   2 — broadened explicit-no negation, added soft-redirect and
 *       want-prefer families, added `just|please` to imperative-override
 *       (2026-05 audit, see scripts/audit-correction-recall.mjs)
 *   3 — `excerpt` and `precedingAssistantExcerpt` are now passed through
 *       `unwrapEnvelope` before truncation, so harness wrappers
 *       (slash-command triples / scheduled-task / system-reminder) no
 *       longer leak into the LLM classifier and the CorrectionPatternCard
 *       evidence rows. Same per-turn match set as v2 — only the stored
 *       excerpt text changes — but bumped because cached rows must be
 *       re-emitted to pick up the new excerpt shape.
 *
 * Note: the 2026-05 LF refactor (extracted pattern families into
 * CORRECTION_LFS + added diagnostics) did NOT bump the version because
 * the kernel's per-turn output is byte-identical to v2 — same patterns,
 * same iteration order, same dedup behavior. Bumping would force a
 * costly full-corpus rescan with no payoff. Bump only when the actual
 * recall set changes.
 */
export const HEURISTIC_RECALL_VERSION = 3;

/** Minimal turn shape — extracted from any source's transcript. */
export interface TurnPair {
  /** Stable session id (UnifiedSessionEntry.id). */
  sessionId: string;
  /** 0-based index into the session's user turns. */
  userTurnIndex: number;
  userText: string;
  /** Null for the first user turn of the session. */
  precedingAssistantText: string | null;
}

/**
 * One labeling function — a named bundle of patterns that searches a
 * scoped window of user text and emits hits tagged with a kind.
 *
 *   - `name`      stable identifier; used in diagnostics and tests.
 *   - `kind`      `CorrectionSignalKind` emitted on hit. Multiple LFs
 *                 MAY emit the same kind (e.g. two LFs both labeled
 *                 'explicit-no') — `name` is the diagnostic-level
 *                 identifier, `kind` is the downstream label.
 *   - `scope`     `'full'` searches the whole user text; `'prefix'`
 *                 searches only the first POSITIONAL_PREFIX_LEN chars
 *                 (the "lead" of the message, where sentence-initial
 *                 markers like 'actually,' or 'wait,' are meaningful).
 *   - `patterns`  RegExp[] OR-joined — any one match counts as a hit.
 *   - `caseSensitive` defaults to false (regex `i` flag). The
 *                 frustration LF uses `true` because ALL-CAPS is
 *                 itself the signal.
 *
 * Pure data: LFs hold no state, can be created at module scope, and
 * are safe to expose to viewer/diagnostic code.
 */
export interface LabelingFunction {
  readonly name: string;
  readonly kind: CorrectionSignalKind;
  readonly scope: 'full' | 'prefix';
  readonly patterns: ReadonlyArray<RegExp>;
}

const NEGATION_EXCLUSIONS = '(?:worry|mind|think|know|believe|wanna|want|see|forget|hesitate|tell|matter)';

/**
 * The labeling-function registry. Order is preserved in diagnostics
 * output but doesn't affect correctness (LF firing is set-based, not
 * sequential). New LFs should be appended; renaming an LF requires a
 * `HEURISTIC_RECALL_VERSION` bump if the rename changes which sessions
 * fire (cache invalidation).
 */
export const CORRECTION_LFS: ReadonlyArray<LabelingFunction> = [
  {
    name: 'explicit-stop.imperative',
    kind: 'explicit-stop',
    scope: 'full',
    patterns: [
      /\b(stop|quit|cease)\b\s+(adding|generating|writing|using|making|doing|including)\b/i,
      /\bplease\s+(stop|don'?t)\b/i,
    ],
  },
  {
    name: 'explicit-no.whitelist',
    kind: 'explicit-no',
    scope: 'full',
    patterns: [
      // Targeted whitelist (kept for back-compat / explicit anchoring).
      /\b(don'?t|do not|never)\b\s+(add|generate|write|use|make|do|include|create|put)\b/i,
      /\bno+,?\s+(don'?t|not)\b/i,
    ],
  },
  {
    name: 'explicit-no.broadened',
    kind: 'explicit-no',
    scope: 'full',
    // Broadened negation: don't/never + any verb-like token, with a small
    // exclusion list for common non-corrective idioms. Audit found 150
    // missed turns where `don't/never` was followed by verbs OUTSIDE the
    // whitelist (change, refactor, assume, bother, touch, mention, …).
    patterns: [
      new RegExp(
        `\\b(don'?t|do not|never)\\b\\s+(?!${NEGATION_EXCLUSIONS}\\b)[a-z]{2,}\\b`,
        'i',
      ),
    ],
  },
  {
    name: 'instead-of',
    kind: 'instead-of',
    scope: 'prefix',
    patterns: [/\binstead of\b/i, /\brather than\b/i, /\bnot\b.+\bbut\b/i],
  },
  {
    name: 'imperative-override',
    kind: 'imperative-override',
    scope: 'full',
    patterns: [
      /^\s*(always|never|only|prefer|just|please)\b/i,
      /\b(use|prefer)\s+\w+\s+(not|over|instead of)\b/i,
    ],
  },
  {
    name: 'frustration',
    kind: 'frustration',
    scope: 'full',
    // Note the third pattern is intentionally case-sensitive — caps-
    // locked NO/STOP/DON'T is itself the signal, lower-case wouldn't
    // distinguish from neutral usage.
    patterns: [
      /!{2,}/,
      /\?{2,}/,
      /\b(NO|STOP|DON'?T)\b/,
      /\b(again|still)\b.*\b(told|said|asked)\b/i,
    ],
  },
  {
    name: 'soft-redirect',
    kind: 'soft-redirect',
    scope: 'prefix',
    // Audit found ~177 missed corrections shaped this way (`actually,…`,
    // `wait,…`, `let's …`). The `let's` arm matches both directives and
    // concessions; the duplicate phrase-key dedupe in scanTurn collapses
    // overlap with negation patterns.
    patterns: [
      /^\s*(actually|wait|hmm+|hold on|hang on|nope|nah)\b/i,
      /^\s*let'?s\s+\w+/i,
    ],
  },
  {
    name: 'want-prefer',
    kind: 'want-prefer',
    scope: 'full',
    // First-person preference statements. Audit found 80 missed
    // corrections shaped as "I want X", "I'd prefer Y", "I would like Z".
    // Weaker signals than explicit-no but the LLM stage classifies many
    // as actionable.
    patterns: [
      /\bi\s+(want|need|prefer|wish)\b/i,
      /\bi'?d\s+(rather|prefer|like)\b/i,
      /\bi\s+would\s+(like|prefer|rather)\b/i,
    ],
  },
];

interface HeuristicHit {
  /** The LF that fired (diagnostic-level identifier). */
  lfName: string;
  /** Schema-level signal kind emitted to the Correction. */
  kind: CorrectionSignalKind;
  phrase: string;
}

const POSITIONAL_PREFIX_LEN = 300;

function scanTurn(userText: string): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  const seenPhrases = new Set<string>();
  const prefix = userText.slice(0, POSITIONAL_PREFIX_LEN);

  for (const lf of CORRECTION_LFS) {
    const haystack = lf.scope === 'prefix' ? prefix : userText;
    for (const pat of lf.patterns) {
      const m = haystack.match(pat);
      if (m !== null) {
        const phrase = m[0].slice(0, 80);
        // Dedup by (kind, phrase) so two LFs emitting the same kind on
        // the same phrase produce one signal — preserves byte-identical
        // output with the pre-LF-refactor implementation, which scanned
        // each kind in series and skipped repeat phrases per kind.
        const key = `${lf.kind}:${phrase.toLowerCase()}`;
        if (!seenPhrases.has(key)) {
          seenPhrases.add(key);
          hits.push({ lfName: lf.name, kind: lf.kind, phrase });
        }
      }
    }
  }

  return hits;
}

/**
 * Scans an array of (user, assistant) turn pairs from a single session
 * and returns Correction candidates with classification === null.
 *
 * Repeat-instruction detection runs at the session scope: when the
 * same user-text n-gram (≥4 tokens) recurs after an intervening
 * assistant turn, the later turn gets a 'repeat-instruction' signal
 * even if no surface negation pattern fired. Captures cases like:
 *   user:      "use kebab-case for filenames"
 *   assistant: <writes camelCase anyway>
 *   user:      "kebab-case for filenames"  ← repeat-instruction
 */
export function detectCorrectionCandidates(
  turns: ReadonlyArray<TurnPair>,
): Correction[] {
  const out: Correction[] = [];
  const seenInstructionGrams = new Map<string, number>(); // gram → first turnIndex

  for (const t of turns) {
    const hits = scanTurn(t.userText);

    // Repeat-instruction pass: 4-gram windows from prior user turns.
    // Not modeled as a CORRECTION_LFS entry because it's session-scoped
    // (depends on earlier turns), not turn-local. Diagnostic-level
    // counters in computeLfFiringStats include it under the synthetic
    // name 'repeat-instruction.session-gram'.
    if (t.userTurnIndex > 0) {
      const grams = extractContentGrams(t.userText, 4);
      for (const g of grams) {
        const earlier = seenInstructionGrams.get(g);
        if (earlier !== undefined && earlier < t.userTurnIndex) {
          hits.push({
            lfName: 'repeat-instruction.session-gram',
            kind: 'repeat-instruction',
            phrase: g,
          });
          break;
        }
      }
      // After scanning, register this turn's grams for future repeat detection.
      for (const g of grams) {
        if (!seenInstructionGrams.has(g)) {
          seenInstructionGrams.set(g, t.userTurnIndex);
        }
      }
    } else {
      const grams = extractContentGrams(t.userText, 4);
      for (const g of grams) seenInstructionGrams.set(g, t.userTurnIndex);
    }

    if (hits.length === 0) continue;

    const signals: CorrectionSignal[] = hits.map((h) => ({
      kind: h.kind,
      phrase: h.phrase,
    }));

    // Strip harness envelopes before truncating so the LLM
    // classification stage (and the CorrectionPatternCard viewer)
    // never sees `<command-message>…</command-args>` in the
    // excerpt. unwrapEnvelope returns the user's actual text or
    // a synthesized `/slash-cmd args` form when the wrapper was the
    // user's input. `?? t.userText` keeps the original truncate
    // contract when the unwrap yields null on whitespace-only
    // payloads — better to render something than drop the row.
    const unwrappedUser = unwrapEnvelope(t.userText) ?? t.userText;
    const unwrappedAssistant =
      t.precedingAssistantText === null
        ? null
        : unwrapEnvelope(t.precedingAssistantText) ?? t.precedingAssistantText;
    out.push({
      id: makeCorrectionId(t.sessionId, t.userTurnIndex),
      sessionId: t.sessionId,
      userTurnIndex: t.userTurnIndex,
      excerpt: truncate(unwrappedUser, 500),
      precedingAssistantExcerpt:
        unwrappedAssistant === null ? null : truncate(unwrappedAssistant, 500),
      signals,
      classification: null,
    });
  }

  return out;
}

/**
 * Single-LF probe — runs ONE labeling function against a user-text
 * string and returns its hits. Exposed so tests + audit scripts can
 * target individual LFs in isolation; production code should use
 * `detectCorrectionCandidates` instead.
 */
export function runLabelingFunction(
  lf: LabelingFunction,
  userText: string,
): ReadonlyArray<{ kind: CorrectionSignalKind; phrase: string }> {
  const prefix = userText.slice(0, POSITIONAL_PREFIX_LEN);
  const haystack = lf.scope === 'prefix' ? prefix : userText;
  const hits: { kind: CorrectionSignalKind; phrase: string }[] = [];
  const seen = new Set<string>();
  for (const pat of lf.patterns) {
    const m = haystack.match(pat);
    if (m === null) continue;
    const phrase = m[0].slice(0, 80);
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: lf.kind, phrase });
  }
  return hits;
}

/**
 * Per-LF firing diagnostics over a set of already-extracted Corrections.
 *
 *   - `firingsByKind`     count of Corrections that fired each signal
 *                         kind. Keyed by `CorrectionSignalKind`, not LF
 *                         name — multiple LFs of the same kind are summed
 *                         (e.g. `explicit-no.whitelist` and
 *                         `explicit-no.broadened` both contribute to
 *                         `explicit-no`).
 *   - `agreement`         pairwise co-fire count: how many corrections
 *                         fired BOTH kinds. Useful for spotting LFs that
 *                         are effectively duplicates (always co-fire) vs.
 *                         orthogonal (rarely overlap).
 *
 * Walks `Correction[]` (the kernel's existing output) rather than
 * re-running the scan, so this is cheap to call from audit scripts
 * without re-doing the full extraction.
 */
export function computeLfFiringStats(corrections: ReadonlyArray<Correction>): {
  firingsByKind: ReadonlyMap<CorrectionSignalKind, number>;
  agreement: ReadonlyMap<string, number>;
  totalCorrections: number;
} {
  const firingsByKind = new Map<CorrectionSignalKind, number>();
  const agreement = new Map<string, number>();
  for (const c of corrections) {
    const kinds = new Set<CorrectionSignalKind>();
    for (const s of c.signals) kinds.add(s.kind);
    for (const k of kinds) firingsByKind.set(k, (firingsByKind.get(k) ?? 0) + 1);
    const sorted = [...kinds].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = `${sorted[i]}|${sorted[j]}`;
        agreement.set(key, (agreement.get(key) ?? 0) + 1);
      }
    }
  }
  return { firingsByKind, agreement, totalCorrections: corrections.length };
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'as',
  'it',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'me',
  'us',
  'them',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
]);

function extractContentGrams(text: string, n: number): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (tokens.length < n) return [];
  const grams: string[] = [];
  for (let i = 0; i <= tokens.length - n; i += 1) {
    grams.push(tokens.slice(i, i + n).join(' '));
  }
  return grams;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function makeCorrectionId(sessionId: string, turnIndex: number): string {
  const enc = new TextEncoder();
  const h = bytesToHex(sha256(enc.encode(`${sessionId}:${turnIndex}`)));
  return `cor_${h.slice(0, 12)}`;
}
