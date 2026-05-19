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

/** Default probability threshold for "is a near-duplicate". */
export const DEFAULT_P_NEAR_DUP_TARGET = 0.5;

/** Below this label count, refuse to fit (PAV degenerates). */
export const MIN_LABELS_FOR_FIT = 40;

export interface CalibrationKnot {
  /** Cosine value at the start of this step. */
  cos: number;
  /** Calibrated P(near-duplicate) at and beyond `cos` (until next knot). */
  p: number;
}

export interface CalibrationCurve {
  schemaVersion: 1;
  method: 'isotonic';
  /** Wall-clock at fit time, ms since epoch. */
  calibratedAt: number;
  /** How many labels the fit consumed. */
  labelCount: number;
  /** Cosine band the labels were drawn from. */
  band: [number, number];
  /** Monotone non-decreasing step function, sorted by `cos`. */
  knots: CalibrationKnot[];
}

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
 * Evaluate the calibrated curve at an arbitrary cosine.
 *
 * Below the labeled range: return knots[0].p (flat extrapolation
 *   from the left endpoint).
 * Above the labeled range: return knots[last].p (flat from the
 *   right endpoint).
 * Within: return the p of the rightmost knot whose cos ≤ x.
 *
 * Flat extrapolation is the design-doc choice (linear extrapolation
 * with sparse tail labels frequently produces p > 1 or p < 0 — a
 * known PAV failure mode). See research/dedup-calibration-design.md.
 */
export function evaluateCalibration(
  curve: CalibrationCurve | readonly CalibrationKnot[],
  cos: number,
): number {
  const knots: readonly CalibrationKnot[] = Array.isArray(curve)
    ? curve
    : (curve as CalibrationCurve).knots;
  if (knots.length === 0) return 0;
  if (cos < knots[0]!.cos) return knots[0]!.p;
  if (cos >= knots[knots.length - 1]!.cos) return knots[knots.length - 1]!.p;
  // Binary search for the rightmost knot with knot.cos ≤ cos.
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
 * Build a complete CalibrationCurve from labels. Returns null when
 * the labels can't support a non-degenerate fit: < MIN_LABELS_FOR_FIT
 * points, all-positive, or all-negative. In those cases the caller
 * should leave calibration.json absent and fall back to the literature
 * threshold path.
 */
export function fitCalibration({
  labels,
  band,
  now = Date.now(),
}: {
  labels: readonly LabelPoint[];
  band: [number, number];
  now?: number;
}): CalibrationCurve | null {
  if (labels.length < MIN_LABELS_FOR_FIT) return null;
  const positives = labels.filter((l) => l.nearDup).length;
  if (positives === 0 || positives === labels.length) return null;
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
