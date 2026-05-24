import { describe, it, expect } from 'vitest';
import {
  euclidean,
  ewma,
  matchedPair1NN,
  mean,
  sigmoid,
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
