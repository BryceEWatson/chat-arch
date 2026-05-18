/**
 * Stage 1 of the methods-playbook pipeline: heuristic recall over user
 * turns, looking for **recurring prompt phrasings** the user invokes
 * mid-session to steer the AI in a useful direction.
 *
 * Pure. No I/O, no LLM. Deterministic given identical input.
 *
 * The positive analog to {@link detectCorrectionCandidates}: corrections
 * look for user pushback (negation, frustration, repeat-instruction) that
 * precedes a behavior fix; playbook hits look for prescriptive verbs
 * ("first principles", "adversarial review", "step back", "verify
 * before you change") that precede verified outcomes. The audit join —
 * which turns occurrence counts into downstream pass-rate — lives in
 * the exporter's builder layer because it requires reading
 * `audit-results.json` from disk. Keep this kernel pure so the browser
 * tier can run the same detection over an uploaded ZIP if we ever want
 * to.
 *
 * Adversarial-validation note: the pattern set admits some noise. For
 * example `\balternatives?\b` fires on "what are the alternatives?"
 * (legitimate method) AND on "the alternatives mentioned earlier"
 * (a reference, not a directive). The downstream-audit join is the
 * filter — patterns that don't correlate with pass-verdicts surface
 * with a 0% pass-rate score and rank below the real methods. Do not
 * narrow patterns here to suppress the noise — that erodes recall.
 */

import type { ScanStats } from '@chat-arch/schema';

/**
 * Bumped whenever the heuristic ruleset changes (new pattern family,
 * broadened regex, label change). The exporter's playbook builder uses
 * this as a cache key — a mismatch forces a full re-scan.
 *
 * History:
 *   1 — initial release (9 pattern families: first-principles,
 *       adversarial-review, step-back, deep-think, verify-validate,
 *       plan-first, subagent-fanout, what-am-i-missing, tradeoffs)
 */
export const PLAYBOOK_HEURISTIC_VERSION = 1;

/** Same shape as {@link TurnPair} but carries `lineNumber` for the audit join. */
export interface PlaybookTurnInput {
  sessionId: string;
  /** 0-based index into the session's user turns. */
  userTurnIndex: number;
  /** 1-based line number of the user turn inside the transcript. */
  lineNumber: number;
  userText: string;
}

interface PatternFamily {
  key: string;
  label: string;
  description: string;
  patterns: ReadonlyArray<RegExp>;
}

/**
 * The pattern catalogue. Adding a family: append here AND bump
 * {@link PLAYBOOK_HEURISTIC_VERSION}. The keys are stable and end up in
 * the on-disk sidecar; do not rename.
 */
const PATTERN_FAMILIES: ReadonlyArray<PatternFamily> = [
  {
    key: 'first-principles',
    label: 'First principles',
    description:
      'Reset the framing — ignore prior conclusions and rederive from scratch.',
    patterns: [
      /\b(?:go back to |from |starting from |using )?first[\s-]principles?\b/i,
    ],
  },
  {
    key: 'adversarial-review',
    label: 'Adversarial review',
    description:
      'Spin up critics whose job is to break the current plan or output.',
    patterns: [
      /\badversarial\s+(?:review(?:er)?s?|red.?team(?:ers?)?|critics?|agents?|experiments?|tests?)\b/i,
    ],
  },
  {
    key: 'step-back',
    label: 'Step back',
    description:
      'Pause execution and re-examine the shape of the problem before the next move.',
    patterns: [
      /\b(?:step|stepping|take\s+a\s+step|let'?s\s+step)\s+back\b/i,
      /\bzoom\s+out\b/i,
    ],
  },
  {
    key: 'deep-think',
    label: 'Think deeply / harder',
    description:
      'Explicitly request more reasoning effort before producing the next answer.',
    patterns: [
      /\b(?:think|reason)\s+(?:deeply|harder|carefully|more|step.by.step)\b/i,
      /\bultrathink\b/i,
    ],
  },
  {
    key: 'verify-validate',
    label: 'Verify / sanity-check',
    description:
      'Force a verification pass — re-read, re-run, double-check — before declaring done.',
    patterns: [
      /\b(?:double|triple)[\s-]?check\b/i,
      /\bsanity[\s-]?check\b/i,
      /\bverify\s+(?:that|the|this|before|first)\b/i,
    ],
  },
  {
    key: 'plan-first',
    label: 'Plan before implementing',
    description:
      'Demand an explicit plan or sketch before any edits land.',
    patterns: [
      /\b(?:plan|design|sketch|outline)\s+(?:first|it out|the approach|before)\b/i,
      /\bbefore\s+(?:you|implementing|coding|writing)\b.*\b(?:plan|design)\b/i,
    ],
  },
  {
    key: 'subagent-fanout',
    label: 'Sub-agent fan-out',
    description:
      'Parallelise the work across sub-agents instead of one monolithic pass.',
    patterns: [
      /\bin\s+parallel\b/i,
      /\bsub.?agents?\b/i,
      /\bfan.?out\b/i,
      /\bspawn\s+(?:an?\s+)?(?:agent|sub.?agent)\b/i,
      /\b(?:use|launch)\s+(?:the\s+)?(?:plan|explore|general-purpose)\s+agent\b/i,
    ],
  },
  {
    key: 'what-am-i-missing',
    label: 'What am I missing?',
    description:
      'Ask the AI to enumerate gaps and blind spots in the current approach.',
    patterns: [
      /\bwhat\s+(?:am\s+i|are\s+we|did\s+(?:we|i))\s+miss(?:ing)?\b/i,
      /\bblind\s+spots?\b/i,
      /\bgaps?\s+in\s+(?:my|the|this|our)\b/i,
    ],
  },
  {
    key: 'tradeoffs',
    label: 'Trade-offs / alternatives',
    description:
      'Force a comparison — surface options and their costs before committing.',
    patterns: [
      /\btrade[\s-]?offs?\b/i,
      /\bpros\s+and\s+cons\b/i,
      /\balternative\s+(?:approaches?|options?|solutions?|ways?)\b/i,
      /\bwhat\s+are\s+the\s+alternatives?\b/i,
    ],
  },
];

/**
 * Lookup of canonical pattern metadata. The builder uses this to fill
 * `label` and `description` on every emitted pattern row, so consumers
 * (the playbook page) don't have to maintain a parallel catalogue.
 */
export const PLAYBOOK_PATTERN_META: ReadonlyMap<
  string,
  { label: string; description: string }
> = new Map(
  PATTERN_FAMILIES.map((f) => [
    f.key,
    { label: f.label, description: f.description },
  ]),
);

export interface PlaybookKernelHit {
  sessionId: string;
  userTurnIndex: number;
  lineNumber: number;
  patternKey: string;
  /** Verbatim matched phrase, truncated to 80 chars. */
  phrase: string;
  /** ≤500 chars of the surrounding user text (trimmed). */
  excerpt: string;
}

/** Minimum trimmed-text length to consider — guards against single-token noise. */
const MIN_USER_TEXT_LEN = 10;
const EXCERPT_MAX = 500;
const PHRASE_MAX = 80;

/**
 * Scan a single user turn against every pattern family. Returns one
 * hit per (family, distinct match) — a turn that contains both
 * "first principles" and "adversarial review" produces two hits.
 *
 * Same-key duplicate suppression: if a single family's patterns both
 * match (rare — most families have one regex), only the first hit is
 * emitted. This mirrors the corrections kernel's per-kind dedupe.
 */
function scanTurn(text: string): Array<{ patternKey: string; phrase: string }> {
  const out: Array<{ patternKey: string; phrase: string }> = [];
  for (const family of PATTERN_FAMILIES) {
    for (const pat of family.patterns) {
      const m = text.match(pat);
      if (m !== null) {
        out.push({
          patternKey: family.key,
          phrase: m[0].slice(0, PHRASE_MAX),
        });
        break; // one hit per family per turn
      }
    }
  }
  return out;
}

/**
 * Scan an array of user-turn inputs (one per session, in order) and
 * return playbook hits. Per-turn filters: trimmed text must be at
 * least {@link MIN_USER_TEXT_LEN} chars. Wrapper-prefix turns and
 * 4000+ char pastes are expected to have been dropped upstream
 * by the transcript parser (same as the corrections pipeline) — this
 * kernel does NOT re-filter for them.
 */
export function detectPlaybookCandidates(
  turns: ReadonlyArray<PlaybookTurnInput>,
): PlaybookKernelHit[] {
  const out: PlaybookKernelHit[] = [];
  for (const t of turns) {
    const trimmed = t.userText.trim();
    if (trimmed.length < MIN_USER_TEXT_LEN) continue;
    const hits = scanTurn(trimmed);
    if (hits.length === 0) continue;
    const excerpt = truncate(trimmed, EXCERPT_MAX);
    for (const h of hits) {
      out.push({
        sessionId: t.sessionId,
        userTurnIndex: t.userTurnIndex,
        lineNumber: t.lineNumber,
        patternKey: h.patternKey,
        phrase: h.phrase,
        excerpt,
      });
    }
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Re-exported for builder convenience — same shape we already produce. */
export type { ScanStats };
