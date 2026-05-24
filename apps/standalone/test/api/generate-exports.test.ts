/**
 * Pure-function tests for the generate-exports endpoint.
 *
 * Targets the validate + percentile helpers + the post-mortem run
 * loop. The handler itself isn't exercised — it spawns subprocesses
 * and writes to disk; integration tests in a future revision would
 * cover that path.
 */
import { describe, expect, it } from 'vitest';
import {
  computePercentiles,
  runPostMortems,
  validateBody,
} from '../../src/pages/api/generate-exports.js';
import type {
  CompositeOutcome,
  CompositeOutcomesFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';

describe('validateBody', () => {
  it('defaults to all known kinds when none specified', () => {
    const r = validateBody({});
    expect(r.kinds.has('post-mortem')).toBe(true);
    expect(r.kinds.has('knowledge-debt')).toBe(true);
    expect(r.kinds.has('decision-log')).toBe(true);
    expect(r.kinds.has('trust-report')).toBe(true);
  });

  it('honors a subset of kinds when specified', () => {
    const r = validateBody({ kinds: ['post-mortem'] });
    expect(r.kinds.size).toBe(1);
    expect(r.kinds.has('post-mortem')).toBe(true);
  });

  it('drops unknown kinds silently rather than 400-ing', () => {
    const r = validateBody({ kinds: ['bogus', 'post-mortem'] });
    expect(r.kinds.has('post-mortem')).toBe(true);
    expect(r.kinds.has('bogus')).toBe(false);
  });

  it('parses filters', () => {
    const r = validateBody({
      kinds: ['post-mortem'],
      filters: { outcomePercentile: 80, projectId: 'chat-arch' },
    });
    expect(r.filters.outcomePercentile).toBe(80);
    expect(r.filters.projectId).toBe('chat-arch');
  });

  it('rejects out-of-range outcomePercentile', () => {
    const r = validateBody({
      filters: { outcomePercentile: -5 },
    });
    expect(r.filters.outcomePercentile).toBeUndefined();
  });
});

describe('computePercentiles', () => {
  it('returns an empty map for an empty outcomes list', () => {
    const m = computePercentiles([]);
    expect(m.size).toBe(0);
  });

  it('places the lowest score at 0 and the highest at 1', () => {
    const outcomes: CompositeOutcome[] = [
      mkOutcome('a', 0.1),
      mkOutcome('b', 0.5),
      mkOutcome('c', 0.9),
    ];
    const m = computePercentiles(outcomes);
    expect(m.get('a')).toBeCloseTo(0);
    expect(m.get('c')).toBeCloseTo(1);
    expect(m.get('b')).toBeGreaterThan(0);
    expect(m.get('b')).toBeLessThan(1);
  });

  it('single-row outcomes -> percentile 1', () => {
    const m = computePercentiles([mkOutcome('only', 0.5)]);
    expect(m.get('only')).toBe(1);
  });
});

describe('runPostMortems', () => {
  it('skips ineligible sessions and reports zero generated', async () => {
    const manifest: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 1,
      counts: { cloud: 1, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
      sessions: [mkSession('s1', undefined)], // no project -> ineligible
    };
    const outcomesFile: CompositeOutcomesFile = {
      compositeVersion: 1,
      weightsVersion: 1,
      weights: dummyWeights(),
      weightsHash: 'abc',
      generatedAt: 1,
      outcomes: [mkOutcome('s1', 0.99)],
      scannedSessionIds: ['s1'],
    };
    const writes: Array<{ path: string; content: string }> = [];
    const r = await runPostMortems(
      manifest,
      outcomesFile,
      null,
      {},
      '/tmp/out',
      async (p, c) => {
        writes.push({ path: p, content: c });
      },
    );
    expect(r.generated).toBe(0);
    expect(writes.length).toBe(0);
  });
});

function mkOutcome(id: string, score: number): CompositeOutcome {
  return {
    sessionId: id,
    source: 'cli-direct',
    testPass: null,
    buildPass: null,
    prLand: null,
    noRework: null,
    affirmation: null,
    score,
    linearLogit: 0,
    binary: score >= 0.5 ? 'good' : 'bad',
    weightsHash: 'abc',
  };
}

function mkSession(id: string, project: string | undefined): UnifiedSessionEntry {
  return {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    title: `session ${id}`,
    titleSource: 'firstUserTurn',
    preview: '',
    messageCount: 0,
    startedAt: 1,
    updatedAt: 1,
    durationMs: 0,
    userTurns: 0,
    ...(project ? { project } : {}),
  } as UnifiedSessionEntry;
}

function dummyWeights() {
  return {
    testPass: 0.3,
    testFail: -0.4,
    buildPass: 0.2,
    prLandMerged: 0.5,
    prLandClosedUnmerged: -0.3,
    reworkSameSession: -0.2,
    reworkContinuation: -0.25,
    affirmation: 0.1,
  };
}
