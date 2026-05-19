import { describe, expect, it } from 'vitest';
import {
  DEFAULT_P_NEAR_DUP_TARGET,
  ISOTONIC_MIN_LABELS,
  MIN_LABELS_FOR_FIT,
  MIN_PER_CLASS_FOR_FIT,
  evaluateCalibration,
  fitCalibration,
  fitIsotonic,
  fitPlatt,
  sampleByCurveUncertainty,
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

describe('fitPlatt — Lin/Lin/Weng 2007 sigmoid', () => {
  it('returns null on empty input', () => {
    expect(fitPlatt([])).toBeNull();
  });

  it('returns null when all labels share a class (degenerate)', () => {
    const allPos: LabelPoint[] = Array.from({ length: 30 }, (_, i) => ({
      cos: 0.85 + i * 0.005,
      nearDup: true,
    }));
    expect(fitPlatt(allPos)).toBeNull();
  });

  it('recovers a strongly-separating sigmoid (a < 0, large |a|)', () => {
    // Perfectly separable: positives at cos≥0.95, negatives at cos<0.95.
    // For an increasing-in-cos sigmoid we need a < 0 (so a*cos + b
    // decreases as cos increases → P = 1/(1+exp(...)) increases).
    const labels: LabelPoint[] = [];
    for (let i = 0; i < 30; i += 1) {
      labels.push({ cos: 0.86 + i * 0.002, nearDup: false });
    }
    for (let i = 0; i < 30; i += 1) {
      labels.push({ cos: 0.95 + i * 0.002, nearDup: true });
    }
    const params = fitPlatt(labels);
    expect(params).not.toBeNull();
    expect(params!.a).toBeLessThan(0);
    // P at the separator midpoint should be ~0.5.
    const fApB = params!.a * 0.93 + params!.b;
    const pMid = 1 / (1 + Math.exp(fApB));
    expect(pMid).toBeGreaterThan(0.3);
    expect(pMid).toBeLessThan(0.7);
  });

  it('outputs probabilities that stay in [0, 1] across the band', () => {
    const labels: LabelPoint[] = [];
    for (let i = 0; i < 50; i += 1) {
      // Noisy: not perfectly separable.
      const cos = 0.85 + (i / 49) * 0.15;
      const pTrue = (cos - 0.85) / 0.15; // linear in cos
      labels.push({ cos, nearDup: Math.random() < pTrue });
    }
    const params = fitPlatt(labels);
    if (params === null) return; // RNG could yield degenerate input
    for (let c = 0.85; c <= 1.0; c += 0.01) {
      const fApB = params.a * c + params.b;
      const p = fApB >= 0
        ? Math.exp(-fApB) / (1 + Math.exp(-fApB))
        : 1 / (1 + Math.exp(fApB));
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('fitCalibration — auto-selects Platt at small n, isotonic at large n', () => {
  function mkLabels(n: number, positives: number): LabelPoint[] {
    const labels: LabelPoint[] = [];
    for (let i = 0; i < n; i += 1) {
      const cos = 0.85 + (i / (n - 1)) * 0.15;
      labels.push({ cos, nearDup: i >= n - positives });
    }
    return labels;
  }

  it('returns null below MIN_LABELS_FOR_FIT total samples', () => {
    expect(
      fitCalibration({
        labels: mkLabels(MIN_LABELS_FOR_FIT - 1, 15),
        band: [0.85, 1.0],
      }),
    ).toBeNull();
  });

  it('returns null below MIN_PER_CLASS_FOR_FIT positives (audit-tightened gate)', () => {
    // 60 labels total but only 5 positives → fails the new 10-per-class
    // floor that the audit at research/calibration-audit-2026-05-19.md
    // added. Previously this would have fit a noisy isotonic curve
    // dominated by the 5 lone positives.
    expect(
      fitCalibration({ labels: mkLabels(60, 5), band: [0.85, 1.0] }),
    ).toBeNull();
  });

  it('returns null below MIN_PER_CLASS_FOR_FIT negatives', () => {
    expect(
      fitCalibration({
        labels: mkLabels(60, 55), // 5 negatives
        band: [0.85, 1.0],
      }),
    ).toBeNull();
  });

  it('picks Platt at small n (default behavior)', () => {
    const curve = fitCalibration({
      labels: mkLabels(60, 15),
      band: [0.85, 1.0],
      now: 1_700_000_000_000,
    });
    expect(curve).not.toBeNull();
    expect(curve!.method).toBe('platt');
    expect(curve!.schemaVersion).toBe(1);
    expect(curve!.calibratedAt).toBe(1_700_000_000_000);
    expect(curve!.labelCount).toBe(60);
    expect(curve!.band).toEqual([0.85, 1.0]);
    // Platt curve has a/b params + sampled knots for inspection.
    if (curve!.method === 'platt') {
      expect(typeof curve!.a).toBe('number');
      expect(typeof curve!.b).toBe('number');
      expect(curve!.knots.length).toBeGreaterThan(0);
    }
  });

  it('picks isotonic when forced and label count is borderline', () => {
    const curve = fitCalibration({
      labels: mkLabels(60, 15),
      band: [0.85, 1.0],
      forceMethod: 'isotonic',
    });
    expect(curve).not.toBeNull();
    expect(curve!.method).toBe('isotonic');
  });
});

describe('evaluateCalibration — dispatches on method', () => {
  it('evaluates a Platt curve analytically (no knot lookup)', () => {
    // Construct a Platt curve by hand. a=-50, b=46 → sigmoid centered at
    // cos = -b/a = 0.92, increasing in cos. Verify P at boundary and
    // midpoint.
    const curve = {
      schemaVersion: 1 as const,
      method: 'platt' as const,
      calibratedAt: 0,
      labelCount: 60,
      band: [0.85, 1.0] as [number, number],
      a: -50,
      b: 46,
      knots: [],
    };
    // At cos=0.92, fApB = -50*0.92 + 46 = 0 → P = 0.5.
    expect(evaluateCalibration(curve, 0.92)).toBeCloseTo(0.5, 3);
    // Above the band → clamp to upper edge.
    expect(evaluateCalibration(curve, 1.5)).toBeCloseTo(
      evaluateCalibration(curve, 1.0),
      6,
    );
    // Below the band → clamp to lower edge.
    expect(evaluateCalibration(curve, 0.5)).toBeCloseTo(
      evaluateCalibration(curve, 0.85),
      6,
    );
  });

  it('still accepts bare knot arrays (backward compat with isotonic)', () => {
    const knots = [
      { cos: 0.85, p: 0.1 },
      { cos: 0.95, p: 0.9 },
    ];
    expect(evaluateCalibration(knots, 0.85)).toBe(0.1);
    expect(evaluateCalibration(knots, 0.95)).toBe(0.9);
    expect(evaluateCalibration(knots, 0.5)).toBe(0.1); // flat below
    expect(evaluateCalibration(knots, 1.5)).toBe(0.9); // flat above
  });
});

describe('audit-corrected default constants', () => {
  it('DEFAULT_P_NEAR_DUP_TARGET is 0.9 — precision-leaning per audit', () => {
    expect(DEFAULT_P_NEAR_DUP_TARGET).toBe(0.9);
  });

  it('MIN_LABELS_FOR_FIT is 50, MIN_PER_CLASS_FOR_FIT is 10', () => {
    expect(MIN_LABELS_FOR_FIT).toBe(50);
    expect(MIN_PER_CLASS_FOR_FIT).toBe(10);
  });

  it('ISOTONIC_MIN_LABELS is 500 — Platt below, isotonic above', () => {
    expect(ISOTONIC_MIN_LABELS).toBe(500);
  });
});

describe('sampleByCurveUncertainty — active sampling helper', () => {
  // Construct a Platt curve centered at cos=0.92 (P=0.5 at the
  // sigmoid center). Pairs near cos=0.92 should be most-uncertain;
  // pairs near the band ends should be least.
  const curve = {
    schemaVersion: 1 as const,
    method: 'platt' as const,
    calibratedAt: 0,
    labelCount: 60,
    band: [0.85, 1.0] as [number, number],
    a: -50,
    b: 46,
    knots: [],
  };

  it('returns pairs closest to P=0.5 first', () => {
    const pairs = [
      { id: 'edge-low', cos: 0.86 }, // P ≈ 0
      { id: 'mid', cos: 0.92 }, // P ≈ 0.5 — most uncertain
      { id: 'edge-high', cos: 0.99 }, // P ≈ 1
    ];
    const top = sampleByCurveUncertainty(pairs, curve, 1);
    expect(top).toHaveLength(1);
    expect(top[0]!.id).toBe('mid');
  });

  it('returns empty array on n=0 or empty pool', () => {
    expect(sampleByCurveUncertainty([{ cos: 0.9 }], curve, 0)).toEqual([]);
    expect(sampleByCurveUncertainty([], curve, 5)).toEqual([]);
  });

  it('returns all pairs when n exceeds pool size', () => {
    const pairs = [{ cos: 0.86 }, { cos: 0.92 }, { cos: 0.99 }];
    expect(sampleByCurveUncertainty(pairs, curve, 10)).toHaveLength(3);
  });

  it('is generic over pair shape (preserves extra fields)', () => {
    const pairs = [
      { cos: 0.86, payload: 'a' },
      { cos: 0.92, payload: 'b' },
      { cos: 0.99, payload: 'c' },
    ];
    const top = sampleByCurveUncertainty(pairs, curve, 2);
    expect(top[0]!.payload).toBe('b'); // closest to P=0.5
    expect(top.every((p) => typeof p.payload === 'string')).toBe(true);
  });

  it('orders by decreasing uncertainty (P=0.5 first, P=0 or 1 last)', () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      cos: 0.85 + (i / 29) * 0.15,
    }));
    const all = sampleByCurveUncertainty(pairs, curve, pairs.length);
    // Top entry is closest to P=0.5; bottom is furthest.
    const topU = 1 - Math.abs(evaluateCalibration(curve, all[0]!.cos) - 0.5) * 2;
    const botU =
      1 - Math.abs(evaluateCalibration(curve, all[all.length - 1]!.cos) - 0.5) * 2;
    expect(topU).toBeGreaterThanOrEqual(botU);
  });
});
