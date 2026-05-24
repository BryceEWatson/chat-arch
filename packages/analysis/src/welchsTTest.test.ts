// Tests for Phase Rev3-G G1 Welch's t-test.

import { describe, expect, it } from 'vitest';

import { welchsTTest } from './welchsTTest.js';

describe('welchsTTest', () => {
  describe('basic correctness', () => {
    it('returns t=0 when samples have identical means + variances', () => {
      const r = welchsTTest([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
      expect(r.valid).toBe(true);
      expect(r.delta).toBe(0);
      expect(r.t).toBe(0);
      expect(r.pValueTwoSided).toBeCloseTo(1, 5);
    });

    it('detects a large mean difference (highly significant)', () => {
      // sample1 mean=10, sample2 mean=1; |t| should be very large.
      const s1 = [9.5, 10, 10.5, 9.8, 10.2];
      const s2 = [0.5, 1, 1.5, 0.8, 1.2];
      const r = welchsTTest(s1, s2);
      expect(r.valid).toBe(true);
      expect(r.delta).toBeCloseTo(9, 1);
      expect(Math.abs(r.t)).toBeGreaterThan(20);
      expect(r.pValueTwoSided).toBeLessThan(0.001);
    });

    it('detects a small but real mean difference (moderately significant)', () => {
      // Differences in mean by ~0.5 with low variance, n=10 each.
      const s1 = [1.0, 1.1, 0.9, 1.0, 1.0, 1.1, 0.9, 1.0, 1.1, 0.9];
      const s2 = [1.5, 1.6, 1.4, 1.5, 1.5, 1.6, 1.4, 1.5, 1.6, 1.4];
      const r = welchsTTest(s1, s2);
      expect(r.valid).toBe(true);
      expect(Math.abs(r.delta)).toBeCloseTo(0.5, 1);
      // |t| should exceed 1.96 (5% sig) easily.
      expect(Math.abs(r.t)).toBeGreaterThan(1.96);
    });

    it('does NOT detect a difference smaller than noise', () => {
      // Overlapping samples with high variance, small means; |t| < 1.
      const s1 = [1, 5, 0, 8, -2, 4, 3, 6, -1, 7];
      const s2 = [2, 4, -1, 7, 1, 5, 2, 6, 0, 8];
      const r = welchsTTest(s1, s2);
      expect(r.valid).toBe(true);
      expect(Math.abs(r.t)).toBeLessThan(1);
    });
  });

  describe('defensive contract', () => {
    it('returns valid=false when either sample has n<2', () => {
      expect(welchsTTest([1], [1, 2, 3]).valid).toBe(false);
      expect(welchsTTest([1, 2, 3], []).valid).toBe(false);
      expect(welchsTTest([], []).valid).toBe(false);
    });

    it('returns valid=false when both variances zero AND means equal', () => {
      const r = welchsTTest([5, 5, 5], [5, 5, 5]);
      expect(r.valid).toBe(false);
      expect(r.t).toBe(0);
    });

    it('returns clamped-Infinity t when both variances zero but means differ', () => {
      const r = welchsTTest([5, 5, 5], [10, 10, 10]);
      expect(r.valid).toBe(true);
      expect(r.t).toBe(Number.MAX_SAFE_INTEGER);
      expect(r.delta).toBe(-5);
      expect(r.pValueTwoSided).toBe(0);
    });

    it('does NOT throw on degenerate inputs', () => {
      expect(() => welchsTTest([], [1, 2])).not.toThrow();
      expect(() => welchsTTest([NaN, 2], [3, 4])).not.toThrow();
    });
  });

  describe('Welch–Satterthwaite df', () => {
    it('approximately equals smaller-n - 1 when one sample dominates variance', () => {
      // Sample 2 has much higher variance and small n → df should
      // be close to n2 - 1.
      const s1 = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]; // n=10, low var
      const s2 = [0, 100, 200]; // n=3, high var
      const r = welchsTTest(s1, s2);
      expect(r.valid).toBe(true);
      // df should be in the small-n regime (well below 18 = n1+n2-2).
      expect(r.degreesOfFreedom).toBeLessThan(5);
    });
  });

  describe('p-value direction', () => {
    it('p-value is the same regardless of argument order (two-sided)', () => {
      const r1 = welchsTTest([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
      const r2 = welchsTTest([6, 7, 8, 9, 10], [1, 2, 3, 4, 5]);
      expect(r1.pValueTwoSided).toBeCloseTo(r2.pValueTwoSided, 10);
      expect(r1.t).toBeCloseTo(-r2.t, 10);
    });
  });
});
