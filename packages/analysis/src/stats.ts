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
 * Indexable numeric vector — covers `Float32Array`, `Float64Array`,
 * `Array<number>`, `ReadonlyArray<number>`. The cosine-similarity
 * functions accept either form; mismatched lengths are tolerated by
 * iterating to `min(a.length, b.length)`.
 */
export type NumericVector =
  | Float32Array
  | Float64Array
  | readonly number[];

/**
 * Cosine similarity of two arbitrary (un-normalized) numeric vectors:
 *
 *     cos(a, b) = (a · b) / (|a| · |b|)
 *
 * Returns 0 when either vector has zero magnitude (the cosine is
 * mathematically undefined; 0 is the conservative "no similarity"
 * fallback the downstream rankers expect).
 *
 * For unit-length inputs prefer `cosineSimilarityNormalized` — it
 * skips two `sqrt`s in the hot loop. (D2 tech-debt sweep: centralizes
 * the previously-triplicated implementations in
 * `packages/analysis/src/clusterRules.ts`,
 * `packages/exporter/src/embeddings/index.ts`, and the
 * `cosineSimilarityNormalized` in `classifyByEmbedding.ts`.)
 */
export function cosineSimilarity(a: NumericVector, b: NumericVector): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine similarity of two unit-length vectors — equivalent to
 * `dot(a, b)` because the magnitudes are 1. Callers MUST pre-normalize
 * the inputs (the embedding pipeline does so once at write-time so
 * downstream lookups are dot-product-fast).
 *
 * Behavior on non-unit inputs is intentionally NOT defensive — the
 * function returns whatever the dot product gives, which is wrong
 * but cheaper than checking. Pass non-normalized vectors to the
 * general `cosineSimilarity` instead.
 */
export function cosineSimilarityNormalized(
  a: NumericVector,
  b: NumericVector,
): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    s += (a[i] as number) * (b[i] as number);
  }
  return s;
}

/**
 * Fisher's exact test for a 2×2 contingency table. Two-sided p-value
 * via the "minlike" method: sum of hypergeometric probabilities of all
 * tables with the same marginals and probability ≤ P(observed).
 *
 *   table = [[a, b], [c, d]]    rowSums = (a+b), (c+d)
 *                               colSums = (a+c), (b+d)
 *                               N = a+b+c+d
 *
 * Probability of a table with cell `a' = i` (other cells derive from
 * the margins): C(R1, i) * C(R2, C1 - i) / C(N, C1).
 *
 * Returns 1 when any margin is zero (no test is meaningful — the
 * table is degenerate).
 *
 * Use this instead of `twoProportionPValue` when the z-approximation
 * is unreliable — the canonical rule is "any expected cell count
 * < 5." `expectedCellCounts2x2(nA, nB, goodA, goodB)` below returns
 * the four expected counts so callers can apply that gate uniformly.
 *
 * Numerical stability: uses `lnFactorial` (log-gamma) throughout —
 * stable for `N` well beyond what chat-arch surfaces (≥ 10,000 is
 * fine; the lnFactorial implementation uses Stirling's series above
 * a small lookup table).
 */
export function fisherExactPValue2x2(
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  if (![a, b, c, d].every((v) => Number.isFinite(v) && v >= 0 && Number.isInteger(v))) {
    return 1;
  }
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const c2 = b + d;
  const n = r1 + r2;
  if (r1 === 0 || r2 === 0 || c1 === 0 || c2 === 0) return 1;

  // The observed cell-A count is `a`. Possible values range over
  // [max(0, c1 - r2), min(r1, c1)] subject to keeping all four cells
  // ≥ 0 with the same row/column marginals.
  const aMin = Math.max(0, c1 - r2);
  const aMax = Math.min(r1, c1);

  const lnPObserved = lnHypergeomProb(a, r1, r2, c1);
  // "minlike" two-sided: include every table whose log-probability is
  // ≤ the observed log-probability (within a small epsilon to avoid
  // floating-point edge cases excluding the observed cell itself).
  const EPS = 1e-12;
  let logSumP = -Infinity;
  for (let i = aMin; i <= aMax; i += 1) {
    const lp = lnHypergeomProb(i, r1, r2, c1);
    if (lp <= lnPObserved + EPS) {
      // logsumexp: log(exp(logSumP) + exp(lp)).
      if (logSumP === -Infinity) {
        logSumP = lp;
      } else {
        const max = Math.max(logSumP, lp);
        logSumP = max + Math.log(Math.exp(logSumP - max) + Math.exp(lp - max));
      }
    }
  }
  return Math.min(1, Math.exp(logSumP));
}

/**
 * The four expected cell counts for a 2×2 contingency table built
 * from two-proportion data. Use the minimum value to decide between
 * `twoProportionPValue` (z-test) and `fisherExactPValue2x2`:
 *
 *   if (Math.min(...expectedCellCounts2x2(...)) < 5) use Fisher.
 *
 * Returns `[E(good, A), E(bad, A), E(good, B), E(bad, B)]`.
 */
export function expectedCellCounts2x2(
  nA: number,
  nB: number,
  goodA: number,
  goodB: number,
): readonly [number, number, number, number] {
  const n = nA + nB;
  if (n <= 0) return [0, 0, 0, 0];
  const goodTotal = goodA + goodB;
  const badTotal = n - goodTotal;
  return [
    (nA * goodTotal) / n,
    (nA * badTotal) / n,
    (nB * goodTotal) / n,
    (nB * badTotal) / n,
  ];
}

/**
 * Log-probability of a 2×2 contingency table with cell-A value `a` and
 * marginals `r1, r2, c1` (c2 = r1+r2-c1 derived). Uses the
 * hypergeometric formula in log-space for stability:
 *
 *   ln P(a) = ln C(r1, a) + ln C(r2, c1 - a) - ln C(N, c1)
 *
 * where ln C(n, k) = lnFactorial(n) - lnFactorial(k) - lnFactorial(n - k).
 */
function lnHypergeomProb(a: number, r1: number, r2: number, c1: number): number {
  const n = r1 + r2;
  const b = r1 - a;
  const cCell = c1 - a;
  const dCell = r2 - cCell;
  if (a < 0 || b < 0 || cCell < 0 || dCell < 0) return -Infinity;
  return (
    lnFactorial(r1) +
    lnFactorial(r2) +
    lnFactorial(c1) +
    lnFactorial(n - c1) -
    lnFactorial(n) -
    lnFactorial(a) -
    lnFactorial(b) -
    lnFactorial(cCell) -
    lnFactorial(dCell)
  );
}

/**
 * Natural log of n! using a small lookup table for n ≤ 21 (exact
 * via JavaScript double accumulation) and Stirling's series for n > 21:
 *
 *   ln Γ(n+1) ≈ (n + 0.5) ln n − n + 0.5 ln(2π) + 1/(12n) − 1/(360 n³) + ...
 *
 * Stirling truncation error at the n=22 boundary is ≈ 1.4e-10; falls
 * below 1e-10 by n=23. The boundary is set at 21 (not 20) so the
 * worst-case truncation never exceeds 1e-10 — adequate for any
 * Fisher p-value rounded to 6+ digits.
 */
function lnFactorial(n: number): number {
  if (n < 0 || !Number.isFinite(n)) return Number.NaN;
  if (n <= 21) {
    let acc = 0;
    for (let i = 2; i <= n; i += 1) acc += Math.log(i);
    return acc;
  }
  // Stirling's series.
  const inv = 1 / n;
  const inv3 = inv * inv * inv;
  return (
    (n + 0.5) * Math.log(n) -
    n +
    0.5 * Math.log(2 * Math.PI) +
    inv / 12 -
    inv3 / 360
  );
}

/**
 * McNemar test for paired binary outcomes. The pair-level 2×2 table:
 *
 *                     control: good   control: bad
 *   treated: good     concordantGood    b (discordant)
 *   treated: bad      c (discordant)    concordantBad
 *
 * Only the discordant counts `b` and `c` matter — concordant pairs
 * contribute no information about the treatment effect (both responded
 * the same way). The null hypothesis is `b = c` (treatment has no
 * effect on the discordant subset).
 *
 * Returns `null` when no test is meaningful — `b + c === 0` (no
 * discordant pairs) or invalid inputs (negative / non-finite). Otherwise:
 *   - `b + c < 25`: exact two-sided binomial test against
 *     Binomial(n=b+c, p=0.5). Agresti's small-sample rule.
 *   - Otherwise: continuity-corrected χ² with 1 df:
 *     `χ² = (|b - c| - 1)² / (b + c)`, two-sided p via
 *     `2 * (1 - Φ(√χ²))`.
 *
 * Used by `computeReflexive` to test the matched-pair contrast in a
 * way that respects pairing (treating pairs as independent observations,
 * not pooling them into independent-proportion tests).
 */
export type McNemarMethod = 'exact' | 'chi-squared';

export function mcnemarPValue(
  b: number,
  c: number,
): { readonly p: number; readonly method: McNemarMethod } | null {
  if (!Number.isFinite(b) || !Number.isFinite(c) || b < 0 || c < 0) {
    return null;
  }
  const n = b + c;
  if (n === 0) return null;
  if (n < 25) {
    // Exact two-sided binomial against p=0.5. Compute the smaller tail
    // and double; clip to 1.
    const k = Math.min(b, c);
    let cumulative = 0;
    // P(X <= k) under Binomial(n, 0.5) = sum_{i=0..k} C(n, i) * (0.5)^n.
    // Iterate combinatorially to avoid overflow at moderate n.
    let coef = 1; // C(n, 0)
    for (let i = 0; i <= k; i += 1) {
      cumulative += coef;
      // Recurrence: C(n, i+1) = C(n, i) * (n - i) / (i + 1)
      coef = (coef * (n - i)) / (i + 1);
    }
    const twoSided = Math.min(1, 2 * cumulative * Math.pow(0.5, n));
    return { p: twoSided, method: 'exact' };
  }
  // Continuity-corrected χ² with df=1.
  const num = Math.abs(b - c) - 1;
  if (num <= 0) {
    // |b-c| ≤ 1 with the correction yields χ² ≤ 0 → p = 1.
    return { p: 1, method: 'chi-squared' };
  }
  const chiSquared = (num * num) / n;
  // P(χ²_1 > x) = 2 * (1 - Φ(√x)).
  const p = 2 * (1 - normalCdf(Math.sqrt(chiSquared)));
  return { p: Math.max(0, Math.min(1, p)), method: 'chi-squared' };
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
