import { describe, it, expect } from 'vitest';
import type {
  CompositeBinary,
  CompositeOutcome,
  CompositeOutcomesFile,
} from '@chat-arch/schema';
import { THRESHOLDS } from '../thresholds.js';
import { ewma, wilsonCI } from '../stats.js';
import {
  buildWeeklyComposite,
  computeVerdict,
  weekStart,
  type WeeklyCompositePoint,
} from './weeklyComposite.js';

const WEEK_MS = 7 * 86_400_000;
// A Sunday (2026-01-04 is a Sunday in UTC) — week starts land on it.
const SUNDAY = Date.UTC(2026, 0, 4);

function outcome(
  sessionId: string,
  score: number,
  binary: CompositeBinary,
): CompositeOutcome {
  return {
    sessionId,
    source: 'cloud',
    testPass: null,
    buildPass: null,
    prLand: null,
    noRework: null,
    affirmation: null,
    score,
    linearLogit: 0,
    binary,
    weightsHash: 'test-hash',
  };
}

function file(rows: CompositeOutcome[]): CompositeOutcomesFile {
  return {
    compositeVersion: 1,
    weightsVersion: 1,
    weights: THRESHOLDS.composite.weights,
    weightsHash: 'test-hash',
    generatedAt: 0,
    outcomes: rows,
    scannedSessionIds: rows.map((r) => r.sessionId),
  };
}

/**
 * Build `weekCount` consecutive weeks, each with `perWeek` sessions of
 * the given `binary` + `score`. Returns the file + the anchor map.
 */
function fixture(
  weekCount: number,
  perWeek: number,
  score: number,
  binary: CompositeBinary,
): { f: CompositeOutcomesFile; anchor: Map<string, number> } {
  const rows: CompositeOutcome[] = [];
  const anchor = new Map<string, number>();
  for (let w = 0; w < weekCount; w += 1) {
    const ts = SUNDAY + w * WEEK_MS + 3 * 86_400_000; // mid-week
    for (let i = 0; i < perWeek; i += 1) {
      const id = `s-${w}-${i}`;
      rows.push(outcome(id, score, binary));
      anchor.set(id, ts);
    }
  }
  return { f: file(rows), anchor };
}

describe('weekStart', () => {
  it('floors any mid-week ms to the UTC Sunday', () => {
    // Wednesday inside the SUNDAY week.
    expect(weekStart(SUNDAY + 3 * 86_400_000)).toBe(SUNDAY);
    // The Sunday itself is fixed.
    expect(weekStart(SUNDAY)).toBe(SUNDAY);
    // Saturday (last day of the week) still maps back to the Sunday.
    expect(weekStart(SUNDAY + 6 * 86_400_000 + 1)).toBe(SUNDAY);
  });
});

describe('buildWeeklyComposite — empty / null inputs', () => {
  it('returns empty series for null outcomes', () => {
    const r = buildWeeklyComposite(null, new Map());
    expect(r).toEqual({ mean: [], good: [], informativeWeeks: 0, verdict: null });
  });

  it('returns empty series when no outcomes', () => {
    const r = buildWeeklyComposite(file([]), new Map());
    expect(r.mean).toEqual([]);
    expect(r.good).toEqual([]);
    expect(r.informativeWeeks).toBe(0);
    expect(r.verdict).toBeNull();
  });

  it('skips rows with no anchor timestamp', () => {
    const r = buildWeeklyComposite(file([outcome('a', 0.9, 'good')]), new Map());
    expect(r.mean).toEqual([]);
  });

  it("skips rows with binary 'unknown' (no rate semantics)", () => {
    const anchor = new Map([['a', SUNDAY + 86_400_000]]);
    const r = buildWeeklyComposite(file([outcome('a', 0.9, 'unknown')]), anchor);
    expect(r.mean).toEqual([]);
  });
});

describe('buildWeeklyComposite — below-min-n', () => {
  it('hides the Wilson band (collapses to point) when n < minNForRate', () => {
    // 1 session in one week — below the minNForRate=8 floor.
    const { f, anchor } = fixture(1, 1, 0.9, 'good');
    const r = buildWeeklyComposite(f, anchor);
    expect(r.good).toHaveLength(1);
    const pt = r.good[0]!;
    expect(pt.ciLow).toBe(pt.value);
    expect(pt.ciHigh).toBe(pt.value);
    expect(r.informativeWeeks).toBe(0);
    // Too few informative weeks → no verdict.
    expect(r.verdict).toBeNull();
  });

  it('opens a real Wilson band once n ≥ minNForRate', () => {
    const { f, anchor } = fixture(1, THRESHOLDS.display.minNForRate, 1, 'good');
    const r = buildWeeklyComposite(f, anchor);
    const pt = r.good[0]!;
    const expected = wilsonCI(1, THRESHOLDS.display.minNForRate);
    expect(pt.ciLow).toBeCloseTo(expected.low, 10);
    expect(pt.ciHigh).toBeCloseTo(expected.high, 10);
    // p̂=1 still has a lower bound strictly below 1 under Wilson.
    expect(pt.ciLow).toBeLessThan(1);
    expect(r.informativeWeeks).toBe(1);
  });
});

describe('buildWeeklyComposite — ordering + gap-fill', () => {
  it('orders weeks ascending and fills the gap with empty buckets', () => {
    // Two weeks two slots apart (week 0 and week 2) — week 1 is a gap.
    const rows: CompositeOutcome[] = [
      outcome('w2', 0.5, 'good'),
      outcome('w0', 0.5, 'good'),
    ];
    const anchor = new Map<string, number>([
      ['w0', SUNDAY + 86_400_000],
      ['w2', SUNDAY + 2 * WEEK_MS + 86_400_000],
    ]);
    const r = buildWeeklyComposite(file(rows), anchor);
    expect(r.mean.map((p) => p.start)).toEqual([
      SUNDAY,
      SUNDAY + WEEK_MS,
      SUNDAY + 2 * WEEK_MS,
    ]);
    // The interpolated middle week is an empty (0/0) bucket.
    expect(r.mean[1]!.n).toBe(0);
    expect(r.mean[1]!.value).toBe(0);
    expect(r.good[1]!.value).toBe(0);
  });
});

describe('buildWeeklyComposite — mean + EWMA', () => {
  it('computes the per-week mean composite and EWMA-smooths it', () => {
    // Two adjacent weeks, scores 0.2 and 0.8, one session each.
    const rows = [outcome('a', 0.2, 'good'), outcome('b', 0.8, 'good')];
    const anchor = new Map<string, number>([
      ['a', SUNDAY + 86_400_000],
      ['b', SUNDAY + WEEK_MS + 86_400_000],
    ]);
    const r = buildWeeklyComposite(file(rows), anchor);
    expect(r.mean.map((p) => p.value)).toEqual([0.2, 0.8]);
    const expectedEwma = ewma([0.2, 0.8], THRESHOLDS.ewma.halfLifeWeeks);
    expect(r.mean.map((p) => p.ewma)).toEqual(expectedEwma);
    // Mean series carries a flat CI band (no Wilson on a continuous mean).
    expect(r.mean[0]!.ciLow).toBe(r.mean[0]!.value);
    expect(r.mean[0]!.ciHigh).toBe(r.mean[0]!.value);
  });
});

describe('computeVerdict', () => {
  function pt(value: number, n: number, ciLow: number, ciHigh: number): WeeklyCompositePoint {
    return { start: 0, value, ewma: value, ciLow, ciHigh, n };
  }
  const N = THRESHOLDS.display.minNForRate;

  it('returns null with fewer than 2 informative weeks', () => {
    expect(computeVerdict([])).toBeNull();
    expect(computeVerdict([pt(0.5, N, 0.4, 0.6)])).toBeNull();
    // One informative + one below-floor week → still < 2 informative.
    expect(
      computeVerdict([pt(0.5, N, 0.4, 0.6), pt(0.9, 1, 0.9, 0.9)]),
    ).toBeNull();
  });

  it("calls direction 'up' when latest CI low clears earliest CI high", () => {
    const v = computeVerdict([pt(0.2, N, 0.1, 0.3), pt(0.8, N, 0.6, 0.9)]);
    expect(v).not.toBeNull();
    expect(v!.direction).toBe('up');
    expect(v!.deltaPp).toBeCloseTo(60, 10);
    expect(v!.windowWeeks).toBe(2);
  });

  it("calls direction 'down' on the mirror case", () => {
    const v = computeVerdict([pt(0.8, N, 0.7, 0.9), pt(0.2, N, 0.1, 0.3)]);
    expect(v!.direction).toBe('down');
    expect(v!.deltaPp).toBeCloseTo(-60, 10);
  });

  it("calls direction 'flat' when the CIs overlap", () => {
    const v = computeVerdict([pt(0.5, N, 0.3, 0.7), pt(0.55, N, 0.35, 0.75)]);
    expect(v!.direction).toBe('flat');
  });

  it('caps the window at trajectory.rollingWindow informative weeks', () => {
    const big = Array.from({ length: THRESHOLDS.trajectory.rollingWindow + 5 }, () =>
      pt(0.5, N, 0.4, 0.6),
    );
    const v = computeVerdict(big);
    expect(v!.windowWeeks).toBe(THRESHOLDS.trajectory.rollingWindow);
  });
});
