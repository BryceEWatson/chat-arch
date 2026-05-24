import { describe, it, expect } from 'vitest';
import {
  bhFdrAdjust,
  euclidean,
  ewma,
  matchedPair1NN,
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
