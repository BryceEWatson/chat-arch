import { describe, expect, it } from 'vitest';
import { computeSweep, wilsonCI } from '../../src/pages/api/calibrate.js';

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
