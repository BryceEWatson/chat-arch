// Phase Rev3-G G1 — Welch's t-test for two-sample mean difference
// with unequal variances.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §
// "Outcome-correlation rendering":
//
//   "Welch's t-test (or non-parametric permutation) implementation
//    in `packages/analysis/src/`. Outcome-correlation tag
//    visibility gated on `|Δ|/SE` exceeding
//    `curator.outcomeCorrelationSignificance` AND
//    `evidence.length ≥ 5`."
//
// The kernel here computes the t-statistic, degrees of freedom
// (Welch–Satterthwaite), and the two-sided p-value approximation.
// `correlationTagGate.ts` (G2) wraps this and applies the
// THRESHOLDS-resident visibility rule.
//
// Why Welch over Student's t: cited vs uncited samples in the
// outcome-correlation use case very likely have unequal variances
// (small cited sample with high effect size vs large uncited
// sample with lower variance). Pooled-variance Student's t
// over-rejects when variances diverge; Welch's correction is the
// conservative default.

import { normalCdf } from './stats.js';

/**
 * Result of running Welch's t against two samples. `t` is the
 * raw t-statistic; `degreesOfFreedom` is the Welch–Satterthwaite
 * approximation; `pValueTwoSided` is the two-sided p-value
 * approximated via the normal CDF (acceptable for `df ≥ 30`; below
 * that the normal under-reports tail mass — the gate uses |t| not
 * p, so visibility is unaffected, but consumers rendering `p`
 * directly should treat it as conservative at small df).
 */
export interface WelchResult {
  readonly t: number;
  readonly delta: number;
  readonly standardError: number;
  readonly degreesOfFreedom: number;
  readonly pValueTwoSided: number;
  /**
   * `true` when the test was computable. Three branches return
   * `valid: false`:
   *   - either sample n < 2
   *   - any input is NaN / non-finite
   *   - both variances zero AND means equal (degenerate)
   * In all three the result carries `t: 0, pValueTwoSided: 1`.
   *
   * Two branches return `valid: true` with an extreme t:
   *   - both variances zero, means differ → `t: MAX_SAFE_INTEGER,
   *     pValueTwoSided: 0` (clamped Infinity so JSON survives).
   *
   * The kernel does NOT throw on degenerate inputs; it reports
   * "no signal" via `valid: false`.
   */
  readonly valid: boolean;
}

/**
 * Compute sample mean + (Bessel-corrected) variance. Returns
 * `{mean: 0, variance: 0}` for empty / single-element samples.
 */
function meanAndVariance(
  sample: readonly number[],
): { readonly mean: number; readonly variance: number } {
  const n = sample.length;
  if (n === 0) return { mean: 0, variance: 0 };
  let sum = 0;
  for (const x of sample) sum += x;
  const mean = sum / n;
  if (n < 2) return { mean, variance: 0 };
  let sqDev = 0;
  for (const x of sample) {
    const d = x - mean;
    sqDev += d * d;
  }
  return { mean, variance: sqDev / (n - 1) };
}

/**
 * Two-sided p-value via the normal CDF approximation. For Welch's
 * t with df ≥ 30 the normal is within ~0.005 of the exact
 * t-distribution at α=0.05 — fine for the curator tag's
 * significance gate (which uses z=1.96 by convention). For df < 30
 * the approximation under-reports tail mass slightly; we accept the
 * conservative bias.
 *
 * Uses the existing `erfApprox` helper from stats.ts.
 */
function normalCdfTwoSidedTail(z: number): number {
  // p = 2 * (1 - Φ(|z|)). Reuses stats.normalCdf (Abramowitz &
  // Stegun 7.1.26 — accurate to ~1.5e-7).
  const absZ = Math.abs(z);
  return 2 * (1 - normalCdf(absZ));
}

/**
 * Welch's two-sample t-test. Returns the t-statistic, Δ (mean1 -
 * mean2), standard error of the difference, Welch–Satterthwaite df,
 * and the two-sided p-value approximation.
 *
 * Defensive contract:
 *   - Either sample with n < 2 → `{valid: false, t: 0,
 *     pValueTwoSided: 1}`.
 *   - Both variances zero (constant samples) AND means equal →
 *     `{valid: false, t: 0, pValueTwoSided: 1}`.
 *   - Both variances zero but means differ → `{valid: true, t: Inf,
 *     pValueTwoSided: 0}` clamped to `t: Number.MAX_SAFE_INTEGER`
 *     so JSON serialization survives.
 *
 * No throws. Designed to slot into the outcome-correlation gate
 * where corrupt or sparse data shouldn't crash the kernel.
 */
export function welchsTTest(
  sample1: readonly number[],
  sample2: readonly number[],
): WelchResult {
  if (sample1.length < 2 || sample2.length < 2) {
    return {
      t: 0,
      delta: 0,
      standardError: 0,
      degreesOfFreedom: 0,
      pValueTwoSided: 1,
      valid: false,
    };
  }
  // NaN / non-finite guard (stat-rigor iter-1 finding on PR #89).
  // Without this, a NaN propagates through variance → mean → t,
  // and `NaN < significanceThreshold` is `false` in the gate, so
  // the bad row would render as visible. Clamp to valid:false here
  // so the gate's `invalid-stat` branch fires correctly.
  for (const x of sample1) {
    if (!Number.isFinite(x)) {
      return {
        t: 0,
        delta: 0,
        standardError: 0,
        degreesOfFreedom: 0,
        pValueTwoSided: 1,
        valid: false,
      };
    }
  }
  for (const x of sample2) {
    if (!Number.isFinite(x)) {
      return {
        t: 0,
        delta: 0,
        standardError: 0,
        degreesOfFreedom: 0,
        pValueTwoSided: 1,
        valid: false,
      };
    }
  }
  const a = meanAndVariance(sample1);
  const b = meanAndVariance(sample2);
  const delta = a.mean - b.mean;
  const n1 = sample1.length;
  const n2 = sample2.length;
  const seSquared = a.variance / n1 + b.variance / n2;
  if (seSquared === 0) {
    if (delta === 0) {
      return {
        t: 0,
        delta: 0,
        standardError: 0,
        degreesOfFreedom: 0,
        pValueTwoSided: 1,
        valid: false,
      };
    }
    // Zero-variance with non-zero delta — infinite t. Clamp so
    // downstream JSON doesn't drop Infinity.
    return {
      t: Number.MAX_SAFE_INTEGER,
      delta,
      standardError: 0,
      degreesOfFreedom: n1 + n2 - 2,
      pValueTwoSided: 0,
      valid: true,
    };
  }
  const standardError = Math.sqrt(seSquared);
  const t = delta / standardError;
  // Welch–Satterthwaite degrees of freedom.
  const dfNum = seSquared * seSquared;
  const dfDen =
    (a.variance * a.variance) / (n1 * n1 * (n1 - 1)) +
    (b.variance * b.variance) / (n2 * n2 * (n2 - 1));
  const degreesOfFreedom = dfDen > 0 ? dfNum / dfDen : 0;
  const pValueTwoSided = normalCdfTwoSidedTail(t);
  return {
    t,
    delta,
    standardError,
    degreesOfFreedom,
    pValueTwoSided,
    valid: true,
  };
}
