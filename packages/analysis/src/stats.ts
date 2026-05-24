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
