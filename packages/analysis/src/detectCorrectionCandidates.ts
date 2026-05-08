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
 */
export const HEURISTIC_RECALL_VERSION = 2;

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

const STOP_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(stop|quit|cease)\b\s+(adding|generating|writing|using|making|doing|including)\b/i,
  /\bplease\s+(stop|don'?t)\b/i,
];

/**
 * Negation directed at the assistant's behavior. The original whitelist
 * (add/generate/write/use/make/do/include/create/put) under-recalled —
 * the audit at scripts/audit-correction-recall.mjs found 150 non-firing
 * turns where `don't/never` was followed by verbs OUTSIDE that whitelist
 * (change, refactor, assume, bother, touch, mention, repeat, …) — many of
 * those are real corrections. Rather than enumerate every possible verb,
 * we now match `don't/never + any 2+ char word` and exclude a tiny set of
 * non-correction phrases (`don't worry`, `don't mind`, `don't think`, …)
 * that the LLM stage would otherwise have to spend tokens rejecting.
 */
const NEGATION_EXCLUSIONS = '(?:worry|mind|think|know|believe|wanna|want|see|forget|hesitate|tell|matter)';
const NEGATION_PATTERNS: ReadonlyArray<RegExp> = [
  // Targeted whitelist (kept for back-compat / explicit anchoring).
  /\b(don'?t|do not|never)\b\s+(add|generate|write|use|make|do|include|create|put)\b/i,
  /\bno+,?\s+(don'?t|not)\b/i,
  // Broadened negation: don't/never + any verb-like token, with a small
  // exclusion list for common non-corrective idioms.
  new RegExp(
    `\\b(don'?t|do not|never)\\b\\s+(?!${NEGATION_EXCLUSIONS}\\b)[a-z]{2,}\\b`,
    'i',
  ),
];

const INSTEAD_PATTERNS: ReadonlyArray<RegExp> = [
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bnot\b.+\bbut\b/i,
];

const IMPERATIVE_OVERRIDE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*(always|never|only|prefer|just|please)\b/i,
  /\b(use|prefer)\s+\w+\s+(not|over|instead of)\b/i,
];

const FRUSTRATION_PATTERNS: ReadonlyArray<RegExp> = [
  /!{2,}/,
  /\?{2,}/,
  /\b(NO|STOP|DON'?T)\b/, // caps-locked, not case-insensitive
  /\b(again|still)\b.*\b(told|said|asked)\b/i,
];

/**
 * Soft pivots. The user steers the assistant somewhere else without
 * outright negation. Audit found ~177 missed corrections shaped this
 * way (`actually,…`, `wait,…`, `let's …`). The `let's` arm intentionally
 * matches both directives (`let's regenerate`) and concessions (`let's
 * not include`); `let's not` falls under the negation pattern too, but
 * the duplicate phrase-key dedupe in scanTurn collapses overlap.
 */
const SOFT_REDIRECT_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*(actually|wait|hmm+|hold on|hang on|nope|nah)\b/i,
  /^\s*let'?s\s+\w+/i,
];

/**
 * First-person preference statements. Audit found 80 missed corrections
 * shaped as "I want X", "I'd prefer Y", "I would like Z". These are
 * weaker signals than explicit-no but the LLM stage still classifies
 * many as actionable corrections (the user IS expressing a behavioral
 * preference, just politely).
 */
const WANT_PREFER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bi\s+(want|need|prefer|wish)\b/i,
  /\bi'?d\s+(rather|prefer|like)\b/i,
  /\bi\s+would\s+(like|prefer|rather)\b/i,
];

interface HeuristicHit {
  kind: CorrectionSignalKind;
  phrase: string;
}

const POSITIONAL_PREFIX_LEN = 300;

function scanTurn(userText: string): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  const seenPhrases = new Set<string>();
  const prefix = userText.slice(0, POSITIONAL_PREFIX_LEN);

  const fire = (
    kind: CorrectionSignalKind,
    patterns: ReadonlyArray<RegExp>,
    scope: 'full' | 'prefix',
  ): void => {
    const haystack = scope === 'prefix' ? prefix : userText;
    for (const pat of patterns) {
      const m = haystack.match(pat);
      if (m !== null) {
        const phrase = m[0].slice(0, 80);
        const key = `${kind}:${phrase.toLowerCase()}`;
        if (!seenPhrases.has(key)) {
          seenPhrases.add(key);
          hits.push({ kind, phrase });
        }
      }
    }
  };

  fire('explicit-stop', STOP_PATTERNS, 'full');
  fire('explicit-no', NEGATION_PATTERNS, 'full');
  fire('instead-of', INSTEAD_PATTERNS, 'prefix');
  fire('imperative-override', IMPERATIVE_OVERRIDE_PATTERNS, 'full');
  fire('frustration', FRUSTRATION_PATTERNS, 'full');
  fire('soft-redirect', SOFT_REDIRECT_PATTERNS, 'prefix');
  fire('want-prefer', WANT_PREFER_PATTERNS, 'full');

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
    if (t.userTurnIndex > 0) {
      const grams = extractContentGrams(t.userText, 4);
      for (const g of grams) {
        const earlier = seenInstructionGrams.get(g);
        if (earlier !== undefined && earlier < t.userTurnIndex) {
          hits.push({ kind: 'repeat-instruction', phrase: g });
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

    out.push({
      id: makeCorrectionId(t.sessionId, t.userTurnIndex),
      sessionId: t.sessionId,
      userTurnIndex: t.userTurnIndex,
      excerpt: truncate(t.userText, 500),
      precedingAssistantExcerpt:
        t.precedingAssistantText === null ? null : truncate(t.precedingAssistantText, 500),
      signals,
      classification: null,
    });
  }

  return out;
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
