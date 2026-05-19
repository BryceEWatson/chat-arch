/**
 * Probability calibration for the cosine → P(near-duplicate) map used
 * by `duplicatesSemantic.ts`.
 *
 * Background: even contrastively-trained sentence embedders (mxbai-
 * embed-large is trained with InfoNCE + AnglE loss on hard negatives)
 * leave residual miscalibration in the absolute-cosine surface
 * (Tacheny 2026, arXiv:2601.16907; Ethayarajh 2019 ACL D19-1006 for
 * the canonical "narrow cone" framing on pre-contrastive models). On
 * our corpus a precision sweep on labeled pairs in [0.85, 1.0]
 * plateaus inside that residually-compressed region — no single
 * cosine threshold gives reliable precision. The remedy is to map
 * cosine to a calibrated probability and threshold on probability
 * instead of raw cosine.
 *
 * Two fits are supported, with auto-selection by sample size:
 *
 *   - Platt scaling (sigmoid via logistic regression on labels). The
 *     standard choice below ~200 samples per Niculescu-Mizil & Caruana
 *     2005 — three parameters, smooth, doesn't overfit step functions
 *     to noise the way PAV does at small n.
 *   - PAV (Pool Adjacent Violators) isotonic regression. The standard
 *     choice above ~1000 samples — non-parametric, recovers arbitrary
 *     monotone shapes when labels are dense enough to support them.
 *
 * Both methods produce a curve evaluable at any cosine; flat
 * extrapolation outside the labeled range (sklearn `IsotonicRegression
 * (out_of_bounds='clip')` default — linear can yield p < 0 or p > 1).
 *
 * Pure / browser-safe.
 *
 * See research/dedup-calibration-design.md for the on-disk shape and
 * research/calibration-audit-2026-05-19.md for the audit that
 * triggered the Platt addition.
 */

/**
 * Default probability threshold for "is a near-duplicate."
 *
 * Lineage on this corpus (mxbai-embed-large, ~500 sessions):
 *   - 0.5  (initial Platt landing): symmetric-loss Bayes-optimal, wrong
 *           for asymmetric dedup loss. Per audit 2026-05-19 §5.
 *   - 0.9  (post-audit): production-grade precision target (Christen
 *           2012; NeMo Curator). Empirically unreachable here — even
 *           after a stratified + active labeling pass (124 labels)
 *           the fitted Platt curve maxes at P ≈ 0.74 at cos = 1.0,
 *           so pTarget=0.9 flagged nothing.
 *   - 0.7  (current): the empirical ceiling on this corpus + judge
 *           setup. Maps to cos ≈ 0.99 on the current curve;
 *           flags ~7-10 high-confidence pairs. Precision (vs
 *           calibrated judge-agreement, NOT vs human ground truth)
 *           ≈ 70%. The remaining uncertainty is real: ~28% of pairs
 *           at cos ≥ 0.96 yield split dual-judge verdicts, which is
 *           consistent with the PARAPHRASUS 2024 human-disagreement
 *           floor on hardest pair deciles.
 *
 * Re-evaluate when label count crosses ~500 (Platt → isotonic
 * regime) or when a cross-family judge gets wired up. See
 * research/calibration-tier3-design.md for the upgrade path.
 */
export const DEFAULT_P_NEAR_DUP_TARGET = 0.7;

/**
 * Below ~500 samples we use Platt scaling (smooth sigmoid, 2 params);
 * above we use PAV isotonic. Niculescu-Mizil & Caruana 2005, "Predicting
 * Good Probabilities with Supervised Learning," ICML — isotonic
 * dominates above ~1000, Platt below ~200, with a transitional band
 * between. 500 splits the band conservatively in favor of Platt's
 * stability at small n.
 */
export const ISOTONIC_MIN_LABELS = 500;

/** Minimum total labels before any calibration is attempted. */
export const MIN_LABELS_FOR_FIT = 50;
/** Minimum positives (and minimum negatives) required for a fit. */
export const MIN_PER_CLASS_FOR_FIT = 10;

export interface CalibrationKnot {
  /** Cosine value at the start of this step. */
  cos: number;
  /** Calibrated P(near-duplicate) at and beyond `cos` (until next knot). */
  p: number;
}

interface CalibrationBase {
  schemaVersion: 1;
  /** Wall-clock at fit time, ms since epoch. */
  calibratedAt: number;
  /** How many labels the fit consumed. */
  labelCount: number;
  /** Cosine band the labels were drawn from. */
  band: [number, number];
}

/** Isotonic (PAV) curve — monotone non-decreasing step function. */
export interface IsotonicCurve extends CalibrationBase {
  method: 'isotonic';
  knots: CalibrationKnot[];
}

/**
 * Platt-scaled sigmoid curve. The probability is computed analytically
 * as 1 / (1 + exp(a*cos + b)) — `knots` is a sampled rendering of the
 * sigmoid for human-readable inspection and is NOT consulted by
 * evaluateCalibration when method='platt'.
 */
export interface PlattCurve extends CalibrationBase {
  method: 'platt';
  a: number;
  b: number;
  /** Sampled (cos, p) pairs across the band, for inspection only. */
  knots: CalibrationKnot[];
}

export type CalibrationCurve = IsotonicCurve | PlattCurve;

export interface LabelPoint {
  cos: number;
  /** True = near-duplicate, False = not. */
  nearDup: boolean;
}

/**
 * Pool Adjacent Violators algorithm for isotonic regression.
 *
 * Input: labeled points sorted by `cos`.
 * Output: a monotone non-decreasing step function (one `p` per merged
 * block of points). The classical PAV: scan left-to-right; whenever
 * the running mean would violate monotonicity, merge with the
 * previous block and recompute the mean. Each point is touched O(1)
 * amortised time → O(n) total.
 *
 * Ties on `cos` are pre-merged into a single block (one point per
 * unique cos), then PAV-merged across blocks. This matters because
 * two pairs at exactly the same cosine must get the same P(near-dup)
 * regardless of label order.
 */
export function fitIsotonic(labels: readonly LabelPoint[]): CalibrationKnot[] {
  if (labels.length === 0) return [];
  // Sort by cos, ascending.
  const sorted = [...labels].sort((a, b) => a.cos - b.cos);

  // Initial blocks: one per unique cos, p = mean(label) over points at
  // that cos, weight = count.
  type Block = { cos: number; sum: number; weight: number };
  const blocks: Block[] = [];
  for (const pt of sorted) {
    const prev = blocks[blocks.length - 1];
    const y = pt.nearDup ? 1 : 0;
    if (prev !== undefined && prev.cos === pt.cos) {
      prev.sum += y;
      prev.weight += 1;
    } else {
      blocks.push({ cos: pt.cos, sum: y, weight: 1 });
    }
  }

  // PAV merge pass: maintain a stack of monotone blocks. Whenever the
  // top block's mean exceeds the next-to-top's, merge.
  const stack: Block[] = [];
  for (const b of blocks) {
    stack.push({ ...b });
    while (stack.length >= 2) {
      const top = stack[stack.length - 1]!;
      const prev = stack[stack.length - 2]!;
      const topMean = top.sum / top.weight;
      const prevMean = prev.sum / prev.weight;
      if (prevMean <= topMean) break;
      // Violation: merge top into prev. Keep prev's cos (the left
      // edge of the merged block); the step function is right-
      // continuous from prev.cos onward.
      prev.sum += top.sum;
      prev.weight += top.weight;
      stack.pop();
    }
  }

  return stack.map((b) => ({ cos: b.cos, p: b.sum / b.weight }));
}

/**
 * Platt scaling — fit a sigmoid P(y=1 | x) = 1 / (1 + exp(a*x + b))
 * to binary labels by maximum likelihood. Implementation follows
 * Lin, Lin & Weng 2007, "A Note on Platt's Probabilistic Outputs for
 * Support Vector Machines" — the standard numerically-stable variant
 * of Platt's original 1999 algorithm. Newton's method with
 * backtracking line search, prior-corrected target values
 * (y* = (N+1)/(N+2) vs 1/(N+2)) to prevent boundary overfit.
 *
 * At our calibration scales (50–500 labels) this converges in fewer
 * than 30 iterations on real data. Returns null on degenerate input.
 */
export function fitPlatt(
  labels: readonly LabelPoint[],
): { a: number; b: number } | null {
  if (labels.length === 0) return null;
  const n = labels.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let nPos = 0;
  for (let i = 0; i < n; i += 1) {
    x[i] = labels[i]!.cos;
    if (labels[i]!.nearDup) {
      y[i] = 1;
      nPos += 1;
    }
  }
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return null;

  // Prior-corrected targets (Platt 1999, Eq. (10); Lin 2007 §3).
  const hiTarget = (nPos + 1) / (nPos + 2);
  const loTarget = 1 / (nNeg + 2);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i += 1) t[i] = y[i] === 1 ? hiTarget : loTarget;

  // Initial values: log of class-prior odds (Lin 2007).
  let a = 0;
  let b = Math.log((nNeg + 1) / (nPos + 1));

  const maxIter = 100;
  const minStep = 1e-10;
  const sigma = 1e-12;

  // Initial objective value.
  let fval = 0;
  for (let i = 0; i < n; i += 1) {
    const fApB = a * x[i]! + b;
    if (fApB >= 0) fval += t[i]! * fApB + Math.log1p(Math.exp(-fApB));
    else fval += (t[i]! - 1) * fApB + Math.log1p(Math.exp(fApB));
  }

  for (let iter = 0; iter < maxIter; iter += 1) {
    // Gradient + Hessian.
    let h11 = sigma;
    let h22 = sigma;
    let h21 = 0;
    let g1 = 0;
    let g2 = 0;
    for (let i = 0; i < n; i += 1) {
      const fApB = a * x[i]! + b;
      let p: number;
      let q: number;
      if (fApB >= 0) {
        const ex = Math.exp(-fApB);
        p = ex / (1 + ex);
        q = 1 / (1 + ex);
      } else {
        const ex = Math.exp(fApB);
        p = 1 / (1 + ex);
        q = ex / (1 + ex);
      }
      const d2 = p * q;
      h11 += x[i]! * x[i]! * d2;
      h22 += d2;
      h21 += x[i]! * d2;
      const d1 = t[i]! - p;
      g1 += x[i]! * d1;
      g2 += d1;
    }

    if (Math.abs(g1) < 1e-5 && Math.abs(g2) < 1e-5) break;

    // Solve 2×2 Newton step.
    const det = h11 * h22 - h21 * h21;
    const dA = -(h22 * g1 - h21 * g2) / det;
    const dB = -(-h21 * g1 + h11 * g2) / det;
    const gd = g1 * dA + g2 * dB;

    // Backtracking line search.
    let stepSize = 1;
    while (stepSize >= minStep) {
      const newA = a + stepSize * dA;
      const newB = b + stepSize * dB;
      let newFval = 0;
      for (let i = 0; i < n; i += 1) {
        const fApB = newA * x[i]! + newB;
        if (fApB >= 0) newFval += t[i]! * fApB + Math.log1p(Math.exp(-fApB));
        else newFval += (t[i]! - 1) * fApB + Math.log1p(Math.exp(fApB));
      }
      if (newFval < fval + 0.0001 * stepSize * gd) {
        a = newA;
        b = newB;
        fval = newFval;
        break;
      }
      stepSize /= 2;
    }
    if (stepSize < minStep) break;
  }

  return { a, b };
}

/** Sigmoid sampler — produce display-only knots from Platt params. */
function plattKnots(
  params: { a: number; b: number },
  band: [number, number],
  n = 32,
): CalibrationKnot[] {
  const out: CalibrationKnot[] = [];
  for (let i = 0; i < n; i += 1) {
    const cos = band[0] + ((band[1] - band[0]) * i) / (n - 1);
    out.push({ cos, p: plattEvaluate(params.a, params.b, cos) });
  }
  return out;
}

function plattEvaluate(a: number, b: number, cos: number): number {
  const fApB = a * cos + b;
  // Numerically-stable sigmoid (avoid overflow at large |fApB|).
  if (fApB >= 0) {
    const ex = Math.exp(-fApB);
    return ex / (1 + ex);
  }
  const ex = Math.exp(fApB);
  return 1 / (1 + ex);
}

/**
 * Evaluate a calibration curve at an arbitrary cosine.
 *
 * For Platt: evaluate the sigmoid analytically. Clamp cos to the band
 *   so out-of-range inputs return the boundary value (flat
 *   extrapolation, matching the isotonic convention).
 *
 * For isotonic: return the p of the rightmost knot whose cos ≤ x.
 *   Below the labeled range → knots[0].p; above → knots[last].p. Flat
 *   extrapolation per sklearn IsotonicRegression(out_of_bounds='clip')
 *   default — linear extrapolation can yield p < 0 or p > 1.
 *
 * Accepts a bare knot array for backward compat (treated as isotonic).
 */
export function evaluateCalibration(
  curve: CalibrationCurve | readonly CalibrationKnot[],
  cos: number,
): number {
  if (Array.isArray(curve)) {
    return evaluateIsotonicKnots(curve, cos);
  }
  const c = curve as CalibrationCurve;
  if (c.method === 'platt') {
    const lo = c.band[0];
    const hi = c.band[1];
    const clamped = cos < lo ? lo : cos > hi ? hi : cos;
    return plattEvaluate(c.a, c.b, clamped);
  }
  return evaluateIsotonicKnots(c.knots, cos);
}

function evaluateIsotonicKnots(
  knots: readonly CalibrationKnot[],
  cos: number,
): number {
  if (knots.length === 0) return 0;
  if (cos < knots[0]!.cos) return knots[0]!.p;
  if (cos >= knots[knots.length - 1]!.cos) return knots[knots.length - 1]!.p;
  let lo = 0;
  let hi = knots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (knots[mid]!.cos <= cos) lo = mid;
    else hi = mid - 1;
  }
  return knots[lo]!.p;
}

/**
 * Build a calibration curve from labels. Auto-selects between Platt
 * (smooth sigmoid, robust at n<500) and PAV isotonic (non-parametric,
 * needs n≥500 to recover arbitrary shapes without overfitting noise).
 *
 * Returns null on degenerate input:
 *   - fewer than MIN_LABELS_FOR_FIT (50) total points, OR
 *   - fewer than MIN_PER_CLASS_FOR_FIT (10) of either class.
 *
 * The 10-per-class floor was added in audit 2026-05-19 — a single
 * positive can dominate a small fit (Niculescu-Mizil & Caruana 2005;
 * Guo et al. 2017). Below the floor, leave calibration.json absent
 * and fall back to the literature threshold path.
 */
export function fitCalibration({
  labels,
  band,
  now = Date.now(),
  forceMethod,
}: {
  labels: readonly LabelPoint[];
  band: [number, number];
  now?: number;
  /** Override auto-selection for tests / experiments. */
  forceMethod?: 'platt' | 'isotonic';
}): CalibrationCurve | null {
  if (labels.length < MIN_LABELS_FOR_FIT) return null;
  const positives = labels.filter((l) => l.nearDup).length;
  const negatives = labels.length - positives;
  if (positives < MIN_PER_CLASS_FOR_FIT) return null;
  if (negatives < MIN_PER_CLASS_FOR_FIT) return null;

  const method =
    forceMethod ?? (labels.length < ISOTONIC_MIN_LABELS ? 'platt' : 'isotonic');

  if (method === 'platt') {
    const params = fitPlatt(labels);
    if (params === null) return null;
    return {
      schemaVersion: 1,
      method: 'platt',
      calibratedAt: now,
      labelCount: labels.length,
      band,
      a: params.a,
      b: params.b,
      knots: plattKnots(params, band),
    };
  }

  const knots = fitIsotonic(labels);
  if (knots.length === 0) return null;
  return {
    schemaVersion: 1,
    method: 'isotonic',
    calibratedAt: now,
    labelCount: labels.length,
    band,
    knots,
  };
}

/**
 * Active-sampling helper for the next labeling pass.
 *
 * Given a pool of unlabeled pairs and the current calibration curve,
 * return the `n` pairs whose calibrated P is closest to 0.5 — i.e.
 * where the model is least certain. Labeling those tightens the fit
 * faster than another stratified-random pass, which spends label
 * budget on pairs whose verdict is already obvious under the curve.
 *
 * `uncertainty = 1 - |p - 0.5| * 2`, in [0, 1], peaks at p = 0.5.
 *
 * Generic over pair shape — anything with a `cos: number` works.
 *
 * Caveat (see research/calibration-tier3-design.md §1): active samples
 * concentrate near the decision boundary, so they are NOT a
 * representative sample of in-band pairs. A precision sweep computed
 * over actively-sampled labels will be biased. Either maintain a
 * separate stratified set for sweep reporting, or annotate.
 */
export function sampleByCurveUncertainty<T extends { cos: number }>(
  pairs: readonly T[],
  curve: CalibrationCurve,
  n: number,
): T[] {
  if (n <= 0 || pairs.length === 0) return [];
  const scored = pairs.map((p) => ({
    pair: p,
    uncertainty: 1 - Math.abs(evaluateCalibration(curve, p.cos) - 0.5) * 2,
  }));
  scored.sort((a, b) => b.uncertainty - a.uncertainty);
  return scored.slice(0, n).map((s) => s.pair);
}
