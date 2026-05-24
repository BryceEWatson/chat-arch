// Phase Rev3-F F3 — curator ranker kernel.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §"Phase
// Rev3-F" + §"Outcome-correlation rendering":
//
//   "Curator ranks tier-2 + tier-3 Narratives, outcome-correlation
//    as tie-breaker only" (F3 sub-task).
//   "Outcome-correlation tag visibility gated on |Δ|/SE exceeding
//    `curator.outcomeCorrelationSignificance` AND
//    `evidence.length ≥ outcomeCorrelationEvidenceMinLength`"
//    (Rev3-G G2 — the tag gate; F3 honors it as a tie-breaker gate).
//
// This module owns the pure decision: given a set of candidate
// surfacings (narratives, knowledge-debt clusters, applied
// patterns), return the top-K ordered by the plan-specified
// composite score. Orchestration (reading from the SDK, calling the
// falsifier, writing the feed) is /curate's job.

import { THRESHOLDS } from './thresholds.js';

/**
 * Candidate-source kinds the curator ranks across. The set is fixed
 * by the plan's PRACTICE surface — narrative cards, knowledge-debt
 * clusters, applied-pattern watcher findings.
 */
export type CuratorCandidateKind =
  | 'narrative'
  | 'knowledge-debt'
  | 'applied-pattern';

/**
 * The four scoring axes the plan locks in. Each is in `[0, 1]` so
 * the composite is well-bounded; callers can pre-normalize their
 * inputs.
 */
export interface CuratorCandidate {
  readonly kind: CuratorCandidateKind;
  readonly entityId: string;
  /**
   * 1 for tier-3 (promotable), 0.5 for tier-2 (established), 0 for
   * tier-1 (candidate — filtered out before ranking, but tolerated
   * if it slips through so the kernel doesn't crash).
   *
   * Cross-tier promotion is NEVER allowed via correlation. The
   * ranker enforces this by sorting tier-buckets before applying
   * the within-tier composite — see `rankCuratorCandidates`.
   */
  readonly tierScore: number;
  /** From `computeConfidence(supporting, contradicting, prior)`. */
  readonly confidence: number;
  /**
   * Recency in `[0, 1]`. 1 = "happened just now"; 0 = "long ago".
   * The kernel doesn't define the decay function — callers feed
   * pre-computed values (e.g. `exp(-ageDays / halfLife)`).
   */
  readonly recencyScore: number;
  /**
   * Outcome-correlation tie-breaker in `[0, 1]`. Higher = stronger
   * effect-size relative to baseline. ZERO when the candidate's
   * `|Δ|/SE < outcomeCorrelationSignificance` OR its evidence
   * length is below `outcomeCorrelationEvidenceMinLength` — the
   * caller is responsible for that gate (matches G2's tag-
   * visibility rule). The ranker uses this value only to break
   * ties within a tier.
   */
  readonly correlationScore: number;
  /**
   * Surfaced display title. Carried through to the feed so the
   * downstream writer doesn't have to re-join against the source
   * tables.
   */
  readonly title: string;
}

export interface RankedCuratorCandidate extends CuratorCandidate {
  /** 1-indexed rank in the top-K output. */
  readonly rank: number;
  /** Within-tier composite (excludes the cross-tier sort key). */
  readonly compositeScore: number;
}

/**
 * Within-tier composite: weighted average of confidence + recency.
 * Correlation is NOT in the composite — it's the tie-breaker
 * applied after this sort.
 *
 * Weights pinned at 0.6 / 0.4 (confidence > recency) so a slightly
 * stale but well-supported narrative beats a brand-new low-
 * confidence one. The exact ratio is a pre-launch placeholder; the
 * F8 meta-validation rolling window provides the empirical signal
 * for re-tuning.
 */
function withinTierComposite(c: CuratorCandidate): number {
  return 0.6 * c.confidence + 0.4 * c.recencyScore;
}

export interface RankerOptions {
  /** Cap on the number of items returned. Default 10. */
  readonly topK?: number;
}

/**
 * Pure decision: rank an array of candidates by tier-bucket first
 * (tier-3 wins over tier-2 unconditionally — no cross-tier
 * promotion via correlation, per plan), then by within-tier
 * composite, then by correlation as a tie-breaker.
 *
 * Defensive contract:
 *   - Non-finite scores treated as 0 (don't crash on a corrupt row).
 *   - tier-1 candidates (tierScore < 0.5) are kept but always rank
 *     below tier-2; they shouldn't be in the input but we don't
 *     drop them silently.
 *   - Stable sort: when every score ties exactly, original order is
 *     preserved (lets the caller pre-sort by id for determinism).
 */
export function rankCuratorCandidates(
  candidates: readonly CuratorCandidate[],
  options: RankerOptions = {},
): readonly RankedCuratorCandidate[] {
  const topK = options.topK ?? THRESHOLDS.curator.precisionAtKWindow;
  const safe = candidates.map((c) => sanitize(c));

  // Stable sort: Array.prototype.sort is stable in V8 (and per
  // ES2019 spec). Tag indices to preserve original order on full
  // ties.
  const indexed = safe.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    // Cross-tier: tier-3 > tier-2 > tier-1. No correlation override.
    const tierDelta = b.c.tierScore - a.c.tierScore;
    if (tierDelta !== 0) return tierDelta;
    // Within-tier composite.
    const compositeDelta = withinTierComposite(b.c) - withinTierComposite(a.c);
    if (compositeDelta !== 0) return compositeDelta;
    // Correlation as tie-breaker (within-tier only — guaranteed by
    // the tierDelta short-circuit above).
    const correlationDelta = b.c.correlationScore - a.c.correlationScore;
    if (correlationDelta !== 0) return correlationDelta;
    // Stable on full ties.
    return a.i - b.i;
  });

  const result: RankedCuratorCandidate[] = [];
  for (let rank = 0; rank < Math.min(topK, indexed.length); rank++) {
    const { c } = indexed[rank]!;
    result.push({
      ...c,
      rank: rank + 1,
      compositeScore: withinTierComposite(c),
    });
  }
  return result;
}

function sanitize(c: CuratorCandidate): CuratorCandidate {
  return {
    ...c,
    tierScore: clampUnit(c.tierScore),
    confidence: clampUnit(c.confidence),
    recencyScore: clampUnit(c.recencyScore),
    correlationScore: clampUnit(c.correlationScore),
  };
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
