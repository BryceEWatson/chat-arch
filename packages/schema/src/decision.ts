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
  /**
   * ≤500-char excerpt of the assistant turn immediately preceding this
   * user turn, harness-envelope-stripped. `null` when this is the first
   * user turn (no prior assistant text). The classifier reads it to
   * judge whether the user TOOK the assistant's recommendation
   * (accept) or went a different way (override) — the
   * `acceptedAssistant` axis of the trust-calibration 2×2. Older
   * `decisions.json` files written before this field may omit it; the
   * builder treats a missing value as `null`.
   */
  precedingAssistantExcerpt: string | null;
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
  /**
   * Short prose (≤200 chars) on WHY the user made this choice, in the
   * user's framing — surfaced in the UI so the decision reads as a
   * narrative ("chose X because Y"), not just a labeled span. Empty
   * string when the rationale isn't evident from the surrounding
   * context.
   */
  rationale: string;
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
 * Trust-calibration cell for the 2×2 mis-calibration view (Stream J
 * #10). Records whether the user accepted or overrode Claude on this
 * decision, and whether the outcome subsequently "landed" (binaryClass
 * === 'good') so the viewer can bucket per cell. Null when neither
 * the acceptance nor the outcome could be determined (e.g. unclassified
 * decision, or no composite outcome joined).
 */
export interface DecisionTrustCalibration {
  /** True when the user took the assistant's recommendation. */
  acceptedAssistant: boolean;
  /** True when the outcome bucket downstream of the decision was 'good'. */
  landed: boolean;
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
  /**
   * Trust-calibration cell. Optional — older `decisions.json` files
   * predate this field, in which case the viewer falls back to
   * deriving accept/override from `classification` + `outcomeRef`
   * where possible.
   */
  trustCalibration?: DecisionTrustCalibration | null;
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

/**
 * A cluster of recurring decisions — the same kind of choice made
 * across multiple sessions, grouped by semantic similarity of the
 * `classification.distilledDecision` text. Produced by the
 * `/mine-decisions` skill's clustering stage (Ollama embeddings +
 * the shared analysis clustering kernel), NOT the exporter. Lets the
 * viewer surface "you keep making this call" patterns the way the
 * corrections pipeline surfaces recurring correction patterns.
 */
export interface DecisionPattern {
  /** Stable hash-derived id (`dpat_<12 hex>` from the canonical text). */
  id: string;
  /**
   * Cluster-representative decision statement, imperative voice. The
   * alphabetically-first member `distilledDecision` (deterministic and
   * stable across runs — the clusterer has no per-member confidence to
   * rank a medoid by).
   */
  canonicalDecision: string;
  /**
   * Member decision ids — `DecisionCandidate.id` values of every
   * decision in this cluster. ≥2 (a cluster of one isn't recurring).
   */
  instanceIds: readonly string[];
  /** Distinct sessions the members span. */
  occurrenceCount: number;
  /**
   * Earliest / latest member session `updatedAt` (ms) when the clusterer
   * was given per-member timestamps; `0` otherwise (the skill supplies
   * them from the manifest — older runs that didn't fall back to `0`).
   */
  firstSeen: number;
  lastSeen: number;
  /**
   * Share of members whose joined outcome was 'good', over members
   * with a non-neutral joined outcome. `null` when too few members
   * have a joined outcome to be informative (mirrors the per-kind
   * landed-rate display floor). Aggregate, not per-session.
   */
  landedRate: number | null;
  /**
   * The denominator behind `landedRate` — count of members with a
   * non-neutral joined outcome. Surfaced next to the rate so the reader
   * can judge its precision (a rate over few samples is wide). 0 when no
   * member has a joined outcome.
   */
  landedDenom: number;
}

/**
 * The persisted file shape under `analysis/decision-clusters.json`.
 * Skill-only writer (the exporter never touches it), so it survives
 * the exporter's full rewrite of `decisions.json`. The viewer reads
 * it to render the "recurring decisions" section.
 */
export interface DecisionClustersFile {
  generatedAt: number;
  clusters: readonly DecisionPattern[];
  /**
   * True when the clusterer ran but could NOT cluster because the
   * embedding backend (Ollama) was unreachable. Clustering is an
   * optional enhancement, so this is a soft, *visible* skip rather than
   * a silent no-op: the file is still written (with `clusters: []`) so
   * the viewer can disclose "clustering skipped — Ollama unavailable"
   * instead of showing nothing (indistinguishable from "no recurring
   * decisions"). Absent on a normal run. See issue #122.
   */
  skipped?: boolean;
  /** Machine-readable reason for the skip. Currently the only reason. */
  skipReason?: 'embeddings-unavailable';
}
