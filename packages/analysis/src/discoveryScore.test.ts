import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import {
  DEFAULT_DISCOVERY_WEIGHTS,
  computeDiscoveryScore,
  scoreManifest,
} from './discoveryScore.js';

function s(overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id: 'sid',
    source: 'cowork',
    rawSessionId: 'sid',
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: 't',
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  };
}

describe('computeDiscoveryScore', () => {
  it('scores 0 for an empty session with no signals', () => {
    const r = computeDiscoveryScore(
      s(),
      { projectsWithLaterApplications: new Set(), prBranchHeads: new Set() },
    );
    expect(r.score).toBe(0);
    expect(r.components.tokenIntensity).toBe(0);
    expect(r.components.toolDiversity).toBe(0);
  });

  it('approaches 1 as tokens approach the cap', () => {
    const small = computeDiscoveryScore(
      s({ tokenTotals: { input: 1000, output: 0, cacheCreation: 0, cacheRead: 0 } }),
      { projectsWithLaterApplications: new Set(), prBranchHeads: new Set() },
    );
    const big = computeDiscoveryScore(
      s({ tokenTotals: { input: 80_000, output: 0, cacheCreation: 0, cacheRead: 0 } }),
      { projectsWithLaterApplications: new Set(), prBranchHeads: new Set() },
    );
    expect(small.components.tokenIntensity).toBeLessThan(big.components.tokenIntensity);
    expect(big.components.tokenIntensity).toBeCloseTo(1.0, 2);
  });

  it('caps token intensity at 1.0 for very large sessions', () => {
    const huge = computeDiscoveryScore(
      s({ tokenTotals: { input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 } }),
      { projectsWithLaterApplications: new Set(), prBranchHeads: new Set() },
    );
    expect(huge.components.tokenIntensity).toBe(1);
  });

  it('tool diversity scales linearly to the cap of 6', () => {
    const three = computeDiscoveryScore(
      s({ topTools: { Bash: 1, Read: 2, Edit: 3 } }),
      { projectsWithLaterApplications: new Set(), prBranchHeads: new Set() },
    );
    const all = computeDiscoveryScore(
      s({ topTools: { Bash: 1, Read: 1, Edit: 1, Write: 1, Grep: 1, Glob: 1 } }),
      { projectsWithLaterApplications: new Set(), prBranchHeads: new Set() },
    );
    expect(three.components.toolDiversity).toBeCloseTo(0.5, 6);
    expect(all.components.toolDiversity).toBe(1);
  });

  it('fires correction-applied-after when project is in the set', () => {
    const r = computeDiscoveryScore(
      s({ project: 'chat-arch', projectId: 'proj_chat_arch' }),
      {
        projectsWithLaterApplications: new Set(['proj_chat_arch']),
        prBranchHeads: new Set(),
      },
    );
    expect(r.components.correctionAppliedAfter).toBe(1);
  });

  it('uses entry.project as fallback when projectId is absent', () => {
    const r = computeDiscoveryScore(
      s({ project: 'chat-arch' }),
      {
        projectsWithLaterApplications: new Set(['chat-arch']),
        prBranchHeads: new Set(),
      },
    );
    expect(r.components.correctionAppliedAfter).toBe(1);
  });

  it('fires gitBranchOverlap when cwd worktree name matches a PR head', () => {
    const r = computeDiscoveryScore(
      s({ cwd: '/repo/.git/worktrees/feature-v2-instrumented-loop' }),
      {
        projectsWithLaterApplications: new Set(),
        prBranchHeads: new Set(['feature-v2-instrumented-loop']),
      },
    );
    expect(r.components.gitBranchOverlap).toBe(1);
  });

  it('weighted sum stays within 0..1', () => {
    const r = computeDiscoveryScore(
      s({
        tokenTotals: { input: 1_000_000, output: 0, cacheCreation: 0, cacheRead: 0 },
        topTools: { Bash: 1, Read: 1, Edit: 1, Write: 1, Grep: 1, Glob: 1 },
        project: 'p',
        cwd: '/r/.git/worktrees/b',
      }),
      {
        projectsWithLaterApplications: new Set(['p']),
        prBranchHeads: new Set(['b']),
      },
    );
    const sumOfWeights =
      DEFAULT_DISCOVERY_WEIGHTS.tokenIntensity +
      DEFAULT_DISCOVERY_WEIGHTS.toolDiversity +
      DEFAULT_DISCOVERY_WEIGHTS.correctionAppliedAfter +
      DEFAULT_DISCOVERY_WEIGHTS.gitBranchOverlap;
    expect(sumOfWeights).toBeCloseTo(1, 6);
    expect(r.score).toBeCloseTo(1, 6);
  });

  it('honors custom weights', () => {
    const r = computeDiscoveryScore(
      s({ topTools: { Bash: 1, Read: 1, Edit: 1, Write: 1, Grep: 1, Glob: 1 } }),
      { projectsWithLaterApplications: new Set(), prBranchHeads: new Set() },
      { weights: { tokenIntensity: 0, toolDiversity: 1.0, correctionAppliedAfter: 0, gitBranchOverlap: 0 } },
    );
    expect(r.score).toBe(1);
  });
});

describe('scoreManifest', () => {
  it('skips pruned sessions', () => {
    const sessions = [
      s({ id: 'live' }),
      s({ id: 'pruned', transcriptStatus: 'pruned' }),
    ];
    const map = scoreManifest(sessions, [], new Set());
    expect(map.has('live')).toBe(true);
    expect(map.has('pruned')).toBe(false);
  });

  it('aggregates applications into projects-with-later-apps set', () => {
    const sessions = [s({ id: 'a', project: 'p1' }), s({ id: 'b', project: 'p2' })];
    const map = scoreManifest(
      sessions,
      [{ appliedAt: 1000, projectId: 'p1' }],
      new Set(),
    );
    expect(map.get('a')?.components.correctionAppliedAfter).toBe(1);
    expect(map.get('b')?.components.correctionAppliedAfter).toBe(0);
  });
});
