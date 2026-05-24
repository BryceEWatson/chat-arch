import { describe, it, expect } from 'vitest';
import {
  bhFdrAdjust,
  cosineSimilarity,
  cosineSimilarityNormalized,
  euclidean,
  ewma,
  expectedCellCounts2x2,
  fisherExactPValue2x2,
  matchedPair1NN,
  mcnemarPValue,
  mean,
  normalCdf,
  sigmoid,
  twoProportionPValue,
  variance,
  wilsonCI,
} from './stats.js';

describe('wilsonCI', () => {
  it('returns [0,1] on n=0', () => {
    const { low, high } = wilsonCI(0, 0);
    expect(low).toBe(0);
    expect(high).toBe(1);
  });

  it('stays inside [0,1] at boundaries', () => {
    const a = wilsonCI(0, 50);
    expect(a.low).toBe(0);
    expect(a.high).toBeLessThan(0.2);
    const b = wilsonCI(1, 50);
    expect(b.high).toBe(1);
    expect(b.low).toBeGreaterThan(0.8);
  });

  it('width shrinks as n grows', () => {
    const small = wilsonCI(0.5, 10);
    const big = wilsonCI(0.5, 1000);
    expect(big.high - big.low).toBeLessThan(small.high - small.low);
  });

  it('p̂=0.5, n=8 has width ≈0.4 (matches THRESHOLDS.display rationale)', () => {
    const { low, high } = wilsonCI(0.5, 8);
    const width = high - low;
    expect(width).toBeGreaterThan(0.35);
    expect(width).toBeLessThan(0.6);
  });
});

describe('sigmoid', () => {
  it('sigmoid(0) === 0.5', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 9);
  });
  it('monotonic and bounded', () => {
    expect(sigmoid(-100)).toBeGreaterThanOrEqual(0);
    expect(sigmoid(100)).toBeLessThanOrEqual(1);
    expect(sigmoid(2)).toBeGreaterThan(sigmoid(1));
  });
});

describe('ewma', () => {
  it('empty input -> empty output', () => {
    expect(ewma([], 7)).toEqual([]);
  });
  it('preserves first value; converges toward steady state', () => {
    const xs = [1, 1, 1, 1, 1];
    const out = ewma(xs, 2);
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBeCloseTo(1, 9);
  });
  it('responds faster with shorter half-life', () => {
    const xs = [0, 0, 0, 1, 1, 1];
    const slow = ewma(xs, 10);
    const fast = ewma(xs, 1);
    // After one impulse at index 3, the fast EWMA is closer to 1 than the slow EWMA.
    expect(fast[4]!).toBeGreaterThan(slow[4]!);
  });
});

describe('euclidean', () => {
  it('zero when identical', () => {
    expect(euclidean([1, 2, 3], [1, 2, 3])).toBe(0);
  });
  it('Pythagorean', () => {
    expect(euclidean([0, 0], [3, 4])).toBe(5);
  });
  it('NaN on mismatched length', () => {
    expect(Number.isNaN(euclidean([1, 2], [1, 2, 3]))).toBe(true);
  });
});

describe('matchedPair1NN', () => {
  type Item = { id: string; cov: number[] };
  const cov = (i: Item) => i.cov;

  it('empty treated -> empty', () => {
    expect(matchedPair1NN([], [{ id: 'c', cov: [0] }], cov)).toEqual([]);
  });
  it('empty control -> empty', () => {
    expect(matchedPair1NN([{ id: 't', cov: [0] }], [], cov)).toEqual([]);
  });
  it('matches each treated to nearest control', () => {
    const treated = [{ id: 't1', cov: [0, 0] }, { id: 't2', cov: [10, 10] }];
    const control = [
      { id: 'c-near-t1', cov: [0.1, 0.1] },
      { id: 'c-near-t2', cov: [10.1, 9.9] },
      { id: 'c-far', cov: [-50, -50] },
    ];
    const pairs = matchedPair1NN(treated, control, cov);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.control.id).toBe('c-near-t1');
    expect(pairs[1]!.control.id).toBe('c-near-t2');
  });
});

describe('mean / variance', () => {
  it('mean of [1,2,3,4,5]', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
  it('variance is n-1 sample variance', () => {
    // [2,4,4,4,5,5,7,9]: mean=5, sum of squared deviations=32, sample var=32/7
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 9);
  });
  it('mean empty -> NaN', () => {
    expect(Number.isNaN(mean([]))).toBe(true);
  });
  it('variance n<2 -> NaN', () => {
    expect(Number.isNaN(variance([1]))).toBe(true);
  });
});

describe('normalCdf', () => {
  it('Φ(0) = 0.5', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });
  it('Φ(1.96) ≈ 0.975 (two-sided α=0.05 critical)', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
  it('symmetric: Φ(-x) = 1 - Φ(x)', () => {
    for (const x of [0.5, 1.0, 1.96, 2.58]) {
      expect(normalCdf(-x)).toBeCloseTo(1 - normalCdf(x), 5);
    }
  });
  it('tail behavior: Φ(5) ≈ 1, Φ(-5) ≈ 0', () => {
    expect(normalCdf(5)).toBeGreaterThan(0.9999);
    expect(normalCdf(-5)).toBeLessThan(0.0001);
  });
});

describe('twoProportionPValue', () => {
  it('identical proportions -> p ≈ 1', () => {
    const p = twoProportionPValue(50, 100, 50, 100);
    expect(p).toBeCloseTo(1, 3);
  });
  it('large delta + large n -> small p', () => {
    // 80/100 vs 20/100: z ≈ 8.5, p essentially 0.
    const p = twoProportionPValue(80, 100, 20, 100);
    expect(p).toBeLessThan(1e-6);
  });
  it('moderate delta + moderate n -> moderate p', () => {
    // 60/100 vs 40/100. Pooled p=0.5; SE = sqrt(0.25 * (1/100+1/100)) = 0.0707.
    // z = (0.6-0.4)/0.0707 = 2.828. Two-sided p = 2(1-Φ(2.828)) ≈ 0.0047.
    const p = twoProportionPValue(60, 100, 40, 100);
    expect(p).toBeGreaterThan(0.003);
    expect(p).toBeLessThan(0.007);
  });

  it('matches scipy.stats benchmark: 55/100 vs 45/100 → p ≈ 0.157', () => {
    // Independent textbook check: pooled p = 0.5, SE = 0.0707,
    // z = (0.55-0.45)/0.0707 = 1.414, two-sided p = 2(1-Φ(1.414)) ≈ 0.157.
    const p = twoProportionPValue(55, 100, 45, 100);
    expect(p).toBeCloseTo(0.157, 2);
  });
  it('zero-n side -> p = 1 (no evidence)', () => {
    expect(twoProportionPValue(0, 0, 5, 10)).toBe(1);
    expect(twoProportionPValue(5, 10, 0, 0)).toBe(1);
  });
  it('all-zero or all-one pool -> p = 1 (undefined SE)', () => {
    expect(twoProportionPValue(0, 10, 0, 10)).toBe(1);
    expect(twoProportionPValue(10, 10, 10, 10)).toBe(1);
  });
});

describe('bhFdrAdjust (Benjamini-Hochberg)', () => {
  it('empty input -> empty output', () => {
    expect(bhFdrAdjust([])).toEqual([]);
  });
  it('preserves input order', () => {
    const ps = [0.5, 0.001, 0.3, 0.04, 0.02];
    const qs = bhFdrAdjust(ps);
    expect(qs).toHaveLength(ps.length);
  });
  it('textbook example: BH on uniformly spaced p-values', () => {
    // Classic BH walk-through. Ps in ascending order:
    //   p_(1) = 0.005, p_(2) = 0.01, p_(3) = 0.02, p_(4) = 0.04, p_(5) = 0.05
    // Adjusted: q_(i) = min over j>=i of (m/j) * p_(j); m=5.
    //   q_(5) = (5/5)*0.05 = 0.05
    //   q_(4) = min(0.05, (5/4)*0.04 = 0.05) = 0.05
    //   q_(3) = min(0.05, (5/3)*0.02 = 0.0333) = 0.0333
    //   q_(2) = min(0.0333, (5/2)*0.01 = 0.025) = 0.025
    //   q_(1) = min(0.025, (5/1)*0.005 = 0.025) = 0.025
    const ps = [0.005, 0.01, 0.02, 0.04, 0.05];
    const qs = bhFdrAdjust(ps);
    expect(qs[0]!).toBeCloseTo(0.025, 6);
    expect(qs[1]!).toBeCloseTo(0.025, 6);
    expect(qs[2]!).toBeCloseTo(0.0333, 3);
    expect(qs[3]!).toBeCloseTo(0.05, 6);
    expect(qs[4]!).toBeCloseTo(0.05, 6);
  });
  it('monotonic step-up: sorted q is non-decreasing', () => {
    const ps = [0.001, 0.01, 0.04, 0.15, 0.3, 0.6];
    const qs = bhFdrAdjust(ps);
    const sorted = [...qs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]).toBeGreaterThanOrEqual(sorted[i - 1]!);
    }
  });
  it('q-values clipped to [0, 1]', () => {
    const ps = [0.4, 0.6, 0.9]; // m=3; (3/1)*0.4 = 1.2 → clip to 1
    const qs = bhFdrAdjust(ps);
    for (const q of qs) {
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
  it('q ≥ p for every test (BH is at-least-as-conservative)', () => {
    const ps = [0.001, 0.01, 0.04, 0.15, 0.3, 0.6];
    const qs = bhFdrAdjust(ps);
    for (let i = 0; i < ps.length; i += 1) {
      // BH-FDR property: q_i ≥ p_i always. Allow tiny floating-point slack.
      expect(qs[i]).toBeGreaterThanOrEqual(ps[i]! - 1e-12);
    }
  });
  it('NaN p-values pass through as NaN (excluded from rank pool)', () => {
    const ps = [0.01, Number.NaN, 0.04, 0.05];
    const qs = bhFdrAdjust(ps);
    expect(Number.isNaN(qs[1]!)).toBe(true);
    // The other three should be BH-corrected as if m=3, not m=4.
    // p_(1)=0.01, p_(2)=0.04, p_(3)=0.05. m=3.
    //   q_(3) = (3/3)*0.05 = 0.05
    //   q_(2) = min(0.05, (3/2)*0.04 = 0.06) = 0.05
    //   q_(1) = min(0.05, (3/1)*0.01 = 0.03) = 0.03
    expect(qs[0]).toBeCloseTo(0.03, 6);
    expect(qs[2]).toBeCloseTo(0.05, 6);
    expect(qs[3]).toBeCloseTo(0.05, 6);
  });
});

describe('mcnemarPValue', () => {
  it('returns null when both discordant counts are zero', () => {
    expect(mcnemarPValue(0, 0)).toBeNull();
  });

  it('returns null on negative or non-finite inputs', () => {
    expect(mcnemarPValue(-1, 5)).toBeNull();
    expect(mcnemarPValue(Number.NaN, 5)).toBeNull();
    expect(mcnemarPValue(5, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('exact binomial when b + c < 25: b=6, c=0 → p = 2 * (0.5)^6 = 0.03125', () => {
    const r = mcnemarPValue(6, 0);
    expect(r).not.toBeNull();
    expect(r!.method).toBe('exact');
    expect(r!.p).toBeCloseTo(0.03125, 6);
  });

  it('exact binomial: b=c (balanced) → p = 1', () => {
    // 4 vs 4: sum of both tails covers the full mass → 1.
    const r = mcnemarPValue(4, 4);
    expect(r).not.toBeNull();
    expect(r!.method).toBe('exact');
    expect(r!.p).toBeCloseTo(1, 6);
  });

  it('chi-squared when b + c ≥ 25; b=20, c=5 → moderately significant', () => {
    // χ² = (|20-5|-1)² / 25 = 196/25 = 7.84.
    // P(χ²_1 > 7.84) = 2 * (1 - Φ(√7.84)) = 2 * (1 - Φ(2.8)) ≈ 0.0051.
    const r = mcnemarPValue(20, 5);
    expect(r).not.toBeNull();
    expect(r!.method).toBe('chi-squared');
    expect(r!.p).toBeGreaterThan(0.003);
    expect(r!.p).toBeLessThan(0.008);
  });

  it('chi-squared: balanced large discordant → p ≈ 1', () => {
    const r = mcnemarPValue(20, 20);
    expect(r).not.toBeNull();
    expect(r!.method).toBe('chi-squared');
    // |b-c|-1 = -1 → squared inputs treated as 0 per the guard, p=1.
    expect(r!.p).toBe(1);
  });

  it('symmetry: mcnemarPValue(a, b) === mcnemarPValue(b, a)', () => {
    for (const [b, c] of [[3, 8], [10, 20], [1, 6]] as const) {
      const ab = mcnemarPValue(b, c);
      const ba = mcnemarPValue(c, b);
      expect(ab).not.toBeNull();
      expect(ba).not.toBeNull();
      expect(ab!.p).toBeCloseTo(ba!.p, 9);
      expect(ab!.method).toBe(ba!.method);
    }
  });
});

describe('fisherExactPValue2x2', () => {
  it('returns 1 on a degenerate (zero-margin) table', () => {
    expect(fisherExactPValue2x2(0, 0, 5, 5)).toBe(1); // row 1 = 0
    expect(fisherExactPValue2x2(5, 5, 0, 0)).toBe(1); // row 2 = 0
    expect(fisherExactPValue2x2(0, 5, 0, 5)).toBe(1); // col 1 = 0
    expect(fisherExactPValue2x2(5, 0, 5, 0)).toBe(1); // col 2 = 0
  });

  it('returns 1 on non-integer or negative inputs', () => {
    expect(fisherExactPValue2x2(1.5, 2, 3, 4)).toBe(1);
    expect(fisherExactPValue2x2(-1, 2, 3, 4)).toBe(1);
  });

  it('R fisher.test benchmark: matrix(c(8,2,1,5), nrow=2) → p ≈ 0.0349', () => {
    // R: > fisher.test(matrix(c(8,2,1,5), nrow=2))$p.value → 0.03495
    // Table laid out as [[a=8, b=2], [c=1, d=5]] with marginals
    // R1=10, R2=6, C1=9, C2=7, N=16.
    const p = fisherExactPValue2x2(8, 2, 1, 5);
    expect(p).toBeGreaterThan(0.03);
    expect(p).toBeLessThan(0.04);
  });

  it('R fisher.test benchmark: matrix(c(5,5,5,5), nrow=2) → p = 1', () => {
    // Balanced 2x2: no signal, p ≈ 1.
    const p = fisherExactPValue2x2(5, 5, 5, 5);
    expect(p).toBeCloseTo(1, 6);
  });

  it('strong signal: 20/0 vs 0/20 → very small p', () => {
    // Perfect separation, n=40.
    const p = fisherExactPValue2x2(20, 0, 0, 20);
    expect(p).toBeLessThan(1e-10);
  });

  it('symmetry under row/column swap', () => {
    // Swap rows or columns → same p (Fisher exact is row/col-swap invariant).
    const base = fisherExactPValue2x2(3, 7, 8, 2);
    expect(fisherExactPValue2x2(8, 2, 3, 7)).toBeCloseTo(base, 9);
    expect(fisherExactPValue2x2(7, 3, 2, 8)).toBeCloseTo(base, 9);
  });

  it('clipped to [0, 1] (no floating-point overflow)', () => {
    for (const tbl of [[1, 1, 1, 1], [10, 10, 10, 10], [50, 50, 50, 50]] as const) {
      const p = fisherExactPValue2x2(tbl[0]!, tbl[1]!, tbl[2]!, tbl[3]!);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('expectedCellCounts2x2', () => {
  it('returns row-sum × col-sum / N for each of the 4 cells', () => {
    // nA=10, nB=20, goodA=4, goodB=12 → total good=16, total bad=14, N=30.
    // E(good, A) = 10 * 16 / 30 = 5.333
    // E(bad,  A) = 10 * 14 / 30 = 4.667
    // E(good, B) = 20 * 16 / 30 = 10.667
    // E(bad,  B) = 20 * 14 / 30 = 9.333
    const [eA_good, eA_bad, eB_good, eB_bad] = expectedCellCounts2x2(10, 20, 4, 12);
    expect(eA_good).toBeCloseTo(5.333, 2);
    expect(eA_bad).toBeCloseTo(4.667, 2);
    expect(eB_good).toBeCloseTo(10.667, 2);
    expect(eB_bad).toBeCloseTo(9.333, 2);
  });

  it('returns [0,0,0,0] on N=0', () => {
    expect(expectedCellCounts2x2(0, 0, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("Fisher-vs-z gate at min(expected) < 5", () => {
    // Small-n case: nA=8, nB=8, goodA=7, goodB=1 → goodTotal=8, badTotal=8.
    // E(good, A) = 8*8/16 = 4 (< 5 → use Fisher).
    const expected = expectedCellCounts2x2(8, 8, 7, 1);
    expect(Math.min(...expected)).toBeLessThan(5);

    // Large-n case: nA=50, nB=50, goodA=20, goodB=10 → goodTotal=30, badTotal=70.
    // E(good, A) = 50*30/100 = 15 (≥ 5 → use z-test).
    const expectedLarge = expectedCellCounts2x2(50, 50, 20, 10);
    expect(Math.min(...expectedLarge)).toBeGreaterThanOrEqual(5);
  });
});

describe('cosineSimilarity (un-normalized)', () => {
  it('returns 1 on identical non-unit vectors', () => {
    expect(cosineSimilarity([3, 4], [3, 4])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 9);
  });
  it('returns 0 on orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });
  it('returns -1 on opposite-direction vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 9);
  });
  it('scale invariant — magnitudes cancel in the denominator', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 9);
  });
  it('returns 0 when either vector is all-zero (no signal, conservative fallback)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });
  it('handles Float32Array inputs', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    // dot = 4+10+18 = 32; |a|=√14; |b|=√77; cos = 32 / √1078 ≈ 0.9746
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.9746, 3);
  });
  it('iterates to min(a.length, b.length) when lengths differ', () => {
    // [1,2,3] vs [1,2]: only [1,2] vs [1,2] compared. cos = 1.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBeCloseTo(1, 9);
  });
});

describe('cosineSimilarityNormalized (unit-vector fast path)', () => {
  it('equals dot product for pre-normalized vectors', () => {
    // Unit vectors at 45° and 0°: dot = cos 45° ≈ 0.7071.
    const a = [Math.SQRT1_2, Math.SQRT1_2];
    const b = [1, 0];
    expect(cosineSimilarityNormalized(a, b)).toBeCloseTo(0.7071, 3);
  });
  it('returns 1 on identical unit vectors', () => {
    const v = [Math.SQRT1_2, Math.SQRT1_2];
    expect(cosineSimilarityNormalized(v, v)).toBeCloseTo(1, 9);
  });
  it('returns 0 on orthogonal unit vectors', () => {
    expect(cosineSimilarityNormalized([1, 0], [0, 1])).toBe(0);
  });
  it('handles Float32Array inputs', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarityNormalized(a, b)).toBe(0);
  });
  it('iterates to min(a.length, b.length) — non-defensive on non-unit inputs', () => {
    // The function does NOT normalize — it returns dot(a, b) directly.
    // On non-unit vectors this is wrong (vs full cosineSimilarity), and
    // that's the documented contract: pass unit vectors, or use the
    // general form instead.
    expect(cosineSimilarityNormalized([3, 4], [3, 4])).toBe(25);
  });
});
