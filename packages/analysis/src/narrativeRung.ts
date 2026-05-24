/**
 * Narrative confidence-ladder kernel (Phase Rev3-B sub-tasks B6 + B7).
 *
 * Three pure helpers + their backing types:
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
