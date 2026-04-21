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
});
