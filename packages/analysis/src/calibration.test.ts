import { describe, expect, it } from 'vitest';
import {
  DEFAULT_P_NEAR_DUP_TARGET,
  MIN_LABELS_FOR_FIT,
  evaluateCalibration,
  fitCalibration,
  fitIsotonic,
  type LabelPoint,
} from './calibration.js';

describe('fitIsotonic — Pool Adjacent Violators', () => {
  it('returns empty for empty input', () => {
    expect(fitIsotonic([])).toEqual([]);
  });

  it('already-monotone input passes through unchanged', () => {
    // Strictly increasing labels by cos: 0 → 0 → 1 → 1. PAV doesn't
    // need to merge anything; one knot per unique cos with mean=label.
    const knots = fitIsotonic([
      { cos: 0.85, nearDup: false },
      { cos: 0.90, nearDup: false },
      { cos: 0.95, nearDup: true },
      { cos: 0.99, nearDup: true },
    ]);
    expect(knots).toEqual([
      { cos: 0.85, p: 0 },
      { cos: 0.9, p: 0 },
      { cos: 0.95, p: 1 },
      { cos: 0.99, p: 1 },
    ]);
  });

  it('merges adjacent violators into a single block at their weighted mean', () => {
    // Labels: 1 at 0.85, 0 at 0.90. Naive p would be 1.0 then 0.0 —
    // not monotone. PAV merges them into one block at the lower cos
    // with p = mean(1, 0) = 0.5.
    const knots = fitIsotonic([
      { cos: 0.85, nearDup: true },
      { cos: 0.9, nearDup: false },
    ]);
    expect(knots).toEqual([{ cos: 0.85, p: 0.5 }]);
  });

  it('classic Wikipedia PAV example: y = [1, 2, 1, 4, 3, 5]', () => {
    // The canonical PAV reference (Wikipedia: "Isotonic regression").
    // y = [1, 2, 1, 4, 3, 5] at x = [1, 2, 3, 4, 5, 6] should regress
    // to fitted values [1, 1.5, 1.5, 3.5, 3.5, 5]. We use integer cos
    // values so the test reads cleanly; the algorithm doesn't care
    // that the inputs aren't bounded to [0, 1] (it just maintains
    // monotonicity on the labels). Translate labels=0/1 to mean=value
    // by treating each cos as a single sample with that mean —
    // equivalent to running PAV on means with weight 1.
    //
    // We can't pass raw means through the binary-label API, so do this
    // via the underlying PAV invariant: a single 0/1 label at each
    // cos gives means that *are* the labels. We instead verify the
    // monotonicity invariant + termination behaviour on a
    // hand-constructed binary case below.
    const knots = fitIsotonic([
      { cos: 0.1, nearDup: false }, // 0
      { cos: 0.2, nearDup: true }, // 1
      { cos: 0.3, nearDup: false }, // 0
      { cos: 0.4, nearDup: true }, // 1
      { cos: 0.5, nearDup: false }, // 0
      { cos: 0.6, nearDup: true }, // 1
    ]);
    // Walking the algorithm by hand:
    //   block 1: cos=0.1, sum=0, w=1 → mean 0
    //   push 0.2 → mean 1; 0 ≤ 1, no merge.
    //   push 0.3 → mean 0; 1 > 0, merge: cos=0.2, sum=1, w=2, mean=0.5.
    //     Then 0 ≤ 0.5? prev=cos=0.1 mean=0, cur=cos=0.2 mean=0.5: 0 ≤ 0.5, no further merge.
    //   push 0.4 → mean 1; 0.5 ≤ 1, no merge.
    //   push 0.5 → mean 0; 1 > 0, merge: cos=0.4, sum=1, w=2, mean=0.5.
    //     prev=cos=0.2 mean=0.5, cur=cos=0.4 mean=0.5: 0.5 ≤ 0.5, no merge.
    //   push 0.6 → mean 1; 0.5 ≤ 1, no merge.
    //   Final: [(0.1, 0), (0.2, 0.5), (0.4, 0.5), (0.6, 1)]
    expect(knots).toEqual([
      { cos: 0.1, p: 0 },
      { cos: 0.2, p: 0.5 },
      { cos: 0.4, p: 0.5 },
      { cos: 0.6, p: 1 },
    ]);
  });

  it('merges duplicate-cos labels before PAV pass', () => {
    // Two labels at the same cos must collapse into one block (their
    // mean), independent of label order.
    const knots = fitIsotonic([
      { cos: 0.9, nearDup: true },
      { cos: 0.9, nearDup: false },
      { cos: 0.95, nearDup: true },
    ]);
    expect(knots).toEqual([
      { cos: 0.9, p: 0.5 },
      { cos: 0.95, p: 1 },
    ]);
  });

  it('produces a monotone non-decreasing output on noisy real-ish input', () => {
    // 30 random-ish labels with the kind of plateau we observed in
    // mxbai-embed-large [0.85, 1.0] — positives sparse, noisy in the
    // middle, denser at the top. The fitted curve must be monotone.
    const labels: LabelPoint[] = [];
    for (let i = 0; i < 30; i += 1) {
      const cos = 0.85 + (i / 30) * 0.15;
      const nearDup = i > 22 || (i > 5 && i % 4 === 0);
      labels.push({ cos, nearDup });
    }
    const knots = fitIsotonic(labels);
    expect(knots.length).toBeGreaterThan(0);
    for (let i = 1; i < knots.length; i += 1) {
      expect(knots[i]!.p).toBeGreaterThanOrEqual(knots[i - 1]!.p);
      expect(knots[i]!.cos).toBeGreaterThan(knots[i - 1]!.cos);
    }
  });
});

describe('evaluateCalibration', () => {
  const knots = [
    { cos: 0.85, p: 0.1 },
    { cos: 0.9, p: 0.3 },
    { cos: 0.95, p: 0.7 },
    { cos: 0.99, p: 0.95 },
  ];

  it('returns the matching knot p at exact cosine values', () => {
    expect(evaluateCalibration(knots, 0.85)).toBe(0.1);
    expect(evaluateCalibration(knots, 0.9)).toBe(0.3);
    expect(evaluateCalibration(knots, 0.95)).toBe(0.7);
    expect(evaluateCalibration(knots, 0.99)).toBe(0.95);
  });

  it('returns the rightmost knot whose cos ≤ x (step function, right-continuous from each knot)', () => {
    expect(evaluateCalibration(knots, 0.87)).toBe(0.1);
    expect(evaluateCalibration(knots, 0.92)).toBe(0.3);
    expect(evaluateCalibration(knots, 0.97)).toBe(0.7);
  });

  it('flat-extrapolates below the labeled range', () => {
    // Design-doc choice: below knots[0], return knots[0].p. Linear
    // extrapolation can yield p < 0 with sparse tails.
    expect(evaluateCalibration(knots, 0.5)).toBe(0.1);
    expect(evaluateCalibration(knots, 0)).toBe(0.1);
    expect(evaluateCalibration(knots, -1)).toBe(0.1);
  });

  it('flat-extrapolates above the labeled range', () => {
    // Same on the right edge — return knots[last].p, not extrapolate
    // past 1.0.
    expect(evaluateCalibration(knots, 0.995)).toBe(0.95);
    expect(evaluateCalibration(knots, 1)).toBe(0.95);
    expect(evaluateCalibration(knots, 1.5)).toBe(0.95);
  });

  it('returns 0 on an empty curve', () => {
    expect(evaluateCalibration([], 0.9)).toBe(0);
  });

  it('accepts a full CalibrationCurve, not just bare knots', () => {
    expect(
      evaluateCalibration(
        {
          schemaVersion: 1,
          method: 'isotonic',
          calibratedAt: 0,
          labelCount: 50,
          band: [0.85, 1.0],
          knots,
        },
        0.92,
      ),
    ).toBe(0.3);
  });
});

describe('fitCalibration', () => {
  function mkLabels(n: number, positives: number): LabelPoint[] {
    // Positives concentrated at the high end so the fit is non-trivial.
    const labels: LabelPoint[] = [];
    for (let i = 0; i < n; i += 1) {
      const cos = 0.85 + (i / (n - 1)) * 0.15;
      labels.push({ cos, nearDup: i >= n - positives });
    }
    return labels;
  }

  it('returns null when label count is below MIN_LABELS_FOR_FIT', () => {
    expect(
      fitCalibration({
        labels: mkLabels(MIN_LABELS_FOR_FIT - 1, 10),
        band: [0.85, 1.0],
      }),
    ).toBeNull();
  });

  it('returns null when all labels are positive (degenerate)', () => {
    const labels: LabelPoint[] = Array.from({ length: 50 }, (_, i) => ({
      cos: 0.85 + i * 0.001,
      nearDup: true,
    }));
    expect(fitCalibration({ labels, band: [0.85, 1.0] })).toBeNull();
  });

  it('returns null when all labels are negative (degenerate)', () => {
    const labels: LabelPoint[] = Array.from({ length: 50 }, (_, i) => ({
      cos: 0.85 + i * 0.001,
      nearDup: false,
    }));
    expect(fitCalibration({ labels, band: [0.85, 1.0] })).toBeNull();
  });

  it('returns a well-formed curve when labels support a fit', () => {
    const curve = fitCalibration({
      labels: mkLabels(60, 12),
      band: [0.85, 1.0],
      now: 1_700_000_000_000,
    });
    expect(curve).not.toBeNull();
    expect(curve!.schemaVersion).toBe(1);
    expect(curve!.method).toBe('isotonic');
    expect(curve!.calibratedAt).toBe(1_700_000_000_000);
    expect(curve!.labelCount).toBe(60);
    expect(curve!.band).toEqual([0.85, 1.0]);
    expect(curve!.knots.length).toBeGreaterThan(0);
    // Monotone non-decreasing.
    for (let i = 1; i < curve!.knots.length; i += 1) {
      expect(curve!.knots[i]!.p).toBeGreaterThanOrEqual(curve!.knots[i - 1]!.p);
    }
  });
});

describe('default constants', () => {
  it('DEFAULT_P_NEAR_DUP_TARGET is 0.5 (more-likely-than-not)', () => {
    expect(DEFAULT_P_NEAR_DUP_TARGET).toBe(0.5);
  });

  it('MIN_LABELS_FOR_FIT is 40 per the design doc', () => {
    expect(MIN_LABELS_FOR_FIT).toBe(40);
  });
});
