import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Project,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { THRESHOLDS } from '@chat-arch/analysis';
import {
  buildNarrativeCandidatesFile,
  NARRATIVE_HEURISTIC_VERSION,
} from '../../src/analysis/narrativeCandidates.js';
import { logger } from '../../src/lib/logger.js';

/**
 * Per-spec test plan: assert the 4 recency buckets fill from a
 * synthetic session set with known recency distribution; verify
 * outcome-marker extraction; verify `sessionsWithCandidates` count.
 */

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-narratives-'));
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

function mkSession(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    startedAt: 1,
    updatedAt: 1_700_000_000_000,
    durationMs: 0,
    title: `session ${id}`,
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    modelsUsed: [],
    cwdKind: 'cli-direct',
    cwd: null,
    project: 'demo-project',
    totalCostUsd: null,
    tokenTotals: null,
    ...overrides,
  } as unknown as UnifiedSessionEntry;
}

function mkProject(
  id: string,
  displayName: string,
  sessionIds: readonly string[],
): Project {
  return {
    id,
    displayName,
    discoveredAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    sessionIds: [...sessionIds],
    narrativeIds: [],
    topicIds: [],
    sentiment: 'neutral',
    source: 'cli-cwd',
  };
}

describe('narrative-candidates heuristic extractor', () => {
  it('fills all 4 recency buckets from sessions spread across a wide updatedAt range', () => {
    // 8 sessions spread across founding → recent; each has a usable
    // title so each produces a candidate. With 8 sessions and 4
    // buckets, the bucketSessionsByRecency split is 2/2/2/2.
    const sessions: UnifiedSessionEntry[] = [];
    const sessionIds: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = `s${i}`;
      sessions.push(
        mkSession(id, {
          updatedAt: 1_700_000_000_000 + i * 86_400_000, // one day apart
          title: i % 2 === 0 ? `shipped feature ${i}` : `broken pipeline ${i}`,
          preview: 'preview text',
        }),
      );
      sessionIds.push(id);
    }
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions,
      counts: { total: sessions.length, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('demo-project', 'demo-project', sessionIds);

    const r = buildNarrativeCandidatesFile(manifest, {
      now: 1_700_000_000_000 + 9 * 86_400_000,
      projects: [proj],
    });

    expect(r.file.version).toBe(1);
    expect(r.file.heuristicVersion).toBe(NARRATIVE_HEURISTIC_VERSION);
    expect(r.file.projects).toHaveLength(1);
    const p = r.file.projects[0]!;
    expect(p.projectId).toBe('demo-project');
    expect(p.sessionsTotal).toBe(8);
    expect(p.sessionsSampled).toBe(8);
    expect(p.sessionsWithCandidates).toBe(8);
    // All 4 buckets fill with sessionsTotal=8.
    for (const bucket of ['founding', 'mid-early', 'mid-late', 'recent'] as const) {
      expect(p.candidatesByBucket[bucket].length).toBeGreaterThan(0);
    }
  });

  it('extracts positive outcome markers from session titles ("shipped", "merged")', () => {
    const sessions = [
      mkSession('a', {
        updatedAt: 1_700_000_000_000,
        title: 'shipped feature A',
        preview: 'work merged into main',
      }),
      mkSession('b', {
        updatedAt: 1_700_000_001_000,
        title: 'feature B passing CI',
        preview: 'tests green',
      }),
    ];
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions,
      counts: { total: 2, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('proj_p', 'proj_p', ['a', 'b']);

    const r = buildNarrativeCandidatesFile(manifest, {
      now: 1_700_000_010_000,
      projects: [proj],
    });

    const p = r.file.projects[0]!;
    const allCands = [
      ...p.candidatesByBucket.founding,
      ...p.candidatesByBucket['mid-early'],
      ...p.candidatesByBucket['mid-late'],
      ...p.candidatesByBucket.recent,
    ];
    const aCand = allCands.find((c) => c.sessionId === 'a');
    const bCand = allCands.find((c) => c.sessionId === 'b');
    expect(aCand).toBeDefined();
    expect(bCand).toBeDefined();
    expect(aCand!.outcomeMarkers).toEqual(
      expect.arrayContaining(['shipped', 'merged']),
    );
    expect(bCand!.outcomeMarkers).toEqual(expect.arrayContaining(['passing']));
  });

  it('extracts negative outcome markers ("broken", "failed", "stuck")', () => {
    const sessions = [
      mkSession('a', {
        updatedAt: 1_700_000_000_000,
        title: 'broken pipeline — failing build',
        preview: 'stuck on the same error',
      }),
    ];
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions,
      counts: { total: 1, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('proj_n', 'proj_n', ['a']);

    const r = buildNarrativeCandidatesFile(manifest, {
      now: 1_700_000_010_000,
      projects: [proj],
    });

    const p = r.file.projects[0]!;
    const cand =
      p.candidatesByBucket.founding[0] ??
      p.candidatesByBucket['mid-early'][0] ??
      p.candidatesByBucket['mid-late'][0] ??
      p.candidatesByBucket.recent[0];
    expect(cand).toBeDefined();
    expect(cand!.outcomeMarkers).toEqual(
      expect.arrayContaining(['broken', 'failing', 'stuck']),
    );
  });

  it('emits a zero-candidate row when a project has no sessions', () => {
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions: [],
      counts: { total: 0, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('phantom', 'phantom', []);

    const r = buildNarrativeCandidatesFile(manifest, {
      now: 1_700_000_000_000,
      projects: [proj],
    });

    expect(r.file.projects).toHaveLength(1);
    const p = r.file.projects[0]!;
    expect(p.sessionsTotal).toBe(0);
    expect(p.sessionsSampled).toBe(0);
    expect(p.sessionsWithCandidates).toBe(0);
  });

  it('caps candidates per recency bucket at maxCandidatesPerRecencyBucket', () => {
    // Build 2 × maxCandidatesPerRecencyBucket + 4 sessions split evenly
    // across the project's lifespan. After bucketing by recency the
    // cap should constrain each bucket.
    const cap = THRESHOLDS.narrative.maxCandidatesPerRecencyBucket;
    const total = cap * 4 + 4; // 4 buckets at cap + extras for overflow
    const sessions: UnifiedSessionEntry[] = [];
    const sessionIds: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const id = `s${i.toString().padStart(5, '0')}`;
      sessions.push(
        mkSession(id, {
          updatedAt: 1_700_000_000_000 + i * 1000,
          title: `shipped change ${i}`,
        }),
      );
      sessionIds.push(id);
    }
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions,
      counts: { total: sessions.length, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('proj_big', 'proj_big', sessionIds);

    const r = buildNarrativeCandidatesFile(manifest, {
      now: 1_700_000_000_000 + total * 1000,
      projects: [proj],
    });

    const p = r.file.projects[0]!;
    for (const bucket of ['founding', 'mid-early', 'mid-late', 'recent'] as const) {
      expect(p.candidatesByBucket[bucket].length).toBeLessThanOrEqual(cap);
    }
  });

  it('stratified sampling: with > maxSessionsForCorpus sessions, founding bucket still surfaces oldest signal', () => {
    // 240 sessions, maxSessionsForCorpus = 200. Recency-only top-200
    // would discard the earliest 40. Stratified-by-recency draws 50
    // from each quartile, so founding (indices 0-59) must contribute.
    const sessions: UnifiedSessionEntry[] = [];
    const sessionIds: string[] = [];
    for (let i = 0; i < 240; i += 1) {
      const id = `s${i.toString().padStart(4, '0')}`;
      sessions.push(
        mkSession(id, {
          updatedAt: 1_700_000_000_000 + i * 1000,
          title: `session ${i}`,
        }),
      );
      sessionIds.push(id);
    }
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions,
      counts: { total: sessions.length, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('strat', 'strat', sessionIds);

    const r = buildNarrativeCandidatesFile(manifest, {
      now: 1_700_000_000_000 + 240 * 1000,
      projects: [proj],
    });

    const p = r.file.projects[0]!;
    // earliestSampledAt should be strictly less than the recency-only
    // cutoff (which would put it at index 40 = 1_700_000_000_000 + 40_000).
    expect(p.earliestSampledAt).not.toBeNull();
    expect(p.earliestSampledAt!).toBeLessThan(1_700_000_000_000 + 40 * 1000);
  });

  it('does NOT include candidateBudgetProxy in the thresholds snapshot (V1 deliberately omits it)', () => {
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions: [],
      counts: { total: 0, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;
    const proj = mkProject('p', 'p', []);
    const r = buildNarrativeCandidatesFile(manifest, {
      now: 1_700_000_000_000,
      projects: [proj],
    });
    expect(
      (r.file.thresholds as Record<string, unknown>)['candidateBudgetProxy'],
    ).toBeUndefined();
  });
});
