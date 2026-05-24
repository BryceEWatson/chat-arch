import { describe, it, expect } from 'vitest';
import { mulberry32, umapProject } from './umapProject.js';

describe('mulberry32', () => {
  it('is deterministic given the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i += 1) {
      expect(a()).toBe(b());
    }
  });

  it('produces different streams for different seeds', () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toBe(b);
  });

  it('returns values in [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('umapProject', () => {
  it('returns empty when given no vectors', async () => {
    const result = await umapProject([], { random: mulberry32(42) });
    expect(result).toEqual([]);
  });

  it(
    'produces unit-length rows when l2NormalizeOutput is true',
    async () => {
      // Build a small synthetic input — UMAP needs ≥ nNeighbors+1 rows
      // to fit, and the projection itself isn't what we're testing
      // (the library's job). We just want to verify the post-norm step.
      const dim = 8;
      const n = 12;
      const vectors: Float32Array[] = [];
      const rng = mulberry32(11);
      for (let i = 0; i < n; i += 1) {
        const v = new Float32Array(dim);
        for (let d = 0; d < dim; d += 1) v[d] = rng() - 0.5;
        vectors.push(v);
      }
      const out = await umapProject(vectors, {
        random: mulberry32(11),
        nNeighbors: 4,
        nComponents: 3,
        l2NormalizeOutput: true,
      });
      expect(out).toHaveLength(n);
      for (const row of out) {
        let sumSq = 0;
        for (const x of row) sumSq += x * x;
        // Allow a generous epsilon for float rounding across ~3 dims.
        expect(Math.abs(Math.sqrt(sumSq) - 1)).toBeLessThan(1e-6);
      }
    },
    30000,
  );

  it(
    'does NOT normalize by default (preserves prior behaviour)',
    async () => {
      const dim = 8;
      const n = 12;
      const vectors: Float32Array[] = [];
      const rng = mulberry32(13);
      for (let i = 0; i < n; i += 1) {
        const v = new Float32Array(dim);
        for (let d = 0; d < dim; d += 1) v[d] = rng() - 0.5;
        vectors.push(v);
      }
      const out = await umapProject(vectors, {
        random: mulberry32(13),
        nNeighbors: 4,
        nComponents: 3,
      });
      // We can't assert exact magnitudes (UMAP-internal), but at least
      // one row should be non-unit if the flag is off — UMAP outputs are
      // not natively unit-norm.
      let anyNonUnit = false;
      for (const row of out) {
        let sumSq = 0;
        for (const x of row) sumSq += x * x;
        if (Math.abs(Math.sqrt(sumSq) - 1) > 1e-3) {
          anyNonUnit = true;
          break;
        }
      }
      expect(anyNonUnit).toBe(true);
    },
    30000,
  );
});
