/**
 * Narrative confidence-ladder + saturation kernel (Phase Rev3-B sub-
 * tasks B6 + B7; Phase Rev3-D sub-tasks D1 + D2).
 *
 * Five pure helpers + their backing types:
 *
 *   - `computeConfidence(supporting, contradicting, prior)` — B6.
 *     The Bayesian Beta-posterior-mean form pinned by
 *     `THRESHOLDS.narrativeRung` (PR #58 joint-gate feasibility):
 *
 *         confidence = supporting / (supporting + contradicting + prior)
 *
 *   - `effectivePriorForKernel({ kernel, calibrationCompletedAt })` — B7.
 *     Selects the prior to feed `computeConfidence`:
 *       - `calibrationCompletedAt == null` → `uncalibratedPrior` (20 by
 *         default). Makes tier-3 unreachable so an uncalibrated kernel
 *         can never silently surface promotable narratives.
 *       - Otherwise → `priorByKernel[kernel] ?? defaultPrior` (the
 *         per-kernel calibrated prior if present, else the global
 *         default).
 *
 *   - `narrativeTier(confidence, supporting, contradicting)` — joint
 *     gate per `THRESHOLDS.narrativeRung`. Returns the highest tier
 *     (0–3) whose floor AND supporting-count AND contradicting-cap
 *     gates are all satisfied. Tier 0 = "not surface-able."
 *
 *   - `narrativeSaturation(dismissalCount)` — D1. Maps the
 *     `entity_states.dismissal_count` counter (Rev3-C C4) to the
 *     effective re-promotion growth multiplier + shelved flag. Each
 *     dismissal multiplies the base re-promotion bar by
 *     `THRESHOLDS.narrativeRung.dismissDecay`; once dismissals reach
 *     `maxDismissals` the entity is permanently shelved (visible only
 *     via the Rev3-D D4 "show shelved" affordance).
 *
 *   - `narrativePriorPenalty(dismissalCount)` — D2. Returns the
 *     additive prior bump a previously-dismissed Narrative pays on
 *     each re-test. Composes with `effectivePriorForKernel` —
 *     `totalPrior = basePrior + narrativePriorPenalty(dismissals)` —
 *     then feeds `computeConfidence`. Each dismissal is a re-test of
 *     the same hypothesis; the prior bump makes subsequent
 *     re-promotion face a stiffer Bayesian threshold (family-wise α
 *     correction, paired with D1's growth-multiplier escalation).
 *
 * Pure, browser-safe. The viewer + curator-feed + Closure-B/C wirings
 * all consume these directly.
 */

import { THRESHOLDS } from './thresholds.js';

/**
 * Bayesian Beta-posterior mean.
 *
 *   confidence = supporting / (supporting + contradicting + prior)
 *
 * `prior > 0` is required; pass the kernel's `effectivePriorForKernel`
 * result. Returns NaN for invalid inputs (negative counts, non-finite
 * prior) so callers can short-circuit rather than emit a bogus tier
 * decision. Clamps to [0, 1] when the denominator could legitimately
 * push the ratio outside the unit interval (shouldn't with non-negative
 * inputs, but the clamp keeps the contract explicit).
 */
export function computeConfidence(
  supporting: number,
  contradicting: number,
  prior: number,
): number {
  if (
    !Number.isFinite(supporting) ||
    !Number.isFinite(contradicting) ||
    !Number.isFinite(prior) ||
    supporting < 0 ||
    contradicting < 0 ||
    prior <= 0
  ) {
    return Number.NaN;
  }
  const denom = supporting + contradicting + prior;
  if (denom <= 0) return Number.NaN;
  const raw = supporting / denom;
  return Math.max(0, Math.min(1, raw));
}

export interface EffectivePriorOptions {
  /** Kernel name (e.g. `'kernel-alpha'`). Looked up in `priorByKernel`. */
  readonly kernel: string;
  /**
   * `analyzers.calibration_completed_at` (ms since epoch) — `null` /
   * `undefined` means "no calibration has completed for this kernel"
   * and the uncalibratedPrior fail-safe fires.
   */
  readonly calibrationCompletedAt: number | null | undefined;
}

/**
 * B7 calibration fail-safe. Selects the prior to feed
 * `computeConfidence` based on whether the kernel has been calibrated
 * and (optionally) whether it has a per-kernel override.
 *
 *   - `calibrationCompletedAt == null` → `narrativeRung.uncalibratedPrior`.
 *     The viewer should also surface a "kernel X uncalibrated — tier-3
 *     promotion disabled" banner alongside the affected narratives.
 *   - Otherwise → `priorByKernel[kernel]` if present, else
 *     `defaultPrior`.
 */
export function effectivePriorForKernel(
  options: EffectivePriorOptions,
): number {
  const { kernel, calibrationCompletedAt } = options;
  if (calibrationCompletedAt === null || calibrationCompletedAt === undefined) {
    return THRESHOLDS.narrativeRung.uncalibratedPrior;
  }
  const override = THRESHOLDS.narrativeRung.priorByKernel[kernel];
  if (typeof override === 'number' && override > 0) {
    return override;
  }
  return THRESHOLDS.narrativeRung.defaultPrior;
}

/**
 * Narrative tier per the joint gates in `THRESHOLDS.narrativeRung`.
 * Returns 0 when no tier is reachable.
 *
 * Tier-i gates:
 *   - `confidence >= tier_i` (Bayesian posterior floor)
 *   - `supporting >= tier_i_SupportingMin` (count floor)
 *   - For tier 3 only: `contradicting <= ceil(supporting /
 *     contradictingCapDivisor)` (joint feasibility per PR #58).
 *
 * The contradicting-cap is tier-3-only because tier-1 and tier-2 are
 * "candidate" and "established" — the user is already filtering out
 * counter-examples via the dismiss workflow at those rungs. Tier-3 is
 * action-eligible, so a higher bar applies.
 *
 * Use this helper at every surface that gates display on rung. NEVER
 * inline the threshold comparisons at callsites; this function is the
 * single point of truth.
 */
export function narrativeTier(
  confidence: number,
  supporting: number,
  contradicting: number,
): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return 0;
  }
  if (!Number.isFinite(supporting) || !Number.isFinite(contradicting)) {
    return 0;
  }
  if (supporting < 0 || contradicting < 0) {
    return 0;
  }
  const r = THRESHOLDS.narrativeRung;
  // Walk from highest tier downward; first joint-gate-satisfied tier wins.
  if (
    confidence >= r.tier3 &&
    supporting >= r.tier3SupportingMin &&
    contradicting <= Math.ceil(supporting / r.contradictingCapDivisor)
  ) {
    return 3;
  }
  if (confidence >= r.tier2 && supporting >= r.tier2SupportingMin) {
    return 2;
  }
  if (confidence >= r.tier1 && supporting >= r.tier1SupportingMin) {
    return 1;
  }
  return 0;
}

/**
 * D1 saturation result. The viewer and curator both consume this when
 * deciding (a) whether a DISMISSED entity is still re-promotable and
 * (b) what bar the current evidence size must clear to re-emerge.
 */
export interface NarrativeSaturation {
  /**
   * Effective re-promotion growth multiplier. The number the current
   * evidence count must clear, relative to the size-at-last-dismissal
   * snapshot persisted in `entity_states.size_at_state`. `null` when
   * `shelved` is true — the bar is infinite by policy.
   */
  readonly multiplier: number | null;
  /**
   * `true` once the entity has been dismissed `maxDismissals` times.
   * Shelved entities are visible only via the Rev3-D D4 "show shelved"
   * affordance — they no longer re-emerge from growth alone.
   */
  readonly shelved: boolean;
  /**
   * Dismissals consumed so far, clamped to `[0, maxDismissals]`. Lets
   * the audit table (D3) render "N/cap" without re-reading THRESHOLDS.
   */
  readonly dismissalsConsumed: number;
  /**
   * The cap pulled from THRESHOLDS. Same rationale as above — keeps
   * callers free of a second THRESHOLDS import for display purposes.
   */
  readonly cap: number;
}

/**
 * D1 saturation rule. Given the `dismissal_count` counter persisted by
 * the SQLite SDK (Rev3-C C4), return the effective re-promotion
 * growth multiplier the live evidence count must clear to bring the
 * entity back from DISMISSED.
 *
 * Formula (all values from THRESHOLDS):
 *
 *     multiplier = baseGrowth × (dismissDecay ^ dismissalCount)
 *
 * where `baseGrowth =
 * THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier`
 * (the same constant the C5 round-trip test exercises for the
 * `dismissalCount=0` baseline) and `dismissDecay =
 * THRESHOLDS.narrativeRung.dismissDecay`. The doubling is documented
 * in the THRESHOLDS comment block — each successive dismissal
 * compounds the bar so a persistently-rejected narrative isn't a
 * notifier nag.
 *
 * Edge cases:
 *
 *   - `dismissalCount` non-finite / negative → treated as 0
 *     (fresh-state baseline; never throws so the viewer's render path
 *     can't crash on a corrupt ledger row).
 *   - `dismissalCount >= maxDismissals` → `shelved: true`, `multiplier:
 *     null`. The viewer hides the entity from the active pile until
 *     the D4 "show shelved" toggle is on.
 *   - `dismissalCount` between (maxDismissals - 1, maxDismissals)
 *     (fractional via persisted JSON) is `floor`'d before comparison,
 *     so 2.9 dismissals counts as 2 (not yet shelved).
 *
 * The function is the single point of truth for re-promotion bar
 * computation; UI callers MUST NOT inline `Math.pow(decay, count)`.
 */
export function narrativeSaturation(
  dismissalCount: number,
): NarrativeSaturation {
  const r = THRESHOLDS.narrativeRung;
  const base = THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;
  const safeCount =
    !Number.isFinite(dismissalCount) || dismissalCount < 0
      ? 0
      : Math.floor(dismissalCount);
  const consumed = Math.min(safeCount, r.maxDismissals);
  if (consumed >= r.maxDismissals) {
    return {
      multiplier: null,
      shelved: true,
      dismissalsConsumed: consumed,
      cap: r.maxDismissals,
    };
  }
  return {
    multiplier: base * Math.pow(r.dismissDecay, consumed),
    shelved: false,
    dismissalsConsumed: consumed,
    cap: r.maxDismissals,
  };
}

/**
 * D2 family-wise correction. Each user dismissal raises the per-
 * Narrative prior by `THRESHOLDS.narrativeRung.repromotionPenalty`,
 * which makes the next re-test face a stiffer Bayesian threshold.
 * Re-promotion is a re-test of the same hypothesis; stiffening the
 * prior is the Bayesian sequential-evidence counterpart to a
 * frequentist FWER adjustment (Bonferroni / Holm). The two are not
 * formally equivalent — Bonferroni adjusts a Type-I error rate per
 * test, the prior bump shifts a posterior threshold — but both
 * achieve the same intent: a persistently re-emerging narrative
 * faces a higher bar each time. D5 (methodology disclosure) states
 * the formal-equivalence caveat verbatim.
 *
 * Composes additively with `effectivePriorForKernel`:
 *
 *     totalPrior = effectivePriorForKernel(opts)
 *                + narrativePriorPenalty(dismissalCount)
 *
 * The composition is intentionally explicit (not a single combined
 * helper) so a caller that wants only one of the two pieces — e.g. a
 * cluster-side re-emergence rule that runs without the family-wise
 * penalty, or a calibration audit that wants the unpenalized prior —
 * can opt out without forking the kernel surface.
 *
 * Pairs with `narrativeSaturation` (D1, the multiplier-side
 * escalation). D1 gates growth-side re-emergence; D2 gates
 * confidence-side ranking — both feed off the same
 * `entity_states.dismissal_count` counter.
 *
 * Defensive contract (mirrors `narrativeSaturation`):
 *
 *   - `dismissalCount` non-finite / negative → returns 0 (no penalty).
 *     A corrupt ledger row cannot inflate the prior to NaN/Infinity
 *     and silently zero a tier-3 narrative's confidence.
 *   - Fractional inputs are `Math.floor`'d before multiplication.
 *   - Once `dismissalCount >= maxDismissals` the Narrative is shelved
 *     (see `narrativeSaturation`); this function still returns a
 *     defined penalty for the audit table's "if it un-shelved, what
 *     would the prior be?" rendering. Callers that gate on shelving
 *     should consult `narrativeSaturation` first.
 *   - When the kernel is uncalibrated (`calibrationCompletedAt ==
 *     null`), `effectivePriorForKernel` already returns
 *     `uncalibratedPrior` (default 20) which is tier-3-unreachable
 *     by design. The penalty stacks on top mathematically, but the
 *     fail-safe dominates — the penalty does no additional work in
 *     that regime. Visible behavior in calibrated kernels only.
 */
export function narrativePriorPenalty(dismissalCount: number): number {
  if (!Number.isFinite(dismissalCount) || dismissalCount <= 0) {
    return 0;
  }
  const consumed = Math.floor(dismissalCount);
  return consumed * THRESHOLDS.narrativeRung.repromotionPenalty;
}
