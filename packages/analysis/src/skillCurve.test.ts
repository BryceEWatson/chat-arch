import { describe, it, expect } from 'vitest';
import {
  analyzeSkillCurves,
  benjaminiHochberg,
  mannKendall,
  type SkillCurveSeries,
} from './skillCurve.js';

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

describe('benjaminiHochberg', () => {
  it('returns one adjusted p per input, preserving order', () => {
    const ps = [0.01, 0.04, 0.03, 0.005];
    const adj = benjaminiHochberg(ps);
    expect(adj.length).toBe(4);
    // All adjusted p's in [0,1].
    for (const a of adj) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it('inflates p-values relative to raw under multiple comparisons', () => {
    const ps = [0.01, 0.01, 0.01, 0.01, 0.01];
    const adj = benjaminiHochberg(ps);
    // Every adjusted p should be greater than the raw (or equal, never less).
    for (let i = 0; i < ps.length; i++) {
      expect(adj[i]).toBeGreaterThanOrEqual(ps[i]!);
    }
  });

  it('matches the textbook example {0.001, 0.01, 0.05} → step-up', () => {
    // Family of m=3 tests, raw p = {0.001, 0.01, 0.05}.
    // BH adjusted = {min(0.001*3/1)=0.003, min(0.01*3/2)=0.015, min(0.05*3/3)=0.05}.
    const adj = benjaminiHochberg([0.001, 0.01, 0.05]);
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
