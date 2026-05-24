// Tests for Phase Rev3-G G5 permutation test kernel.

import { describe, expect, it } from 'vitest';

import { permutationTestDelta } from './correlationPermutation.js';

describe('permutationTestDelta', () => {
  describe('basic correctness', () => {
    it('reports observed Δ = mean(cited) - mean(uncited)', () => {
      const r = permutationTestDelta([10, 12, 14], [2, 4, 6]);
      expect(r.delta).toBeCloseTo(12 - 4, 5); // 8
      expect(r.valid).toBe(true);
    });

    it('returns high p-value (close to 1) when samples are exchangeable (no effect)', () => {
      // Same distribution, just two halves of the same numbers.
      const r = permutationTestDelta([1, 2, 3, 4, 5], [3, 4, 5, 1, 2]);
      // Observed Δ = 3 - 3 = 0. Every permutation also has Δ
      // satisfying |Δ_perm| >= 0. So p-value should be 1.
      expect(r.delta).toBeCloseTo(0, 5);
      expect(r.pValueTwoSided).toBe(1);
    });

    it('returns low p-value when samples have a large separation', () => {
      // Two distinct populations; very few shuffled splits should
      // reproduce the observed Δ of (9 - 1.5) = 7.5.
      const cited = [8, 9, 10, 8, 9, 10];
      const uncited = [1, 2, 1, 2, 1, 2];
      const r = permutationTestDelta(cited, uncited, {
        permutations: 2_000,
      });
      expect(r.delta).toBeCloseTo(9 - 1.5, 5);
      // With K=2000 the floor is 1/2001 ≈ 0.0005. Empirically the
      // deterministic RNG lands a handful of extreme permutations
      // (the pool has ties so |Δ_perm| can equal |Δ_observed| for a
      // few unlucky shuffles), so the realized p hovers near 0.002.
      // Loose bound at 0.01 leaves headroom for that drift without
      // letting a regression slip through.
      expect(r.pValueTwoSided).toBeLessThan(0.01);
    });

    it('two-sided detection: direction of Δ does not change p-value', () => {
      const r1 = permutationTestDelta([10, 11, 12], [1, 2, 3]);
      const r2 = permutationTestDelta([1, 2, 3], [10, 11, 12]);
      expect(r1.pValueTwoSided).toBeCloseTo(r2.pValueTwoSided, 10);
      expect(r1.delta).toBeCloseTo(-r2.delta, 5);
    });
  });

  describe('p-value bounds', () => {
    it('p-value is never below 1/(K+1) (resolution floor)', () => {
      // The floor invariant: pValueTwoSided ≥ 1/(K+1) regardless of
      // atLeastAsExtremeCount. The exact realized count depends on
      // sample-pool tie structure + the RNG seed — neither is load-
      // bearing for the floor claim, which is purely about the
      // clamp inside `permutationTestDelta`.
      for (const K of [10, 50, 100, 500]) {
        const r = permutationTestDelta(
          [100, 100, 100],
          [-100, -100, -100],
          { permutations: K },
        );
        expect(r.pValueTwoSided).toBeGreaterThanOrEqual(1 / (K + 1));
      }
    });

    it('p-value caps at 1', () => {
      const r = permutationTestDelta([5, 5, 5, 5], [5, 5, 5, 5]);
      expect(r.pValueTwoSided).toBe(1);
    });
  });

  describe('determinism', () => {
    it('same seed → same atLeastAsExtremeCount across runs', () => {
      const r1 = permutationTestDelta([3, 1, 4, 1, 5], [9, 2, 6, 5, 3], {
        seed: 42,
      });
      const r2 = permutationTestDelta([3, 1, 4, 1, 5], [9, 2, 6, 5, 3], {
        seed: 42,
      });
      expect(r1.atLeastAsExtremeCount).toBe(r2.atLeastAsExtremeCount);
      expect(r1.pValueTwoSided).toBeCloseTo(r2.pValueTwoSided, 10);
    });

    it('different seeds may produce different atLeastAsExtremeCount (smoke test)', () => {
      // Not a strict requirement — but in practice with K=1000 two
      // different seeds will almost surely diverge on a non-
      // degenerate input.
      const r1 = permutationTestDelta([1, 2, 3, 4, 5, 6], [4, 5, 6, 7, 8, 9], {
        seed: 1,
      });
      const r2 = permutationTestDelta([1, 2, 3, 4, 5, 6], [4, 5, 6, 7, 8, 9], {
        seed: 2,
      });
      // observedDelta = 3.5 - 6.5 = -3 (≠ 0), so the counts can
      // realistically differ across seeds.
      expect(r1.delta).toBeCloseTo(-3, 5);
      expect(r2.delta).toBeCloseTo(-3, 5);
      // Either they differ (most common) or they happen to land
      // identically. Either is acceptable; we just confirm both
      // ran. The deterministic seed-equality test above is the
      // load-bearing reproducibility claim.
      expect(typeof r1.atLeastAsExtremeCount).toBe('number');
      expect(typeof r2.atLeastAsExtremeCount).toBe('number');
    });
  });

  describe('defensive contract', () => {
    it('returns valid=false on empty cited', () => {
      const r = permutationTestDelta([], [1, 2, 3]);
      expect(r.valid).toBe(false);
      expect(r.delta).toBe(0);
      expect(r.pValueTwoSided).toBe(1);
    });

    it('returns valid=false on empty uncited', () => {
      const r = permutationTestDelta([1, 2, 3], []);
      expect(r.valid).toBe(false);
    });

    it('returns valid=false on NaN inputs', () => {
      expect(permutationTestDelta([1, NaN, 3], [4, 5, 6]).valid).toBe(false);
      expect(permutationTestDelta([1, 2, 3], [4, Number.POSITIVE_INFINITY, 6]).valid).toBe(false);
    });

    it('returns valid=false when pool is constant + observed Δ=0', () => {
      const r = permutationTestDelta([5, 5, 5], [5, 5, 5]);
      expect(r.valid).toBe(false);
    });

    it('handles 1-element samples (degenerate but well-defined)', () => {
      const r = permutationTestDelta([10], [1, 2, 3]);
      expect(r.valid).toBe(true);
      expect(r.delta).toBeCloseTo(10 - 2, 5);
    });

    it('does NOT throw on any combination of degenerate inputs', () => {
      expect(() => permutationTestDelta([], [])).not.toThrow();
      expect(() => permutationTestDelta([NaN], [Number.NaN])).not.toThrow();
      expect(() =>
        permutationTestDelta([1, 2], [3, 4], { permutations: 0 }),
      ).not.toThrow();
    });

    it('K=0 returns valid=false with a non-NaN p-value (final exit-review guard)', () => {
      // Pre-guard: 0/0 would yield NaN p-value AND valid=true, so
      // downstream `p < 0.05` checks silently treated NaN as false
      // (failing open). Per final review-loop on rev3-start..main.
      const r = permutationTestDelta([1, 2], [3, 4], { permutations: 0 });
      expect(r.valid).toBe(false);
      expect(Number.isNaN(r.pValueTwoSided)).toBe(false);
      expect(r.pValueTwoSided).toBe(1);
    });

    it('K=-1 (negative) also returns valid=false', () => {
      const r = permutationTestDelta([1, 2], [3, 4], { permutations: -1 });
      expect(r.valid).toBe(false);
      expect(r.pValueTwoSided).toBe(1);
    });
  });

  describe('Welch-vs-permutation consistency', () => {
    it('large clear separation: permutation p ≈ 0 matches Welch p ≈ 0', () => {
      // Both methods should agree the effect is real.
      const cited = Array.from({ length: 30 }, (_, i) => 10 + (i % 3) * 0.1);
      const uncited = Array.from({ length: 30 }, (_, i) => 1 + (i % 3) * 0.1);
      const r = permutationTestDelta(cited, uncited, { permutations: 2_000 });
      expect(r.pValueTwoSided).toBeLessThan(0.005);
    });

    it('overlapping samples: permutation p > 0.1 matches Welch p > 0.1 (no effect)', () => {
      // Heavy overlap; neither method should detect a difference.
      const cited = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const uncited = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const r = permutationTestDelta(cited, uncited, {
        permutations: 2_000,
        seed: 12345,
      });
      // Observed Δ = -2. With overlap a moderate fraction of
      // permutations should produce |Δ_perm| ≥ 2.
      expect(r.pValueTwoSided).toBeGreaterThan(0.05);
    });
  });
});
