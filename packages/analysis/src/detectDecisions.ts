/**
 * Stage 1 of the decision pipeline: heuristic recall pre-filter for
 * decision-tracking (#1 in the outcome-substrate roadmap).
 *
 * Walks (user, assistant) turn pairs and returns user turns that look
 * like a decision was made. Optimized for *recall* — admits noise. The
 * LLM classification stage downstream filters to actionable decisions
 * with a distilled decision statement, chosen / rejected options, and
 * the outcome join.
 *
 * Pure. No I/O, no LLM. Deterministic given identical input.
 *
 * Internal model — labeling functions (LFs):
 *
 *   Each pattern family is exposed as a named labeling function. The
 *   kernel iterates `DECISION_LFS` rather than inlining regex arrays
 *   into the scan loop — same Snorkel-style data-programming shape
 *   as `detectCorrectionCandidates.ts`. Each LF returns hits with
 *   metadata; the kernel unions them. Diagnostics + per-LF testability
 *   come "for free" from this shape.
 *
 *   The `alternative-block` LF is a two-turn family: it inspects the
 *   *preceding assistant turn* for an enumerated options block, and
 *   fires when the user turn contains a short concurrence keyword
 *   (e.g. "A", "the first", "yes do that"). The other four LFs are
 *   turn-local and don't depend on assistant context.
 *
 * Adversarial-validation note: surface-form patterns mis-fire on
 *   - "decide later" → `decision:` colon-form doesn't fire, but the
 *     LLM may still see `decide` and reclassify.
 *   - "use the same approach" → `use \w+` at turn-start is an
 *     imperative-choice hit even when the "choice" is no choice at
 *     all.
 *   - "yes do that" → fires `alternative-block` even when the prior
 *     assistant turn wasn't an options enumeration.
 *   These are knowingly admitted; the LLM stage's `actionable` flag
 *   removes them. Do not add ad-hoc exclusions here — per the
 *   corrections precedent, that erodes recall.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { DecisionCandidate, DecisionKind } from '@chat-arch/schema';

/**
 * Bumped whenever the heuristic ruleset changes (new pattern family,
 * broadened regex, scope flag change). The builder's incremental
 * rescan uses this as a cache key — a version mismatch invalidates
 * the cache and forces every session to be re-scanned.
 *
 * History:
 *   1 — initial release (explicit-marker, explicit-go-with, instead-of,
 *       alternative-block, imperative-choice)
 */
export const DECISION_HEURISTIC_VERSION = 1;

/** Minimal turn shape — extracted from any source's transcript. */
export interface DecisionTurnPair {
  /** Stable session id (UnifiedSessionEntry.id). */
  sessionId: string;
  /** 0-based index into the session's user turns. */
  userTurnIndex: number;
  userText: string;
  /** Null for the first user turn of the session. */
  precedingAssistantText: string | null;
}

/**
 * One labeling function — a named bundle of patterns. Mirrors the
 * shape of `LabelingFunction` in `detectCorrectionCandidates.ts` but
 * adds `inspects` to distinguish turn-local LFs from the
 * alternative-block LF (which needs assistant context).
 *
 *   - `name`        stable identifier; used in diagnostics + tests.
 *   - `kind`        `DecisionKind` emitted on hit.
 *   - `scope`       `'full'` searches the whole user text; `'prefix'`
 *                   searches only the first POSITIONAL_PREFIX_LEN
 *                   chars. Ignored for `inspects: 'pair'` LFs.
 *   - `inspects`    `'turn'` — turn-local; `'pair'` — needs the prior
 *                   assistant text. The alternative-block LF is the
 *                   only `'pair'` LF today.
 *   - `patterns`    RegExp[] OR-joined — any match counts as a hit.
 */
export interface DecisionLabelingFunction {
  readonly name: string;
  readonly kind: DecisionKind;
  readonly scope: 'full' | 'prefix';
  readonly inspects: 'turn' | 'pair';
  readonly patterns: ReadonlyArray<RegExp>;
}

const POSITIONAL_PREFIX_LEN = 300;
const CONTEXT_WINDOW = 500;
const PHRASE_MAX = 80;

/**
 * Patterns that recognise an enumerated options block in the
 * assistant's *prior* turn. Used by the `alternative-block` LF: if
 * the prior assistant text contains one of these patterns AND the
 * user's reply is a short concurrence keyword, the LF fires.
 *
 * Tuned for recall — both Markdown-style ("Option A:", "1.") and
 * prose enumerations ("Two approaches:", "There are three options")
 * are admitted.
 */
const ASSISTANT_OPTIONS_PATTERNS: ReadonlyArray<RegExp> = [
  /\boption\s+[a-d]\s*[:.-]/i,
  /^\s*(?:[a-d]|[1-4])[.):-]\s+\S/m,
  /\b(?:two|three|four|several)\s+(?:approaches?|options?|alternatives?|choices?)\b/i,
  /\b(?:approach|option|alternative|choice)\s+(?:one|two|three|1|2|3)\b/i,
];

/**
 * Concurrence keywords — short user replies that signal "I pick one
 * of the options you just listed". Anchored to turn-start so a
 * verbose reply mentioning "A" in passing doesn't fire.
 */
const ALTERNATIVE_CONCURRENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*(?:option\s+)?[a-d]\b\s*[.!]?$/i,
  /^\s*(?:option\s+)?[1-4]\b\s*[.!]?$/,
  /^\s*the\s+(?:first|second|third|fourth|former|latter|last)\b/i,
  /^\s*yes,?\s*(?:do|let'?s do|go with|pick|choose)\s+that\b/i,
  /^\s*(?:do|go with|pick|choose|use)\s+(?:option\s+)?[a-d1-4]\b/i,
  /^\s*(?:let'?s\s+)?(?:go|do|pick|choose|use)\s+(?:the\s+)?(?:first|second|third|fourth)\b/i,
];

/**
 * The labeling-function registry. Order is preserved in diagnostics
 * output but doesn't affect correctness (LF firing is set-based, not
 * sequential). New LFs should be appended; renaming an LF requires a
 * `DECISION_HEURISTIC_VERSION` bump if the rename changes which
 * sessions fire (cache invalidation).
 */
export const DECISION_LFS: ReadonlyArray<DecisionLabelingFunction> = [
  {
    name: 'explicit-marker',
    kind: 'explicit-marker',
    scope: 'full',
    inspects: 'turn',
    patterns: [
      /\bdecision\s*:/i,
      /\bwe(?:'ve|\s+have)?\s+decided\b/i,
      /\bi(?:'ve|\s+have)?\s+decided\b/i,
    ],
  },
  {
    name: 'explicit-go-with',
    kind: 'explicit-go-with',
    scope: 'full',
    inspects: 'turn',
    patterns: [
      /\b(?:let'?s|i'?ll|we'?ll|i\s+will|we\s+will)\s+(?:go|use|pick|choose)(?:\s+with)?\s+\S/i,
      /\b(?:let'?s|i'?ll|we'?ll)\s+go\s+with\b/i,
    ],
  },
  {
    name: 'instead-of',
    kind: 'instead-of',
    scope: 'full',
    inspects: 'turn',
    patterns: [/\binstead\s+of\b/i, /\brather\s+than\b/i],
  },
  {
    name: 'alternative-block',
    kind: 'alternative-block',
    scope: 'prefix',
    inspects: 'pair',
    patterns: ALTERNATIVE_CONCURRENCE_PATTERNS,
  },
  {
    name: 'imperative-choice',
    kind: 'imperative-choice',
    scope: 'prefix',
    inspects: 'turn',
    patterns: [
      /^\s*(?:use|pick|go\s+with|choose)\s+\S+/i,
    ],
  },
];

interface DecisionHit {
  lfName: string;
  kind: DecisionKind;
  phrase: string;
  startOffset: number;
}

function assistantHasOptions(assistantText: string | null): boolean {
  if (assistantText === null) return false;
  for (const pat of ASSISTANT_OPTIONS_PATTERNS) {
    if (pat.test(assistantText)) return true;
  }
  return false;
}

function scanTurn(
  userText: string,
  precedingAssistantText: string | null,
): DecisionHit[] {
  const hits: DecisionHit[] = [];
  const seenKeys = new Set<string>();
  const prefix = userText.slice(0, POSITIONAL_PREFIX_LEN);

  for (const lf of DECISION_LFS) {
    // alternative-block requires the prior assistant turn to look
    // like an options enumeration. Skip otherwise to keep recall
    // signal-aligned (concurrence keywords in isolation aren't
    // decisions).
    if (lf.inspects === 'pair' && !assistantHasOptions(precedingAssistantText)) {
      continue;
    }

    const haystack = lf.scope === 'prefix' ? prefix : userText;
    for (const pat of lf.patterns) {
      const m = haystack.match(pat);
      if (m === null) continue;
      const phrase = m[0].slice(0, PHRASE_MAX);
      const startOffset = m.index ?? 0;
      // Dedup by (kind, phrase) so two LFs of the same kind don't
      // double-fire on identical text. Same shape as the corrections
      // kernel.
      const key = `${lf.kind}:${phrase.toLowerCase()}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      hits.push({ lfName: lf.name, kind: lf.kind, phrase, startOffset });
    }
  }

  return hits;
}

/**
 * Scans an array of (user, assistant) turn pairs from a single
 * session and returns DecisionCandidates with classification
 * unattached. Emits one candidate per (turn, LF-kind) hit — a turn
 * matching both `explicit-marker` and `instead-of` produces two
 * candidates. Downstream rollup is the builder's job.
 */
export function detectDecisions(
  turns: ReadonlyArray<DecisionTurnPair>,
): DecisionCandidate[] {
  const out: DecisionCandidate[] = [];

  for (const t of turns) {
    const hits = scanTurn(t.userText, t.precedingAssistantText);
    if (hits.length === 0) continue;

    const surrounding = truncate(t.userText.trim(), CONTEXT_WINDOW);

    for (const h of hits) {
      out.push({
        id: makeDecisionId(t.sessionId, t.userTurnIndex, h.kind, h.phrase),
        sessionId: t.sessionId,
        userTurnIndex: t.userTurnIndex,
        kind: h.kind,
        span: {
          phrase: h.phrase,
          startOffset: h.startOffset,
        },
        surroundingContext: surrounding,
      });
    }
  }

  return out;
}

/**
 * Single-LF probe — runs ONE labeling function against a user-text
 * (and optional assistant-text) and returns its hits. Exposed so
 * tests + audit scripts can target individual LFs in isolation;
 * production code should use `detectDecisions` instead.
 */
export function runLabelingFunction(
  lf: DecisionLabelingFunction,
  userText: string,
  precedingAssistantText: string | null = null,
): ReadonlyArray<{ kind: DecisionKind; phrase: string; startOffset: number }> {
  if (lf.inspects === 'pair' && !assistantHasOptions(precedingAssistantText)) {
    return [];
  }
  const prefix = userText.slice(0, POSITIONAL_PREFIX_LEN);
  const haystack = lf.scope === 'prefix' ? prefix : userText;
  const hits: { kind: DecisionKind; phrase: string; startOffset: number }[] = [];
  const seen = new Set<string>();
  for (const pat of lf.patterns) {
    const m = haystack.match(pat);
    if (m === null) continue;
    const phrase = m[0].slice(0, PHRASE_MAX);
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: lf.kind, phrase, startOffset: m.index ?? 0 });
  }
  return hits;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function makeDecisionId(
  sessionId: string,
  turnIndex: number,
  kind: DecisionKind,
  phrase: string,
): string {
  const enc = new TextEncoder();
  const h = bytesToHex(
    sha256(enc.encode(`${sessionId}:${turnIndex}:${kind}:${phrase.toLowerCase()}`)),
  );
  return `dec_${h.slice(0, 12)}`;
}
