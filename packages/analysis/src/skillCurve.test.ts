import { describe, it, expect } from 'vitest';
import {
  analyzeSkillCurves,
  mannKendall,
  type SkillCurveSeries,
} from './skillCurve.js';
import { bhFdrAdjust } from './stats.js';

describe('mannKendall', () => {
  it('S=6 for [1,2,3,4] (4 points → 6 pairs, all increasing)', () => {
    // Spec sanity-check: documented in the task brief.
    const out = mannKendall([1, 2, 3, 4]);
    expect(out.S).toBe(6);
  });

  it('S=-6 for [4,3,2,1] (all decreasing)', () => {
    const out = mannKendall([4, 3, 2, 1]);
    expect(out.S).toBe(-6);
  });

  it('S=0 and z=0 on a constant series', () => {
    const out = mannKendall([5, 5, 5, 5, 5]);
    expect(out.S).toBe(0);
    // varS is zero on constant series — z is NaN by design.
    expect(Number.isNaN(out.z)).toBe(true);
  });

  it('produces a small p-value for a long monotone series', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = mannKendall(xs);
    expect(out.S).toBe(45); // 10 choose 2
    expect(out.p).toBeLessThan(0.01);
  });
});

// bhFdrAdjust now lives in stats.ts; full coverage in stats.test.ts.
// Keep one canonical textbook-example check here so the skillCurve
// consumer's expected behavior stays anchored in the file the
// kernel lives in.
describe('bhFdrAdjust (via stats.ts; consumed by analyzeSkillCurves)', () => {
  it('matches the textbook example {0.001, 0.01, 0.05} → step-up', () => {
    // Family of m=3 tests, raw p = {0.001, 0.01, 0.05}.
    // BH adjusted = {min(0.001*3/1)=0.003, min(0.01*3/2)=0.015, min(0.05*3/3)=0.05}.
    const adj = bhFdrAdjust([0.001, 0.01, 0.05]);
    expect(adj[0]).toBeCloseTo(0.003, 4);
    expect(adj[1]).toBeCloseTo(0.015, 4);
    expect(adj[2]).toBeCloseTo(0.05, 4);
  });
});

describe('analyzeSkillCurves', () => {
  it('classifies a monotone-decreasing series as Learning', () => {
    // Eight weeks, strictly decreasing ask-count.
    const series: SkillCurveSeries = {
      topicId: 'learn-1',
      label: 'auth basics',
      points: [
        { week: 'W1', askCount: 20, activeSessions: 30 },
        { week: 'W2', askCount: 18, activeSessions: 30 },
        { week: 'W3', askCount: 16, activeSessions: 30 },
        { week: 'W4', askCount: 13, activeSessions: 30 },
        { week: 'W5', askCount: 10, activeSessions: 30 },
        { week: 'W6', askCount: 7, activeSessions: 30 },
        { week: 'W7', askCount: 4, activeSessions: 30 },
        { week: 'W8', askCount: 1, activeSessions: 30 },
      ],
    };
    const out = analyzeSkillCurves([series]);
    expect(out.length).toBe(1);
    expect(out[0]!.classification).toBe('Learning');
    expect(out[0]!.mannKendallS).toBeLessThan(0);
    expect(out[0]!.pValueAdjusted).toBeLessThan(0.1);
  });

  it('classifies a flat high-frequency series as Stuck-dependent', () => {
    // Two series — one high-rate flat (should be Stuck), one low-rate flat (should be Steady).
    const high: SkillCurveSeries = {
      topicId: 'stuck-high',
      points: [
        { week: 'W1', askCount: 10, activeSessions: 10 },
        { week: 'W2', askCount: 10, activeSessions: 10 },
        { week: 'W3', askCount: 10, activeSessions: 10 },
        { week: 'W4', askCount: 10, activeSessions: 10 },
        { week: 'W5', askCount: 10, activeSessions: 10 },
        { week: 'W6', askCount: 10, activeSessions: 10 },
      ],
    };
    const low: SkillCurveSeries = {
      topicId: 'steady-low',
      points: [
        { week: 'W1', askCount: 1, activeSessions: 10 },
        { week: 'W2', askCount: 1, activeSessions: 10 },
        { week: 'W3', askCount: 1, activeSessions: 10 },
        { week: 'W4', askCount: 1, activeSessions: 10 },
        { week: 'W5', askCount: 1, activeSessions: 10 },
        { week: 'W6', askCount: 1, activeSessions: 10 },
      ],
    };
    const out = analyzeSkillCurves([high, low]);
    const byId = new Map(out.map((r) => [r.topicId, r]));
    expect(byId.get('stuck-high')!.classification).toBe('Stuck-dependent');
    // The low-rate is at-median (median of [0.1, 1.0] is 0.55 — 0.1 < 0.55 → Steady).
    expect(byId.get('steady-low')!.classification).toBe('Steady');
  });

  it('filters out series below minWeeksPresent', () => {
    const tooShort: SkillCurveSeries = {
      topicId: 'short',
      points: [
        { week: 'W1', askCount: 5, activeSessions: 10 },
        { week: 'W2', askCount: 5, activeSessions: 10 },
        { week: 'W3', askCount: 5, activeSessions: 10 },
      ], // 3 weeks < minWeeksPresent=6
    };
    const out = analyzeSkillCurves([tooShort]);
    expect(out.length).toBe(1);
    expect(out[0]!.classification).toBe('Insufficient');
    expect(Number.isNaN(out[0]!.pValue)).toBe(true);
  });

  it('carries the weekly points through to the result (both branches)', () => {
    // Regression for the empty-sparkline bug: the builder computed the
    // per-week points but the result dropped them, so the viewer always
    // rendered an empty sparkline. The result must echo the input series.
    const inFamily: SkillCurveSeries = {
      topicId: 'in-family',
      points: Array.from({ length: 8 }, (_, i) => ({
        week: `W${i + 1}`,
        askCount: 8 - i,
        activeSessions: 10,
      })),
    };
    const insufficient: SkillCurveSeries = {
      topicId: 'too-short',
      points: [
        { week: 'W1', askCount: 3, activeSessions: 10 },
        { week: 'W2', askCount: 2, activeSessions: 10 },
      ], // < minWeeksPresent → Insufficient branch
    };
    const out = analyzeSkillCurves([inFamily, insufficient]);
    const byId = new Map(out.map((r) => [r.topicId, r]));

    const a = byId.get('in-family')!;
    expect(a.classification).not.toBe('Insufficient');
    expect(a.points.map((p) => p.askCount)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);

    const b = byId.get('too-short')!;
    expect(b.classification).toBe('Insufficient');
    // Even filtered-out series keep their points so the UI can still draw them.
    expect(b.points.map((p) => p.askCount)).toEqual([3, 2]);
  });

  it('applies BH-FDR across the multi-topic family', () => {
    // Three series — two declining (real signal), one flat (no signal).
    const declining1: SkillCurveSeries = {
      topicId: 'decl-1',
      points: Array.from({ length: 8 }, (_, i) => ({
        week: `W${i + 1}`,
        askCount: 20 - i * 2,
        activeSessions: 20,
      })),
    };
    const declining2: SkillCurveSeries = {
      topicId: 'decl-2',
      points: Array.from({ length: 8 }, (_, i) => ({
        week: `W${i + 1}`,
        askCount: 30 - i * 3,
        activeSessions: 20,
      })),
    };
    const flat: SkillCurveSeries = {
      topicId: 'flat',
      points: Array.from({ length: 8 }, (_, i) => ({
        week: `W${i + 1}`,
        askCount: 5 + (i % 2),
        activeSessions: 20,
      })),
    };
    const out = analyzeSkillCurves([declining1, declining2, flat]);
    // All three are in-family; BH adjusts each p-value.
    const byId = new Map(out.map((r) => [r.topicId, r]));

    // Both declining topics' adjusted p stays small (clear signal).
    expect(byId.get('decl-1')!.pValueAdjusted).toBeLessThan(0.1);
    expect(byId.get('decl-2')!.pValueAdjusted).toBeLessThan(0.1);
    expect(byId.get('decl-1')!.classification).toBe('Learning');
    expect(byId.get('decl-2')!.classification).toBe('Learning');

    // The flat topic should NOT classify as Learning.
    expect(byId.get('flat')!.classification).not.toBe('Learning');

    // BH adjustment: each topic's adjusted p should be >= its raw p.
    for (const r of out) {
      if (!Number.isNaN(r.pValue) && !Number.isNaN(r.pValueAdjusted)) {
        expect(r.pValueAdjusted).toBeGreaterThanOrEqual(r.pValue - 1e-9);
      }
    }
  });
});
