/**
 * Shared statistics utilities — Wilson CI, sigmoid, matched-pair primitives,
 * EWMA, simple bootstrap helpers.
 *
 * Browser-safe pure functions. Originally Wilson CI was inlined at
 * apps/standalone/src/pages/api/calibrate.ts; relocated here so both the
 * dedup-calibration pipeline AND the outcome-substrate pipeline can share
 * one implementation.
 */

const Z_95 = 1.96;

/**
 * Wilson score 95% CI for a binomial proportion p̂ over n samples.
 * Edge cases: n=0 returns [0,1] (no information); p̂=0 or 1 still yields
 * a finite interval (Wilson is well-behaved at boundaries, unlike the
 * normal approximation).
 */
export function wilsonCI(
  pHat: number,
  n: number,
  z = Z_95,
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

/** Standard logistic sigmoid. */
export function sigmoid(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * Exponentially-weighted moving average with half-life expressed in
 * arbitrary units (must match the spacing of `xs`). Returns one value
 * per input, same length.
 */
export function ewma(xs: readonly number[], halfLife: number): number[] {
  if (xs.length === 0) return [];
  const alpha = 1 - Math.pow(0.5, 1 / Math.max(halfLife, 1e-9));
  const out: number[] = [];
  let s = xs[0]!;
  out.push(s);
  for (let i = 1; i < xs.length; i++) {
    s = alpha * (xs[i] as number) + (1 - alpha) * s;
    out.push(s);
  }
  return out;
}

/**
 * Euclidean distance between two vectors of equal length.
 * Caller is responsible for matching lengths (asserted via a NaN return
 * when mismatched).
 */
export function euclidean(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.NaN;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * 1-nearest-neighbor matched-pair: for each item in `treated`, find the
 * item in `control` minimizing covariate distance. Returns the pairs
 * with their distances. Caller must ensure `covariates(x)` returns a
 * pre-treatment-only feature vector (no leakage of the outcome being
 * studied).
 *
 * For k > 1, averages the k nearest controls' outcomes (caller-side).
 */
export function matchedPair1NN<T>(
  treated: readonly T[],
  control: readonly T[],
  covariates: (item: T) => readonly number[],
): Array<{ treated: T; control: T; distance: number }> {
  const out: Array<{ treated: T; control: T; distance: number }> = [];
  if (treated.length === 0 || control.length === 0) return out;
  const controlVecs = control.map(c => ({ item: c, vec: covariates(c) }));
  for (const t of treated) {
    const tVec = covariates(t);
    let best: { item: T; distance: number } | null = null;
    for (const c of controlVecs) {
      const d = euclidean(tVec, c.vec);
      if (!Number.isFinite(d)) continue;
      if (best === null || d < best.distance) best = { item: c.item, distance: d };
    }
    if (best !== null) out.push({ treated: t, control: best.item, distance: best.distance });
  }
  return out;
}

/** Mean of a finite-length numeric array; NaN on empty. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Variance (sample, n-1 denominator); NaN when n<2. */
export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return s / (xs.length - 1);
}

/**
 * Standard normal CDF Φ(x) = (1 + erf(x/√2)) / 2, using the
 * Abramowitz & Stegun 7.1.26 approximation of erf. Max erf error
 * ≈ 1.5e-7 — adequate for everything we use it for (p-values,
 * z-tests; not for tail-quantile work).
 *
 * NOTE: Centralizing here also corrects an existing bug in
 * `surfaceComparisonBuilder.ts`'s inline `normalCdf`, which returned
 * `erf(x)` instead of `Φ(x)` — a missing `/√2` argument scaling. That
 * bug caused `twoProportionPValue` to over-reject (treat z=2.0 as
 * p≈0.005 when the true two-sided p is ≈0.046). The implementation
 * in `skillCurve.ts` was already correct; both consumers now import
 * from this module.
 */
export function normalCdf(x: number): number {
  const z = x / Math.SQRT2;
  const sign = z < 0 ? -1 : 1;
  const az = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * az);
  const erfAz =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t) *
      Math.exp(-az * az);
  return 0.5 * (1 + sign * erfAz);
}

/**
 * Pooled two-proportion z-test. Returns the two-sided p-value of the
 * null hypothesis p_a = p_b. Pooled estimate is the standard form for
 * this test under H_0.
 *
 * Returns 1 (no evidence) when either side has n <= 0 or the pooled
 * proportion is 0 or 1 (SE undefined or zero).
 */
export function twoProportionPValue(
  good_a: number,
  n_a: number,
  good_b: number,
  n_b: number,
): number {
  if (n_a <= 0 || n_b <= 0) return 1;
  const pA = good_a / n_a;
  const pB = good_b / n_b;
  const pPool = (good_a + good_b) / (n_a + n_b);
  if (pPool === 0 || pPool === 1) return 1;
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n_a + 1 / n_b));
  if (se === 0) return 1;
  const z = (pA - pB) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Benjamini-Hochberg false-discovery-rate adjustment. Given m raw
 * two-sided p-values, returns the m BH-adjusted q-values (same shape,
 * same order as input).
 *
 * Algorithm (step-up form): rank ascending; q_(i) = min over j>=i of
 * (m/j) * p_(j); clipped to [0, 1]. NaN p-values pass through as NaN
 * (treated as "missing", excluded from the rank pool). This is the
 * standard textbook definition; see Benjamini & Hochberg (1995).
 *
 * Reject H0_i at FDR α when q_i ≤ α. For multiple-comparison correction
 * across a family of tests (e.g., ITS comparisons across N config
 * commits per `itsAnalysis.ts`).
 */
export function bhFdrAdjust(ps: readonly number[]): number[] {
  const m = ps.length;
  if (m === 0) return [];
  const out = new Array<number>(m);
  const indexed: Array<{ p: number; i: number }> = [];
  for (let i = 0; i < m; i += 1) {
    const p = ps[i]!;
    if (Number.isNaN(p)) {
      out[i] = Number.NaN;
      continue;
    }
    indexed.push({ p, i });
  }
  if (indexed.length === 0) return out;
  indexed.sort((a, b) => a.p - b.p);
  const k = indexed.length;
  // Step-up: walk from largest p downward, maintain running min of
  // (k/(j+1)) * p_(j+1).
  let running = Number.POSITIVE_INFINITY;
  const adjSorted = new Array<number>(k);
  for (let j = k - 1; j >= 0; j -= 1) {
    const candidate = (k / (j + 1)) * indexed[j]!.p;
    if (candidate < running) running = candidate;
    adjSorted[j] = Math.max(0, Math.min(1, running));
  }
  for (let j = 0; j < k; j += 1) out[indexed[j]!.i] = adjSorted[j]!;
  return out;
}
