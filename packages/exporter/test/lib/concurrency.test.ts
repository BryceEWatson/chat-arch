import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from '../../src/lib/concurrency.js';

describe('runWithConcurrency', () => {
  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];
    await runWithConcurrency(items, 8, async (item) => {
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('never exceeds the concurrency limit', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    await runWithConcurrency(items, 4, async () => {
      active += 1;
      if (active > peak) peak = active;
      // Yield to let other workers schedule — ensures the check sees concurrency.
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // sanity: we actually used parallelism
  });

  it('handles items.length smaller than the limit without spawning idle workers', async () => {
    const items = [1, 2];
    const seen: number[] = [];
    await runWithConcurrency(items, 16, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('is a no-op on empty input', async () => {
    let called = 0;
    await runWithConcurrency<number>([], 8, async () => {
      called += 1;
    });
    expect(called).toBe(0);
  });
});
