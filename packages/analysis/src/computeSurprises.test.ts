/**
 * Tests for `computeSurprises` — feed-redesign Phase A.
 *
 * Coverage shape per kind:
 *   - happy path: kernel emits the expected row + score range
 *   - negative path: kernel does NOT emit when inputs don't qualify
 *   - boundary path: threshold-exact inputs behave correctly
 *
 * Plus a determinism test (same input → same output, ordering included)
 * and a tone-segmentation sanity check.
 */

import { describe, it, expect } from 'vitest';
import type { CompositeOutcome } from '@chat-arch/schema';
import {
  computeSurprises,
  type ComputeSurprisesInput,
  type Surprise,
  type SurpriseCompositeRow,
  type SurpriseDecisionRow,
  type SurpriseKind,
  type SurpriseKnowledgeDebtRow,
  type SurpriseTrajectoryRow,
  type SurpriseWatcherEntry,
  type SurprisesOutput,
} from './computeSurprises.js';
import type { ItsResult } from './itsAnalysis.js';
import type { ReflexiveResult } from './computeReflexive.js';

// ─── Fixture helpers ───────────────────────────────────────────────

const GENERATED_AT = 1_700_000_000_000;

function comp(
  sessionId: string,
  binary: 'good' | 'bad' | 'unknown',
  score = binary === 'good' ? 0.8 : 0.3,
): CompositeOutcome {
  return {
    sessionId,
    source: 'cowork',
    testPass: null,
    buildPass: null,
    prLand: null,
    noRework: null,
    affirmation: null,
    score,
    linearLogit: 0,
    binary,
    weightsHash: 'cafebabecafebabe',
  };
}

function compositeRow(
  sessionId: string,
  updatedAt: number,
  binary: 'good' | 'bad' | 'unknown' = 'good',
  projectId?: string,
): SurpriseCompositeRow {
  return {
    sessionId,
    updatedAt,
    composite: comp(sessionId, binary),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

function trajectoryRow(
  projectId: string,
  classification: SurpriseTrajectoryRow['classification'],
  slope: number | null,
  ci: { low: number; high: number } | null,
): SurpriseTrajectoryRow {
  return {
    projectId,
    projectName: projectId,
    classification,
    slope,
    ci,
    totalSessions: 20,
    recentSessions: 5,
    bootstrapStatus: 'ok',
  };
}

function itsRow(
  sha: string,
  deltaGoodShare: number,
  qValue: number,
  subject = 'tweak claude.md',
): ItsResult {
  return {
    sha,
    ts: GENERATED_AT - 1_000_000,
    path: 'CLAUDE.md',
    subject,
    windowDays: 10,
    pre: {
      n: 20,
      meanScore: 0.5,
      goodShare: 0.5,
      goodShareCI: { low: 0.3, high: 0.7 },
    },
    post: {
      n: 20,
      meanScore: 0.5 + deltaGoodShare,
      goodShare: 0.5 + deltaGoodShare,
      goodShareCI: { low: 0.5 + deltaGoodShare - 0.1, high: 0.5 + deltaGoodShare + 0.1 },
    },
    deltaGoodShare,
    deltaCI: { low: deltaGoodShare - 0.05, high: deltaGoodShare + 0.05 },
    pValue: 0.01,
    qValue,
  };
}

function watcherHolding(
  patternId: string,
  sessionsObserved = 5,
  failureRateUpperBound95 = 0.52,
): SurpriseWatcherEntry {
  return {
    patternId,
    projectId: 'p1',
    verdict: {
      kind: 'holding',
      sessionsObserved,
      failureRateUpperBound95,
    },
  };
}

function watcherRecurring(patternId: string, narrativeId: string): SurpriseWatcherEntry {
  return {
    patternId,
    projectId: 'p1',
    verdict: {
      kind: 'recurring',
      recurrenceNarrativeId: narrativeId,
      recurrenceGeneratedAt: '2026-04-15T00:00:00Z',
    },
  };
}

function reflexive(
  meanDelta: number,
  ciLow: number,
  ciHigh: number,
  pairs: number = 5,
): ReflexiveResult {
  return {
    pairs: Array.from({ length: pairs }, (_, i) => ({
      treatedSessionId: `t-${i}`,
      controlSessionId: `c-${i}`,
      treatedGood: 1,
      controlGood: 0,
      distance: 0.1,
    })),
    pTreated: 0.5 + meanDelta / 2,
    pControl: 0.5 - meanDelta / 2,
    meanDelta,
    ci: { low: ciLow, high: ciHigh },
    eValueCIBound: 1.5,
    eValueStatus: 'computed',
    nTreated: pairs,
    nControl: pairs * 2,
    mcnemarP: 0.04,
    mcnemarMethod: 'exact',
    discordantCount: pairs,
  };
}

function debtCluster(
  id: string,
  size: number,
  confidence: 'high' | 'low' = 'high',
  canonicalQuestion = 'how do I do X',
): SurpriseKnowledgeDebtRow {
  return {
    id,
    canonicalQuestion,
    sessionIds: Array.from({ length: size }, (_, i) => `${id}-s${i}`),
    confidence,
  };
}

function decision(
  decisionId: string,
  sessionId: string,
  binaryClass: 'good' | 'bad' | 'neutral',
  compositeScore = binaryClass === 'good' ? 0.8 : 0.3,
  projectId?: string,
): SurpriseDecisionRow {
  return {
    decisionId,
    sessionId,
    compositeScore,
    binaryClass,
    label: `decision-${decisionId}`,
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

function emptyInput(overrides: Partial<ComputeSurprisesInput> = {}): ComputeSurprisesInput {
  return {
    generatedAt: GENERATED_AT,
    composites: [],
    trajectories: [],
    itsResults: [],
    patternWatchers: [],
    reflexive: null,
    decisions: [],
    knowledgeDebt: [],
    ...overrides,
  };
}

function kindsOf(surprises: readonly Surprise[]): SurpriseKind[] {
  return surprises.map((s) => s.kind);
}

// ─── Empty / smoke ─────────────────────────────────────────────────

describe('computeSurprises — empty input', () => {
  it('returns an empty surprises array on empty inputs', () => {
    const out = computeSurprises(emptyInput());
    expect(out.version).toBe(1);
    expect(out.generatedAt).toBe(GENERATED_AT);
    expect(out.surprises).toEqual([]);
  });

  it('always exposes the thresholds it used', () => {
    const out = computeSurprises(emptyInput(), { streakMin: 7 });
    expect(out.thresholds.streakMin).toBe(7);
  });

  it('snapshot includes reflexiveEValueMin (post-iter-1 sensitivity gate)', () => {
    const out = computeSurprises(emptyInput(), { reflexiveEValueMin: 2.0 });
    expect(out.thresholds.reflexiveEValueMin).toBe(2.0);
  });
});

// ─── streak ────────────────────────────────────────────────────────

describe('streak', () => {
  it('emits when trailing run >= streakMin good sessions', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s0', 1, 'bad'),
      compositeRow('s1', 2, 'good'),
      compositeRow('s2', 3, 'good'),
      compositeRow('s3', 4, 'good'),
      compositeRow('s4', 5, 'good'),
      compositeRow('s5', 6, 'good'),
    ];
    const out = computeSurprises(emptyInput({ composites }));
    const streak = out.surprises.find((s) => s.kind === 'streak');
    expect(streak).toBeDefined();
    expect(streak?.evidence.sessionIds).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(streak?.tone).toBe('positive');
  });

  it('does NOT emit when trailing run is broken by a non-good session', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s0', 1, 'good'),
      compositeRow('s1', 2, 'good'),
      compositeRow('s2', 3, 'good'),
      compositeRow('s3', 4, 'good'),
      compositeRow('s4', 5, 'good'),
      compositeRow('s5', 6, 'bad'),
    ];
    const out = computeSurprises(emptyInput({ composites }));
    expect(kindsOf(out.surprises)).not.toContain('streak');
  });

  it('boundary: exactly streakMin sessions emits, one short does not', () => {
    const five: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
      compositeRow('s4', 4, 'good'),
      compositeRow('s5', 5, 'good'),
    ];
    const four: SurpriseCompositeRow[] = five.slice(1);
    expect(
      kindsOf(computeSurprises(emptyInput({ composites: five })).surprises),
    ).toContain('streak');
    expect(
      kindsOf(computeSurprises(emptyInput({ composites: four })).surprises),
    ).not.toContain('streak');
  });

  it('respects streakMin override', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
    ];
    const out = computeSurprises(
      emptyInput({ composites }),
      { streakMin: 2 },
    );
    expect(kindsOf(out.surprises)).toContain('streak');
  });
});

// ─── trajectory-accelerating ───────────────────────────────────────

describe('trajectory-accelerating', () => {
  it('emits one row per accelerating project', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'accelerating', 0.08, { low: 0.01, high: 0.15 }),
      trajectoryRow('p2', 'accelerating', 0.04, { low: 0.005, high: 0.08 }),
      trajectoryRow('p3', 'flat', 0, { low: -0.01, high: 0.01 }),
    ];
    const out = computeSurprises(emptyInput({ trajectories }));
    const accel = out.surprises.filter((s) => s.kind === 'trajectory-accelerating');
    expect(accel).toHaveLength(2);
    expect(accel.map((s) => s.evidence.projectId).sort()).toEqual(['p1', 'p2']);
  });

  it('does NOT emit for non-accelerating projects', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'flat', 0, { low: -0.01, high: 0.01 }),
      trajectoryRow('p2', 'stalling', -0.05, { low: -0.08, high: -0.01 }),
    ];
    const out = computeSurprises(emptyInput({ trajectories }));
    expect(kindsOf(out.surprises)).not.toContain('trajectory-accelerating');
  });
});

// ─── config-helped ─────────────────────────────────────────────────

describe('config-helped', () => {
  it('emits when qValue ≤ threshold AND deltaGoodShare ≥ threshold', () => {
    const itsResults: ItsResult[] = [itsRow('abc123def', 0.2, 0.05)];
    const out = computeSurprises(emptyInput({ itsResults }));
    const helped = out.surprises.find((s) => s.kind === 'config-helped');
    expect(helped).toBeDefined();
    expect(helped?.evidence.configSha).toBe('abc123def');
  });

  it('does NOT emit when qValue is above threshold', () => {
    const itsResults: ItsResult[] = [itsRow('abc', 0.2, 0.5)];
    const out = computeSurprises(emptyInput({ itsResults }));
    expect(kindsOf(out.surprises)).not.toContain('config-helped');
  });

  it('does NOT emit when delta is below threshold', () => {
    const itsResults: ItsResult[] = [itsRow('abc', 0.05, 0.01)];
    const out = computeSurprises(emptyInput({ itsResults }));
    expect(kindsOf(out.surprises)).not.toContain('config-helped');
  });

  it('boundary: delta exactly at threshold emits', () => {
    const itsResults: ItsResult[] = [itsRow('abc', 0.15, 0.1)];
    const out = computeSurprises(emptyInput({ itsResults }));
    expect(kindsOf(out.surprises)).toContain('config-helped');
  });
});

// ─── pattern-closed / pattern-recurring ────────────────────────────

describe('pattern-closed', () => {
  it('emits for each holding watcher verdict', () => {
    const patternWatchers: SurpriseWatcherEntry[] = [
      watcherHolding('pat1', 5, 0.52),
      watcherHolding('pat2', 20, 0.16),
    ];
    const out = computeSurprises(emptyInput({ patternWatchers }));
    const closed = out.surprises.filter((s) => s.kind === 'pattern-closed');
    expect(closed).toHaveLength(2);
    // pat2 (more sessions cleared → tighter Wilson) should score higher.
    const byId = new Map(closed.map((s) => [s.evidence.narrativeId, s.score] as const));
    expect((byId.get('pat2') ?? 0)).toBeGreaterThan(byId.get('pat1') ?? 0);
  });

  it('does NOT emit for open / inconclusive verdicts', () => {
    const patternWatchers: SurpriseWatcherEntry[] = [
      { patternId: 'a', projectId: 'p1', verdict: { kind: 'open' } },
      {
        patternId: 'b',
        projectId: 'p1',
        verdict: { kind: 'inconclusive', reason: 'wall-clock-timeout' },
      },
    ];
    const out = computeSurprises(emptyInput({ patternWatchers }));
    expect(kindsOf(out.surprises)).not.toContain('pattern-closed');
  });
});

describe('pattern-recurring', () => {
  it('emits one concern per recurring verdict', () => {
    const patternWatchers: SurpriseWatcherEntry[] = [
      watcherRecurring('pat-x', 'narr-1'),
    ];
    const out = computeSurprises(emptyInput({ patternWatchers }));
    const rec = out.surprises.find((s) => s.kind === 'pattern-recurring');
    expect(rec).toBeDefined();
    expect(rec?.tone).toBe('concerning');
    expect(rec?.evidence.narrativeId).toBe('narr-1');
  });

  it('does NOT emit for non-recurring verdicts', () => {
    const patternWatchers: SurpriseWatcherEntry[] = [
      watcherHolding('pat1'),
      { patternId: 'b', projectId: 'p1', verdict: { kind: 'open' } },
    ];
    const out = computeSurprises(emptyInput({ patternWatchers }));
    expect(kindsOf(out.surprises)).not.toContain('pattern-recurring');
  });
});

// ─── reflexive-positive ────────────────────────────────────────────

describe('reflexive-positive', () => {
  it('emits when meanDelta ≥ threshold AND CI strictly positive', () => {
    const out = computeSurprises(
      emptyInput({ reflexive: reflexive(0.2, 0.05, 0.35) }),
    );
    expect(kindsOf(out.surprises)).toContain('reflexive-positive');
  });

  it('does NOT emit when reflexive is null', () => {
    const out = computeSurprises(emptyInput({ reflexive: null }));
    expect(kindsOf(out.surprises)).not.toContain('reflexive-positive');
  });

  it('does NOT emit when CI straddles zero (low ≤ 0)', () => {
    const out = computeSurprises(
      emptyInput({ reflexive: reflexive(0.2, -0.01, 0.4) }),
    );
    expect(kindsOf(out.surprises)).not.toContain('reflexive-positive');
  });

  it('does NOT emit when meanDelta is below threshold', () => {
    const out = computeSurprises(
      emptyInput({ reflexive: reflexive(0.05, 0.01, 0.09) }),
    );
    expect(kindsOf(out.surprises)).not.toContain('reflexive-positive');
  });

  it('boundary: meanDelta exactly at threshold emits', () => {
    const out = computeSurprises(
      emptyInput({ reflexive: reflexive(0.1, 0.01, 0.19) }),
    );
    expect(kindsOf(out.surprises)).toContain('reflexive-positive');
  });

  it('does NOT emit when eValueStatus is not "computed" (CI straddles null)', () => {
    // Even with strong meanDelta + positive CI, an inability to
    // compute the E-value kills emission.
    const r = reflexive(0.2, 0.05, 0.35);
    const out = computeSurprises(
      emptyInput({
        reflexive: { ...r, eValueStatus: 'ci-straddles-null', eValueCIBound: null },
      }),
    );
    expect(kindsOf(out.surprises)).not.toContain('reflexive-positive');
  });

  it('does NOT emit when eValueCIBound is below the reflexiveEValueMin floor', () => {
    const r = reflexive(0.2, 0.05, 0.35);
    const out = computeSurprises(
      emptyInput({
        reflexive: { ...r, eValueStatus: 'computed', eValueCIBound: 1.49 },
      }),
      { reflexiveEValueMin: 1.5 },
    );
    expect(kindsOf(out.surprises)).not.toContain('reflexive-positive');
  });

  it('summary uses associational language ("is associated with"), not causal ("lifted")', () => {
    const out = computeSurprises(
      emptyInput({ reflexive: reflexive(0.2, 0.05, 0.35) }),
    );
    const reflexivePos = out.surprises.find((s) => s.kind === 'reflexive-positive');
    expect(reflexivePos).toBeDefined();
    expect(reflexivePos?.summary).toMatch(/associated with/);
    expect(reflexivePos?.summary).not.toMatch(/lifted/);
    // E-value surfaces in the summary so the user sees the sensitivity bound.
    expect(reflexivePos?.summary).toMatch(/E-value/);
  });
});

// ─── decision-paid-off ─────────────────────────────────────────────

describe('decision-paid-off', () => {
  // Helper: build a "noisy corpus" of mostly-bad in OTHER projects so
  // the base good-share stays well below the followup rate.
  //
  // The Wilson-low > base-rate gate is tight: 5/5 same-project good
  // followups gives Wilson low ≈ 0.566 (α=0.05). The corpus base rate
  // must clear ≤ ≈ 0.5 for the gate to pass at this followup count.
  // 2 good + 10 bad in 'noise' → 12 noise sessions, base rate including
  // the 1 decision-good + 5 followup-good = 8/18 ≈ 0.444.
  function noiseCorpus(): SurpriseCompositeRow[] {
    const out: SurpriseCompositeRow[] = [];
    for (let i = 0; i < 2; i += 1) {
      out.push(compositeRow(`n-good-${i}`, 100 + i, 'good', 'noise'));
    }
    for (let i = 0; i < 10; i += 1) {
      out.push(compositeRow(`n-bad-${i}`, 120 + i, 'bad', 'noise'));
    }
    return out;
  }

  it('emits when a good-binary decision is followed by ≥ K same-project good sessions', () => {
    const composites: SurpriseCompositeRow[] = [
      ...noiseCorpus(),
      compositeRow('s-dec', 10, 'good', 'p1'),
      compositeRow('s-a1', 11, 'good', 'p1'),
      compositeRow('s-a2', 12, 'good', 'p1'),
      compositeRow('s-a3', 13, 'good', 'p1'),
      compositeRow('s-a4', 14, 'good', 'p1'),
      compositeRow('s-a5', 15, 'good', 'p1'),
    ];
    const decisions: SurpriseDecisionRow[] = [
      decision('d1', 's-dec', 'good', 0.8, 'p1'),
    ];
    const out = computeSurprises(emptyInput({ composites, decisions }));
    const paidOff = out.surprises.find((s) => s.kind === 'decision-paid-off');
    expect(paidOff).toBeDefined();
    expect(paidOff?.evidence.decisionId).toBe('d1');
    // Summary surfaces the lift metrics (K/N + Wilson-low + base-rate).
    expect(paidOff?.summary).toMatch(/same-project followups: 5\/5 good/);
    expect(paidOff?.summary).toMatch(/Wilson low/);
    expect(paidOff?.summary).toMatch(/base rate/);
  });

  it('does NOT emit when binaryClass is not "good"', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s-dec', 10, 'bad', 'p1'),
      compositeRow('s-a1', 11, 'good', 'p1'),
      compositeRow('s-a2', 12, 'good', 'p1'),
    ];
    const decisions: SurpriseDecisionRow[] = [
      decision('d1', 's-dec', 'bad', 0.3, 'p1'),
    ];
    const out = computeSurprises(emptyInput({ composites, decisions }));
    expect(kindsOf(out.surprises)).not.toContain('decision-paid-off');
  });

  it('does NOT emit when same-project followups < threshold', () => {
    const composites: SurpriseCompositeRow[] = [
      ...noiseCorpus(),
      compositeRow('s-dec', 10, 'good', 'p1'),
      compositeRow('s-a1', 11, 'good', 'p1'),
      // only 1 same-project followup; threshold is 5
    ];
    const decisions: SurpriseDecisionRow[] = [
      decision('d1', 's-dec', 'good', 0.8, 'p1'),
    ];
    const out = computeSurprises(emptyInput({ composites, decisions }));
    expect(kindsOf(out.surprises)).not.toContain('decision-paid-off');
  });

  it('boundary: exactly threshold followups in-project emits', () => {
    const composites: SurpriseCompositeRow[] = [
      ...noiseCorpus(),
      compositeRow('s-dec', 10, 'good', 'p1'),
      compositeRow('s-a1', 11, 'good', 'p1'),
      compositeRow('s-a2', 12, 'good', 'p1'),
      compositeRow('s-a3', 13, 'good', 'p1'),
      compositeRow('s-a4', 14, 'good', 'p1'),
      compositeRow('s-a5', 15, 'good', 'p1'),
    ];
    const decisions: SurpriseDecisionRow[] = [
      decision('d1', 's-dec', 'good', 0.8, 'p1'),
    ];
    const out = computeSurprises(emptyInput({ composites, decisions }));
    expect(kindsOf(out.surprises)).toContain('decision-paid-off');
  });

  it('does NOT count cross-project followups toward the threshold', () => {
    // 5 good sessions follow the decision-session but in a DIFFERENT
    // project — the prior cross-corpus version would have emitted.
    const composites: SurpriseCompositeRow[] = [
      ...noiseCorpus(),
      compositeRow('s-dec', 10, 'good', 'p1'),
      compositeRow('s-x1', 11, 'good', 'p-other'),
      compositeRow('s-x2', 12, 'good', 'p-other'),
      compositeRow('s-x3', 13, 'good', 'p-other'),
      compositeRow('s-x4', 14, 'good', 'p-other'),
      compositeRow('s-x5', 15, 'good', 'p-other'),
    ];
    const decisions: SurpriseDecisionRow[] = [
      decision('d1', 's-dec', 'good', 0.8, 'p1'),
    ];
    const out = computeSurprises(emptyInput({ composites, decisions }));
    expect(kindsOf(out.surprises)).not.toContain('decision-paid-off');
  });

  it('does NOT emit when decision has no projectId (cannot scope followups)', () => {
    const composites: SurpriseCompositeRow[] = [
      ...noiseCorpus(),
      compositeRow('s-dec', 10, 'good', 'p1'),
      compositeRow('s-a1', 11, 'good', 'p1'),
      compositeRow('s-a2', 12, 'good', 'p1'),
      compositeRow('s-a3', 13, 'good', 'p1'),
      compositeRow('s-a4', 14, 'good', 'p1'),
      compositeRow('s-a5', 15, 'good', 'p1'),
    ];
    // Decision row deliberately missing projectId.
    const decisions: SurpriseDecisionRow[] = [
      decision('d1', 's-dec', 'good', 0.8 /* no projectId */),
    ];
    const out = computeSurprises(emptyInput({ composites, decisions }));
    expect(kindsOf(out.surprises)).not.toContain('decision-paid-off');
  });

  it('does NOT emit when Wilson low does not exceed base good-share', () => {
    // Corpus is all-good (base rate 1.0). 5/5 good followups → Wilson
    // low ≈ 0.566 — below 1.0. The lift gate kills the surprise even
    // though the count floor is met.
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s-dec', 10, 'good', 'p1'),
      compositeRow('s-a1', 11, 'good', 'p1'),
      compositeRow('s-a2', 12, 'good', 'p1'),
      compositeRow('s-a3', 13, 'good', 'p1'),
      compositeRow('s-a4', 14, 'good', 'p1'),
      compositeRow('s-a5', 15, 'good', 'p1'),
    ];
    const decisions: SurpriseDecisionRow[] = [
      decision('d1', 's-dec', 'good', 0.8, 'p1'),
    ];
    const out = computeSurprises(emptyInput({ composites, decisions }));
    expect(kindsOf(out.surprises)).not.toContain('decision-paid-off');
  });
});

// ─── trajectory-stalled ────────────────────────────────────────────

describe('trajectory-stalled', () => {
  it('emits for stalling and stalled-finished projects', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p-stalling', 'stalling', -0.1, { low: -0.15, high: -0.05 }),
      trajectoryRow(
        'p-finished',
        'stalled-finished',
        -0.1,
        { low: -0.15, high: -0.05 },
      ),
    ];
    const out = computeSurprises(emptyInput({ trajectories }));
    const stalled = out.surprises.filter((s) => s.kind === 'trajectory-stalled');
    expect(stalled).toHaveLength(2);
    // stalling > stalled-finished on score (active decline biased higher)
    const byId = new Map(stalled.map((s) => [s.evidence.projectId, s.score] as const));
    expect((byId.get('p-stalling') ?? 0)).toBeGreaterThan(
      byId.get('p-finished') ?? 0,
    );
  });

  it('does NOT emit for flat / accelerating projects', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p-flat', 'flat', 0, { low: -0.01, high: 0.01 }),
      trajectoryRow('p-up', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
    ];
    const out = computeSurprises(emptyInput({ trajectories }));
    expect(kindsOf(out.surprises)).not.toContain('trajectory-stalled');
  });
});

// ─── debt-spinning ─────────────────────────────────────────────────

describe('debt-spinning', () => {
  it('emits top-K clusters that meet the minimum size', () => {
    const knowledgeDebt: SurpriseKnowledgeDebtRow[] = [
      debtCluster('c-big', 15),
      debtCluster('c-med', 8),
      debtCluster('c-small', 3),
      debtCluster('c-tiny', 1), // below min size
    ];
    const out = computeSurprises(emptyInput({ knowledgeDebt }));
    const debt = out.surprises.filter((s) => s.kind === 'debt-spinning');
    // default topK=3, default minSize=3 → c-big, c-med, c-small
    expect(debt.map((s) => s.id)).toEqual([
      'debt-spinning:c-big',
      'debt-spinning:c-med',
      'debt-spinning:c-small',
    ]);
  });

  it('does NOT emit clusters below the minimum size', () => {
    const knowledgeDebt: SurpriseKnowledgeDebtRow[] = [debtCluster('c1', 2)];
    const out = computeSurprises(emptyInput({ knowledgeDebt }));
    expect(kindsOf(out.surprises)).not.toContain('debt-spinning');
  });

  it('low-confidence clusters get 0.7× score multiplier', () => {
    const knowledgeDebt: SurpriseKnowledgeDebtRow[] = [
      debtCluster('c-high', 10, 'high'),
      debtCluster('c-low', 10, 'low'),
    ];
    const out = computeSurprises(emptyInput({ knowledgeDebt }));
    const byId = new Map(
      out.surprises
        .filter((s) => s.kind === 'debt-spinning')
        .map((s) => [s.id, s.score] as const),
    );
    const high = byId.get('debt-spinning:c-high') ?? 0;
    const low = byId.get('debt-spinning:c-low') ?? 0;
    expect(low).toBeCloseTo(high * 0.7, 5);
  });
});

// ─── Cross-cutting: determinism, ranking, summary length ───────────

describe('cross-cutting properties', () => {
  it('summary clips at 120 chars', () => {
    const longName = 'p-'.padEnd(200, 'x');
    const trajectories: SurpriseTrajectoryRow[] = [
      {
        ...trajectoryRow(longName, 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
        projectName: longName,
      },
    ];
    const out = computeSurprises(emptyInput({ trajectories }));
    for (const s of out.surprises) {
      expect(s.summary.length).toBeLessThanOrEqual(120);
    }
  });

  it('output is sorted by score descending, then id ascending', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p-low', 'accelerating', 0.02, { low: 0.001, high: 0.04 }),
      trajectoryRow('p-high', 'accelerating', 0.3, { low: 0.1, high: 0.5 }),
    ];
    const out = computeSurprises(emptyInput({ trajectories }));
    const accel = out.surprises.filter((s) => s.kind === 'trajectory-accelerating');
    // p-high should come first
    expect(accel[0]?.evidence.projectId).toBe('p-high');
  });

  it('tie-breaks on id when scores are equal', () => {
    // Two patterns with the same Wilson upper bound (same N=5) → same score.
    const patternWatchers: SurpriseWatcherEntry[] = [
      watcherHolding('zzz', 5, 0.52),
      watcherHolding('aaa', 5, 0.52),
    ];
    const out = computeSurprises(emptyInput({ patternWatchers }));
    const closed = out.surprises.filter((s) => s.kind === 'pattern-closed');
    expect(closed.map((s) => s.evidence.narrativeId)).toEqual(['aaa', 'zzz']);
  });

  it('every surprise carries generatedAt matching the input', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
      compositeRow('s4', 4, 'good'),
      compositeRow('s5', 5, 'good'),
    ];
    const out = computeSurprises({ ...emptyInput({ composites }), generatedAt: 12345 });
    for (const s of out.surprises) {
      expect(s.generatedAt).toBe(12345);
    }
  });

  it('determinism: identical inputs produce identical outputs (ordering included)', () => {
    const input = emptyInput({
      composites: [
        compositeRow('s1', 1, 'good'),
        compositeRow('s2', 2, 'good'),
        compositeRow('s3', 3, 'good'),
        compositeRow('s4', 4, 'good'),
        compositeRow('s5', 5, 'good'),
      ],
      trajectories: [
        trajectoryRow('p1', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
        trajectoryRow('p2', 'stalling', -0.05, { low: -0.1, high: -0.01 }),
      ],
      itsResults: [itsRow('sha1', 0.2, 0.05)],
      patternWatchers: [watcherHolding('pat1'), watcherRecurring('pat2', 'narr-x')],
      reflexive: reflexive(0.2, 0.05, 0.35),
      decisions: [decision('d1', 's1', 'good')],
      knowledgeDebt: [debtCluster('c1', 10)],
    });
    const a = computeSurprises(input);
    const b = computeSurprises(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('tone segmentation: positive vs concerning kinds map to the right tone', () => {
    const input = emptyInput({
      trajectories: [
        trajectoryRow('p-up', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
        trajectoryRow('p-down', 'stalling', -0.05, { low: -0.1, high: -0.01 }),
      ],
    });
    const out = computeSurprises(input);
    for (const s of out.surprises) {
      if (s.kind === 'trajectory-accelerating') expect(s.tone).toBe('positive');
      if (s.kind === 'trajectory-stalled') expect(s.tone).toBe('concerning');
    }
  });
});

// ─── Wave 2 #1 — delta kinds ───────────────────────────────────────

function priorWith(surprises: readonly Surprise[]): SurprisesOutput {
  return {
    version: 1,
    generatedAt: GENERATED_AT - 86_400_000,
    surprises,
    thresholds: {
      streakMin: 5,
      itsQValueMax: 0.1,
      itsDeltaMin: 0.15,
      reflexiveDeltaMin: 0.1,
      reflexiveEValueMin: 1.5,
      decisionGoodFollowupsMin: 5,
      debtSpinningTopK: 3,
      debtSpinningMinClusterSize: 3,
    },
  };
}

function streakSurprise(ids: readonly string[]): Surprise {
  return {
    id: `streak:${ids[ids.length - 1] as string}`,
    kind: 'streak',
    tone: 'positive',
    summary: `${ids.length} sessions in a row landed as composite-good.`,
    evidence: { sessionIds: ids },
    score: 0.5,
    generatedAt: GENERATED_AT - 86_400_000,
  };
}

function trajectorySurprise(
  projectId: string,
  kind: 'trajectory-accelerating' | 'trajectory-stalled',
): Surprise {
  return {
    id: `${kind}:${projectId}`,
    kind,
    tone: kind === 'trajectory-accelerating' ? 'positive' : 'concerning',
    summary: `${projectId} surprise.`,
    evidence: { projectId },
    score: 0.5,
    generatedAt: GENERATED_AT - 86_400_000,
  };
}

function patternClosedSurprise(patternId: string): Surprise {
  return {
    id: `pattern-closed:${patternId}`,
    kind: 'pattern-closed',
    tone: 'positive',
    summary: `Pattern ${patternId} held.`,
    evidence: { projectId: 'p1', narrativeId: patternId },
    score: 0.5,
    generatedAt: GENERATED_AT - 86_400_000,
  };
}

describe('streak-extended (delta)', () => {
  it('emits when prior + current share lastSessionId and current is longer', () => {
    // Construct a corpus whose trailing-good-run ends on the same id
    // as the prior snapshot's. Easiest: composites end on s5 in both.
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
      compositeRow('s4', 4, 'good'),
      compositeRow('s5', 5, 'good'),
    ];
    const prior = priorWith([streakSurprise(['s3', 's4', 's5'])]);
    const out = computeSurprises(
      { ...emptyInput({ composites }), priorSurprises: prior },
      { streakMin: 3 },
    );
    const ext = out.surprises.find((s) => s.kind === 'streak-extended');
    expect(ext).toBeDefined();
    expect(ext?.tone).toBe('positive');
    // Prior was 3, current is 5 — diff = 2 → score 0.4.
    expect(ext?.score).toBeCloseTo(0.4, 5);
  });

  it('does NOT emit when lastSessionId differs (fresh streak, not extension)', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
    ];
    const prior = priorWith([streakSurprise(['x1', 'x2', 'x3'])]);
    const out = computeSurprises(
      { ...emptyInput({ composites }), priorSurprises: prior },
      { streakMin: 3 },
    );
    expect(kindsOf(out.surprises)).not.toContain('streak-extended');
  });

  it('does NOT emit when prior is null', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
    ];
    const out = computeSurprises(
      { ...emptyInput({ composites }), priorSurprises: null },
      { streakMin: 3 },
    );
    expect(kindsOf(out.surprises)).not.toContain('streak-extended');
  });

  it('does NOT emit when current streak is same length or shorter than prior', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
    ];
    const prior = priorWith([streakSurprise(['s1', 's2', 's3'])]);
    const out = computeSurprises(
      { ...emptyInput({ composites }), priorSurprises: prior },
      { streakMin: 3 },
    );
    expect(kindsOf(out.surprises)).not.toContain('streak-extended');
  });
});

describe('streak-broken (delta)', () => {
  it('emits when prior had a streak and current does NOT', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'bad'),
    ];
    const prior = priorWith([streakSurprise(['p1', 'p2', 'p3', 'p4', 'p5'])]);
    const out = computeSurprises(
      { ...emptyInput({ composites }), priorSurprises: prior },
      { streakMin: 5 },
    );
    const broken = out.surprises.find((s) => s.kind === 'streak-broken');
    expect(broken).toBeDefined();
    expect(broken?.tone).toBe('concerning');
    expect(broken?.score).toBeCloseTo(0.5, 5); // 5/10
    expect(broken?.evidence.sessionIds).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('does NOT emit when current ALSO has a streak (continued, not broken)', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
    ];
    const prior = priorWith([streakSurprise(['p1', 'p2', 'p3'])]);
    const out = computeSurprises(
      { ...emptyInput({ composites }), priorSurprises: prior },
      { streakMin: 3 },
    );
    expect(kindsOf(out.surprises)).not.toContain('streak-broken');
  });

  it('does NOT emit when prior is null', () => {
    const out = computeSurprises({ ...emptyInput(), priorSurprises: null });
    expect(kindsOf(out.surprises)).not.toContain('streak-broken');
  });

  it('does NOT emit when prior had no streak row', () => {
    const prior = priorWith([]); // prior was empty
    const out = computeSurprises({ ...emptyInput(), priorSurprises: prior });
    expect(kindsOf(out.surprises)).not.toContain('streak-broken');
  });
});

describe('trajectory-flip-up (delta)', () => {
  it('emits when a stalled project flips to accelerating', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'accelerating', 0.08, { low: 0.01, high: 0.15 }),
    ];
    const prior = priorWith([trajectorySurprise('p1', 'trajectory-stalled')]);
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: prior,
    });
    const flip = out.surprises.find((s) => s.kind === 'trajectory-flip-up');
    expect(flip).toBeDefined();
    expect(flip?.tone).toBe('positive');
    expect(flip?.evidence.projectId).toBe('p1');
    expect(flip?.score).toBeCloseTo(0.8, 5); // 0.08 * 10
  });

  it('emits when an absent project flips to accelerating', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p-new', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
    ];
    const prior = priorWith([]); // p-new was not in prior at all
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: prior,
    });
    expect(kindsOf(out.surprises)).toContain('trajectory-flip-up');
  });

  it('does NOT emit when prior was already accelerating', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
    ];
    const prior = priorWith([trajectorySurprise('p1', 'trajectory-accelerating')]);
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: prior,
    });
    expect(kindsOf(out.surprises)).not.toContain('trajectory-flip-up');
  });

  it('does NOT emit when prior is null', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
    ];
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: null,
    });
    expect(kindsOf(out.surprises)).not.toContain('trajectory-flip-up');
  });
});

describe('trajectory-flip-down (delta)', () => {
  it('emits when an accelerating project flips to stalling', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'stalling', -0.06, { low: -0.1, high: -0.02 }),
    ];
    const prior = priorWith([
      trajectorySurprise('p1', 'trajectory-accelerating'),
    ]);
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: prior,
    });
    const flip = out.surprises.find((s) => s.kind === 'trajectory-flip-down');
    expect(flip).toBeDefined();
    expect(flip?.tone).toBe('concerning');
    expect(flip?.evidence.projectId).toBe('p1');
    expect(flip?.score).toBeCloseTo(0.6, 5); // |-0.06| * 10
  });

  it('emits for stalled-finished too', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'stalled-finished', -0.04, {
        low: -0.08,
        high: -0.01,
      }),
    ];
    const prior = priorWith([
      trajectorySurprise('p1', 'trajectory-accelerating'),
    ]);
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: prior,
    });
    expect(kindsOf(out.surprises)).toContain('trajectory-flip-down');
  });

  it('does NOT emit when prior was already stalled', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'stalling', -0.05, { low: -0.1, high: -0.01 }),
    ];
    const prior = priorWith([trajectorySurprise('p1', 'trajectory-stalled')]);
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: prior,
    });
    expect(kindsOf(out.surprises)).not.toContain('trajectory-flip-down');
  });

  it('does NOT emit when prior is null', () => {
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'stalling', -0.05, { low: -0.1, high: -0.01 }),
    ];
    const out = computeSurprises({
      ...emptyInput({ trajectories }),
      priorSurprises: null,
    });
    expect(kindsOf(out.surprises)).not.toContain('trajectory-flip-down');
  });
});

describe('pattern-recurrence-resumed (delta)', () => {
  it('emits when pattern-closed in prior is now pattern-recurring in current', () => {
    const patternWatchers: SurpriseWatcherEntry[] = [
      watcherRecurring('pat-x', 'narr-1'),
    ];
    const prior = priorWith([patternClosedSurprise('pat-x')]);
    const out = computeSurprises({
      ...emptyInput({ patternWatchers }),
      priorSurprises: prior,
    });
    const resumed = out.surprises.find(
      (s) => s.kind === 'pattern-recurrence-resumed',
    );
    expect(resumed).toBeDefined();
    expect(resumed?.tone).toBe('concerning');
    expect(resumed?.score).toBeCloseTo(0.85, 5);
    expect(resumed?.evidence.narrativeId).toBe('narr-1');
  });

  it('does NOT emit when pattern is recurring but was not previously closed', () => {
    const patternWatchers: SurpriseWatcherEntry[] = [
      watcherRecurring('pat-y', 'narr-2'),
    ];
    const prior = priorWith([patternClosedSurprise('pat-x')]); // different id
    const out = computeSurprises({
      ...emptyInput({ patternWatchers }),
      priorSurprises: prior,
    });
    expect(kindsOf(out.surprises)).not.toContain('pattern-recurrence-resumed');
  });

  it('does NOT emit when prior is null', () => {
    const patternWatchers: SurpriseWatcherEntry[] = [
      watcherRecurring('pat-x', 'narr-1'),
    ];
    const out = computeSurprises({
      ...emptyInput({ patternWatchers }),
      priorSurprises: null,
    });
    expect(kindsOf(out.surprises)).not.toContain('pattern-recurrence-resumed');
  });
});

describe('delta kinds — V1 backward compatibility', () => {
  it('null priorSurprises produces identical output to omitting the field (V1)', () => {
    const input = emptyInput({
      composites: [
        compositeRow('s1', 1, 'good'),
        compositeRow('s2', 2, 'good'),
        compositeRow('s3', 3, 'good'),
        compositeRow('s4', 4, 'good'),
        compositeRow('s5', 5, 'good'),
      ],
      trajectories: [
        trajectoryRow('p1', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
      ],
      patternWatchers: [watcherRecurring('pat-x', 'narr-1')],
    });
    const v1 = computeSurprises(input);
    const v1ExplicitNull = computeSurprises({ ...input, priorSurprises: null });
    expect(JSON.stringify(v1ExplicitNull)).toBe(JSON.stringify(v1));
  });

  it('determinism: identical prior+current inputs produce identical output ordering', () => {
    const composites: SurpriseCompositeRow[] = [
      compositeRow('s1', 1, 'good'),
      compositeRow('s2', 2, 'good'),
      compositeRow('s3', 3, 'good'),
    ];
    const trajectories: SurpriseTrajectoryRow[] = [
      trajectoryRow('p1', 'accelerating', 0.05, { low: 0.01, high: 0.1 }),
    ];
    const prior = priorWith([
      streakSurprise(['s1', 's2']),
      trajectorySurprise('p1', 'trajectory-stalled'),
    ]);
    const input: ComputeSurprisesInput = {
      ...emptyInput({ composites, trajectories }),
      priorSurprises: prior,
    };
    const a = computeSurprises(input, { streakMin: 2 });
    const b = computeSurprises(input, { streakMin: 2 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
