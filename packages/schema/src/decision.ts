/**
 * Decision extraction — phase 2 of the outcome-substrate roadmap (#1).
 *
 * Pipeline: heuristic recall pre-filter (kernel input) → LLM
 * classification (kind, choices, distilled rationale) → outcome join
 * (decision linked to the composite outcome record on the same
 * session). The kernel here is the recall layer only — admits noise,
 * relies on downstream LLM filtering for precision (same shape as
 * the corrections pipeline).
 *
 * Persistence: `analysis/decisions.json`, sibling of `corrections.json`.
 * No session-level foreign key on `UnifiedSessionEntry` — decisions
 * point at sessions, not the reverse (most sessions contain zero).
 */

/**
 * The kind of decision recognized by the kernel's labeling functions.
 * Multiple LFs MAY emit the same kind (e.g. two LFs both labeled
 * 'explicit-go-with') — the `name` in the labeling-function registry
 * is the diagnostic-level identifier; this is the downstream label
 * stored on the candidate.
 */
export type DecisionKind =
  /** "decision:", "we've decided" — author flagged it. */
  | 'explicit-marker'
  /** "let's go with X", "I'll use X", "we'll pick X". */
  | 'explicit-go-with'
  /** "X instead of Y", "X rather than Y". */
  | 'instead-of'
  /** User concurs with a numbered alternative the assistant proposed. */
  | 'alternative-block'
  /** "use X", "pick X", "choose X" at the start of a user turn. */
  | 'imperative-choice';

/**
 * The span of text in the user turn that triggered the labeling
 * function. Verbatim — preserved so the audit script can show the
 * human the exact phrase that fired.
 */
export interface DecisionSpan {
  /** Verbatim matched phrase, truncated to 80 chars. */
  phrase: string;
  /** 0-based character offset of the match within the user turn text. */
  startOffset: number;
}

/**
 * Single detected decision candidate. Same shape as `Correction`
 * minus the `signals` array — the kernel emits one candidate per
 * (turn, LF) hit rather than rolling them up. Downstream stages
 * cluster by `sessionId + userTurnIndex` if they want a per-turn
 * roll-up.
 */
export interface DecisionCandidate {
  id: string;
  sessionId: string;
  /** 0-based index into the session's user turns. */
  userTurnIndex: number;
  /** LF kind that fired. */
  kind: DecisionKind;
  /** Match metadata. */
  span: DecisionSpan;
  /**
   * ≤500-char window of user text surrounding the match. Used by the
   * LLM classification stage and the audit script for hand-labeling.
   */
  surroundingContext: string;
}

/**
 * Reference to the outcome record that the decision is joined to.
 * Populated by the builder's outcome-join step (Phase 2 builder
 * `decisions.ts`). Null until that pass runs — same convention as
 * `Correction.classification`.
 */
export interface DecisionOutcomeRef {
  /** Stable session id of the composite outcome record. */
  sessionId: string;
  /**
   * 0..1 composite score from `composite.primary.score`. Stored
   * denormalized so the viewer doesn't have to re-join.
   */
  compositeScore: number;
  /**
   * `'good' | 'bad' | 'neutral'` per the composite's
   * `binaryThresholdGood`. Stored denormalized so the viewer can
   * bucket decisions by outcome without a second pass.
   */
  binaryClass: 'good' | 'bad' | 'neutral';
}

/**
 * LLM-classification output for a decision. Null until the
 * precision pass has run; consumers MUST treat `classification === null`
 * as "candidate, not fact".
 */
export interface DecisionClassification {
  /**
   * Normalized kind. May differ from `DecisionCandidate.kind` if the
   * LLM disagrees with the heuristic — e.g. an `imperative-choice`
   * hit that the LLM reclassifies as a `tool-pivot` after reading
   * context.
   */
  kind: DecisionKind | 'tool-pivot' | 'scope-cut' | 'other';
  /**
   * Canonical decision statement, imperative voice. Used for
   * clustering across sessions. Example: "use ripgrep instead of
   * grep" or "drop the staging server, deploy direct".
   */
  distilledDecision: string;
  /**
   * The option(s) the user chose. ≥1 entry.
   */
  chosen: readonly string[];
  /**
   * The option(s) the user rejected. May be empty if the decision
   * wasn't a pick-between (e.g. an `explicit-marker` "decision: ship
   * it" with no enumerated alternatives).
   */
  rejected: readonly string[];
  /** 0..1, classifier-reported. */
  confidence: number;
  /**
   * Whether the LLM judged this a genuine decision (vs. an aside, a
   * factual statement, or a re-statement of an earlier decision).
   * Only `actionable: true` decisions are joined to outcomes.
   */
  actionable: boolean;
}

/**
 * Decision + classification + outcome-join. The on-disk form. A
 * candidate becomes a `Decision` once it's been classified; the
 * outcome ref attaches in a later builder pass.
 */
export interface Decision {
  /** Underlying candidate emitted by the kernel. */
  candidate: DecisionCandidate;
  /** LLM-classification output. Null until the precision pass runs. */
  classification: DecisionClassification | null;
  /** Outcome join. Null until the builder's join pass runs. */
  outcomeRef: DecisionOutcomeRef | null;
}

/**
 * The persisted file shape under `analysis/decisions.json`. The
 * builder writes this; the viewer reads it. Schema mirrors
 * `CorrectionsFile` so both pipelines share a viewer-side reader.
 */
export interface DecisionsFile {
  generatedAt: number;
  /**
   * Cache key for the incremental rescan. When this changes (we add
   * an LF family, broaden a regex), the exporter's cache invalidates
   * and every session is re-scanned. Optional for back-compat with
   * files written before the version field existed.
   */
  decisionHeuristicVersion: number;
  decisions: readonly Decision[];
  /**
   * Session ids the most recent heuristic-recall pass actually
   * scanned (regardless of whether it produced any candidates).
   * Required to distinguish "unchanged session, zero candidates"
   * (cache hit) from "newly added session" (scan needed).
   */
  scannedSessionIds: readonly string[];
}
