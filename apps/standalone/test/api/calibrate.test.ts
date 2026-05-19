import { describe, expect, it } from 'vitest';
import {
  bucketIndexFor,
  computeBucketBounds,
  computeSweep,
  stratifiedSample,
  wilsonCI,
} from '../../src/pages/api/calibrate.js';

describe('calibrate — Wilson 95% CI', () => {
  // Reference values come from the standard Wilson score interval —
  // see Brown, Cai & DasGupta 2001, Table 5 ("Interval Estimation for
  // a Binomial Proportion"). For p̂=0.5, n=10, z=1.96 the canonical
  // bounds are ≈ [0.2366, 0.7634].
  it('matches the textbook reference for p̂=0.5, n=10', () => {
    const ci = wilsonCI(0.5, 10);
    expect(ci.low).toBeCloseTo(0.2366, 3);
    expect(ci.high).toBeCloseTo(0.7634, 3);
  });

  it('matches the worked example from the task brief (P=0.90, n=41)', () => {
    // The methodology pushback called out the existing precision
    // point estimate (0.90 over 41 labeled pairs) as having a 95% CI
    // of roughly [0.77, 0.96] — indistinguishable from 0.92 / 0.95.
    const ci = wilsonCI(0.9, 41);
    expect(ci.low).toBeCloseTo(0.77, 2);
    expect(ci.high).toBeCloseTo(0.96, 2);
  });

  it('clamps to [0, 1] at the boundaries', () => {
    const zero = wilsonCI(0, 5);
    expect(zero.low).toBe(0);
    expect(zero.high).toBeGreaterThan(0);
    expect(zero.high).toBeLessThanOrEqual(1);

    const one = wilsonCI(1, 5);
    expect(one.low).toBeGreaterThanOrEqual(0);
    expect(one.low).toBeLessThan(1);
    expect(one.high).toBe(1);
  });

  it('returns the no-information interval [0, 1] when n=0', () => {
    expect(wilsonCI(0.5, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('calibrate — stratified bucket sampling', () => {
  it('computeBucketBounds splits the band into equal-width buckets', () => {
    const bounds = computeBucketBounds([0.85, 1.0], 4);
    expect(bounds).toHaveLength(4);
    expect(bounds[0]!.lo).toBeCloseTo(0.85, 5);
    expect(bounds[0]!.hi).toBeCloseTo(0.8875, 5);
    expect(bounds[1]!.hi).toBeCloseTo(0.925, 5);
    expect(bounds[2]!.hi).toBeCloseTo(0.9625, 5);
    expect(bounds[3]!.hi).toBeCloseTo(1.0, 5);
    // Only the last bucket is closed on the right — the upper-edge
    // pair (cos=1.0) must land in bucket N-1, not be lost.
    expect(bounds[0]!.isLast).toBe(false);
    expect(bounds[3]!.isLast).toBe(true);
  });

  it('bucketIndexFor places cos at boundaries deterministically', () => {
    const band: [number, number] = [0.85, 1.0];
    expect(bucketIndexFor(0.85, band, 4)).toBe(0);
    expect(bucketIndexFor(0.88, band, 4)).toBe(0);
    expect(bucketIndexFor(0.9, band, 4)).toBe(1);
    expect(bucketIndexFor(0.95, band, 4)).toBe(2);
    expect(bucketIndexFor(0.99, band, 4)).toBe(3);
    expect(bucketIndexFor(1.0, band, 4)).toBe(3); // clamped to last bucket
    expect(bucketIndexFor(0.5, band, 4)).toBe(0); // clamped below
  });

  it('stratifiedSample distributes the budget evenly across buckets', () => {
    // 50 pairs per bucket (200 total) over band [0.85, 1.0], strata 4.
    // Sampling 40 with even split → 10 per bucket.
    const band: [number, number] = [0.85, 1.0];
    const pairs: Array<{
      id: string;
      a: string;
      b: string;
      aTitle: string;
      bTitle: string;
      aPreview: string;
      bPreview: string;
      cos: number;
    }> = [];
    const bucketCenters = [0.87, 0.91, 0.94, 0.98];
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 50; i++) {
        pairs.push({
          id: `b${b}-${i}`,
          a: `a${b}-${i}`,
          b: `b${b}-${i}`,
          aTitle: '',
          bTitle: '',
          aPreview: '',
          bPreview: '',
          cos: bucketCenters[b]!,
        });
      }
    }
    const sampled = stratifiedSample(pairs, 40, band, 4, 'test-seed');
    expect(sampled).toHaveLength(40);
    const perBucket = [0, 0, 0, 0];
    for (const p of sampled) perBucket[bucketIndexFor(p.cos, band, 4)]! += 1;
    expect(perBucket).toEqual([10, 10, 10, 10]);
  });

  it('stratifiedSample contributes only what a deficit bucket has', () => {
    // Bucket 3 (cos ≥ 0.9625) only has 2 pairs; target is 10. The
    // bucket should yield 2, not steal from neighbors.
    const band: [number, number] = [0.85, 1.0];
    const pairs: Array<{
      id: string;
      a: string;
      b: string;
      aTitle: string;
      bTitle: string;
      aPreview: string;
      bPreview: string;
      cos: number;
    }> = [];
    const bucketCenters = [0.87, 0.91, 0.94, 0.98];
    const bucketSupply = [50, 50, 50, 2];
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < bucketSupply[b]!; i++) {
        pairs.push({
          id: `b${b}-${i}`,
          a: '',
          b: '',
          aTitle: '',
          bTitle: '',
          aPreview: '',
          bPreview: '',
          cos: bucketCenters[b]!,
        });
      }
    }
    const sampled = stratifiedSample(pairs, 40, band, 4, 'test-seed');
    const perBucket = [0, 0, 0, 0];
    for (const p of sampled) perBucket[bucketIndexFor(p.cos, band, 4)]! += 1;
    expect(perBucket).toEqual([10, 10, 10, 2]);
    expect(sampled).toHaveLength(32);
  });
});

describe('calibrate — computeSweep emits CI alongside point estimates', () => {
  it('returns a CI band that brackets the point estimate', () => {
    // Construct a label set with a known precision at threshold 0.90:
    // 8 positive labels at cos≥0.90, 2 negative labels at cos≥0.90 →
    // P = 0.80 over n = 10.
    const labels: Record<string, { nearDup: boolean; cos: number }> = {};
    for (let i = 0; i < 8; i++) {
      labels[`pos-${i}`] = { nearDup: true, cos: 0.91 + i * 0.001 };
    }
    for (let i = 0; i < 2; i++) {
      labels[`neg-${i}`] = { nearDup: false, cos: 0.91 + i * 0.001 };
    }
    const sweep = computeSweep(labels);
    const row90 = sweep.find((r) => r.threshold === 0.9);
    expect(row90).toBeDefined();
    expect(row90!.n).toBe(10);
    expect(row90!.precision).toBe(0.8);
    // Wilson(0.8, 10) ≈ [0.49, 0.94]
    expect(row90!.ciLow).toBeLessThan(row90!.precision);
    expect(row90!.ciHigh).toBeGreaterThan(row90!.precision);
    expect(row90!.ciLow).toBeCloseTo(0.49, 1);
    expect(row90!.ciHigh).toBeCloseTo(0.94, 1);
  });
});
