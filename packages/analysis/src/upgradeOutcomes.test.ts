import { describe, it, expect } from 'vitest';
import type {
  AppliedImprovement,
  ProposedUpgrade,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { buildUpgradeOutcomes } from './upgradeOutcomes.js';

function s(
  id: string,
  startedAt: number,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cowork',
    rawSessionId: id,
    startedAt,
    updatedAt: startedAt + 1000,
    durationMs: 1000,
    title: id,
    titleSource: 'fallback',
    preview: null,
    userTurns: 5,
    model: null,
    cwdKind: 'none',
    totalCostUsd: 0.5,
    ...overrides,
  };
}

function up(target: ProposedUpgrade['target']): ProposedUpgrade {
  return {
    target,
    targetPath: 'x',
    patch: 'p',
    rationale: 'r',
    applied: true,
    appliedAt: 1_000,
  };
}

function ai(
  id: string,
  appliedAt: number,
  patternId: string,
  proposedUpgrade: ProposedUpgrade = up('global-claude-md'),
): AppliedImprovement {
  return {
    id,
    patternId,
    appliedAt,
    ruleSummary: 'rule',
    proposedUpgrade,
  };
}

describe('buildUpgradeOutcomes', () => {
  it('emits empty outcomes when no applications exist', () => {
    const r = buildUpgradeOutcomes([s('a', 0)], []);
    expect(r.outcomes).toEqual([]);
    expect(r.version).toBe(1);
  });

  it('records the next N sessions after the application timestamp', () => {
    const sessions = [
      s('pre-1', 100),
      s('pre-2', 200),
      s('post-1', 1100),
      s('post-2', 1200),
      s('post-3', 1300),
    ];
    const apps = [ai('app1', 1_000, 'p1')];
    const r = buildUpgradeOutcomes(sessions, apps, { windowSize: 2 });
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]?.observedSessionIds).toEqual(['post-1', 'post-2']);
  });

  it('computes mean metrics for before and after windows', () => {
    const sessions = [
      s('pre-1', 100, { userTurns: 10, totalCostUsd: 1.0 }),
      s('pre-2', 200, { userTurns: 20, totalCostUsd: 3.0 }),
      s('post-1', 1100, { userTurns: 5, totalCostUsd: 0.5 }),
      s('post-2', 1200, { userTurns: 5, totalCostUsd: 0.5 }),
    ];
    const r = buildUpgradeOutcomes(sessions, [ai('a', 1_000, 'p1')], {
      windowSize: 5,
    });
    expect(r.outcomes[0]?.metrics.before.meanUserTurns).toBe(15);
    expect(r.outcomes[0]?.metrics.before.meanCostUsd).toBe(2.0);
    expect(r.outcomes[0]?.metrics.after.meanUserTurns).toBe(5);
    expect(r.outcomes[0]?.metrics.after.meanCostUsd).toBe(0.5);
  });

  it('falls back to costEstimatedUsd when totalCostUsd is null', () => {
    const sessions = [
      s('a', 100, { totalCostUsd: null, costEstimatedUsd: 0.4 }),
      s('b', 1100, { totalCostUsd: null, costEstimatedUsd: 0.6 }),
    ];
    const r = buildUpgradeOutcomes(sessions, [ai('a', 1_000, 'p1')], {
      windowSize: 5,
    });
    expect(r.outcomes[0]?.metrics.before.meanCostUsd).toBe(0.4);
    expect(r.outcomes[0]?.metrics.after.meanCostUsd).toBe(0.6);
  });

  it('reports errorMessageRate as the fraction of sessions with errorMessage', () => {
    const sessions = [
      s('post-1', 1100, { errorMessage: 'boom' }),
      s('post-2', 1200),
      s('post-3', 1300, { errorMessage: 'kaboom' }),
      s('post-4', 1400),
    ];
    const r = buildUpgradeOutcomes(sessions, [ai('a', 1_000, 'p1')], {
      windowSize: 10,
    });
    expect(r.outcomes[0]?.metrics.after.errorMessageRate).toBe(0.5);
  });

  it('defaults recurred to false (Wave 2 placeholder; A.1 flips later)', () => {
    const r = buildUpgradeOutcomes([s('a', 1100)], [ai('a', 1_000, 'p1')]);
    expect(r.outcomes[0]?.recurred).toBe(false);
  });

  it('returns null metrics when window is empty', () => {
    const r = buildUpgradeOutcomes([s('a', 100)], [ai('a', 1_000, 'p1')]);
    expect(r.outcomes[0]?.metrics.after.meanUserTurns).toBeNull();
    expect(r.outcomes[0]?.metrics.after.errorMessageRate).toBeNull();
  });
});
