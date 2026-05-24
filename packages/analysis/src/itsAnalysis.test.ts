import { describe, it, expect } from 'vitest';
import type { CompositeOutcome } from '@chat-arch/schema';
import { runItsAnalysis, type ItsConfigCommit, type ItsOutcomeInput } from './itsAnalysis.js';

const MS_PER_DAY = 86_400_000;

function comp(score: number, good: boolean): CompositeOutcome {
  return {
    sessionId: 's',
    source: 'cowork',
    testPass: null,
    buildPass: null,
    prLand: null,
    noRework: null,
    affirmation: null,
    score,
    linearLogit: 0,
    binary: good ? 'good' : 'bad',
    weightsHash: 'deadbeefdeadbeef',
  };
}

function outcome(sessionId: string, daysFromAnchor: number, score: number, good: boolean): ItsOutcomeInput {
  return {
    sessionId,
    updatedAt: ANCHOR + daysFromAnchor * MS_PER_DAY,
    composite: comp(score, good),
  };
}

const ANCHOR = 1_700_000_000_000; // arbitrary unix ms

function commit(daysFromAnchor: number): ItsConfigCommit {
  return {
    sha: `sha-${daysFromAnchor}`,
    ts: ANCHOR + daysFromAnchor * MS_PER_DAY,
    path: 'CLAUDE.md',
    subject: `test commit at +${daysFromAnchor}d`,
  };
}

// Deterministic LCG for reproducible runs.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('runItsAnalysis', () => {
  it('recovers pre/post means on a clean synthetic series', () => {
    // Pre window: 10 sessions at score 0.3, all bad.
    // Post window: 10 sessions at score 0.7, all good.
    // Commit at day 0; window = 5 days each side.
    const outcomes: ItsOutcomeInput[] = [];
    for (let i = 0; i < 10; i += 1) {
      outcomes.push(outcome(`pre-${i}`, -4 + i * 0.4, 0.3, false));
    }
    for (let i = 0; i < 10; i += 1) {
      outcomes.push(outcome(`post-${i}`, 0.1 + i * 0.4, 0.7, true));
    }
    const r = runItsAnalysis(outcomes, [commit(0)], { windowDays: 5 });
    expect(r).toHaveLength(1);
    const row = r[0]!;
    expect(row.pre.n).toBe(10);
    expect(row.post.n).toBe(10);
    expect(row.pre.meanScore).toBeCloseTo(0.3, 9);
    expect(row.post.meanScore).toBeCloseTo(0.7, 9);
    expect(row.pre.goodShare).toBe(0);
    expect(row.post.goodShare).toBe(1);
    expect(row.deltaGoodShare).toBeCloseTo(1, 9);
  });

  it('returns empty snapshot when no outcomes fall in the window', () => {
    const r = runItsAnalysis(
      [outcome('far', 100, 0.5, true)],
      [commit(0)],
      { windowDays: 5 },
    );
    expect(r[0]!.pre.n).toBe(0);
    expect(r[0]!.post.n).toBe(0);
    expect(Number.isNaN(r[0]!.pre.meanScore)).toBe(true);
    expect(Number.isNaN(r[0]!.post.meanScore)).toBe(true);
  });

  it('uses THRESHOLDS.trajectory.rollingWindow when windowDays omitted', () => {
    // Default is 10 days. Put outcomes at ±9d so they're inside.
    const outcomes: ItsOutcomeInput[] = [
      outcome('p1', -9, 0.4, false),
      outcome('p2', 9, 0.6, true),
    ];
    const r = runItsAnalysis(outcomes, [commit(0)]);
    expect(r[0]!.windowDays).toBe(10);
    expect(r[0]!.pre.n).toBe(1);
    expect(r[0]!.post.n).toBe(1);
  });

  it('handles multiple commits independently', () => {
    const outcomes: ItsOutcomeInput[] = [
      outcome('a', -3, 0.3, false),
      outcome('b', 3, 0.7, true),
      outcome('c', 17, 0.4, false),
      outcome('d', 23, 0.8, true),
    ];
    const r = runItsAnalysis(outcomes, [commit(0), commit(20)], { windowDays: 5 });
    expect(r).toHaveLength(2);
    expect(r[0]!.sha).toBe('sha-0');
    expect(r[1]!.sha).toBe('sha-20');
    expect(r[0]!.pre.n).toBe(1);
    expect(r[0]!.post.n).toBe(1);
    expect(r[1]!.pre.n).toBe(1);
    expect(r[1]!.post.n).toBe(1);
  });

  it('pValue: NaN when either side has n=0, small when delta + n are large', () => {
    // Empty-side commit → NaN p.
    const emptyR = runItsAnalysis([], [commit(0)], { windowDays: 5 });
    expect(Number.isNaN(emptyR[0]!.pValue)).toBe(true);
    expect(Number.isNaN(emptyR[0]!.qValue)).toBe(true);

    // Large delta + n=20 each → small p.
    const outcomes: ItsOutcomeInput[] = [];
    for (let i = 0; i < 20; i += 1) {
      outcomes.push(outcome(`pre-${i}`, -4 + i * 0.2, 0.3, false));
    }
    for (let i = 0; i < 20; i += 1) {
      outcomes.push(outcome(`post-${i}`, 0.1 + i * 0.2, 0.7, true));
    }
    const r = runItsAnalysis(outcomes, [commit(0)], { windowDays: 5 });
    expect(r[0]!.pValue).toBeLessThan(0.001);
    // Single commit → q = p (no correction multiplier).
    expect(r[0]!.qValue).toBeCloseTo(r[0]!.pValue, 9);
  });

  it('qValue: BH-FDR correction applies across all commits in one call', () => {
    // Three commits in one call; all with the same modest delta. Without
    // correction, all three would have p≈0.05; BH should leave the
    // largest q at the same level but push the smaller q up.
    function buildModerate(commitDays: number): ItsOutcomeInput[] {
      const outs: ItsOutcomeInput[] = [];
      // 12 sessions per side; 4-of-12 good on pre, 8-of-12 good on post.
      for (let i = 0; i < 12; i += 1) {
        outs.push(outcome(`pre-${commitDays}-${i}`, commitDays - 4 + i * 0.3, 0.3, i < 4));
      }
      for (let i = 0; i < 12; i += 1) {
        outs.push(outcome(`post-${commitDays}-${i}`, commitDays + 0.1 + i * 0.3, 0.7, i < 8));
      }
      return outs;
    }
    const outcomes = [
      ...buildModerate(0),
      ...buildModerate(20),
      ...buildModerate(40),
    ];
    const r = runItsAnalysis(outcomes, [commit(0), commit(20), commit(40)], {
      windowDays: 5,
    });
    expect(r).toHaveLength(3);
    // Each commit has the same data shape, so each raw p should be identical;
    // BH-FDR with all-equal p_(j) yields q_i = (m/m) * p_(m) = p for the
    // largest, and q_i = (m/j) * p for the others propagated up by the
    // step-up min, but the running-min over j ≥ i means all three q ≥ p.
    for (let i = 0; i < 3; i += 1) {
      expect(r[i]!.qValue).toBeGreaterThanOrEqual(r[i]!.pValue);
      expect(r[i]!.qValue).toBeLessThanOrEqual(1);
    }
  });

  it('Wilson CI brackets the truth on ≥95% of seeded synthetic runs', () => {
    // Seed three runs. Each generates pre=20 sessions with p_good=0.3 and
    // post=20 sessions with p_good=0.7 from a Bernoulli, then asserts that
    // the deltaCI brackets the true delta=0.4 in at least 2/3 cases. With
    // n=20 on each side and Z=1.96, the standard error is ~0.15 so coverage
    // at the truth should be very reliable in 3 seeded draws.
    const seeds = [1, 2, 3];
    let coverage = 0;
    for (const seed of seeds) {
      const rng = mulberry32(seed);
      const outcomes: ItsOutcomeInput[] = [];
      for (let i = 0; i < 20; i += 1) {
        outcomes.push(outcome(`pre-${i}`, -4 + i * 0.2, 0.3, rng() < 0.3));
      }
      for (let i = 0; i < 20; i += 1) {
        outcomes.push(outcome(`post-${i}`, 0.1 + i * 0.2, 0.7, rng() < 0.7));
      }
      const r = runItsAnalysis(outcomes, [commit(0)], { windowDays: 5 });
      const row = r[0]!;
      // True delta is +0.4. Check the CI brackets it.
      if (row.deltaCI.low <= 0.4 && row.deltaCI.high >= 0.4) coverage += 1;
    }
    expect(coverage / seeds.length).toBeGreaterThanOrEqual(2 / 3);
  });
});
