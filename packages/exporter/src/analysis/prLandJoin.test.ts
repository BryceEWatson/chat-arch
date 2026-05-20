import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AuditResult,
  AuditResultsFile,
  CompositeOutcomesFile,
} from '@chat-arch/schema';
import {
  buildPrLandJoin,
  type GhPrApiResponse,
  type PrLandCacheFile,
} from './prLandJoin.js';

const tmpRoot = path.join(
  os.tmpdir(),
  `chat-arch-prland-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

async function makeFixture(
  subdir: string,
  opts: { withCacheEntry?: 'ok' | 'notFound' | 'transient'; ghOk?: boolean } = {},
): Promise<{ outDir: string }> {
  const outDir = path.join(tmpRoot, subdir);
  await mkdir(path.join(outDir, 'analysis'), { recursive: true });

  const result: AuditResult = {
    sessionId: 'sess-1',
    source: 'cli-direct',
    lineNumber: 1,
    claimType: 'gh-pr-merged',
    span: 'merged via https://github.com/foo/bar/pull/42',
    surroundingContext: 'merged via https://github.com/foo/bar/pull/42',
    outcome: 'pass',
    reason: 'gh pr merge clean',
  };
  const audit: AuditResultsFile = {
    version: 1,
    generatedAt: 0,
    totals: { pass: 1, fail: 0, inconclusive: 0 },
    results: [result],
  };
  await writeFile(
    path.join(outDir, 'analysis', 'audit-results.json'),
    JSON.stringify(audit, null, 2),
    'utf8',
  );

  const composite: CompositeOutcomesFile = {
    compositeVersion: 1,
    weightsVersion: 1,
    weights: {
      testPass: 0.3,
      testFail: -0.4,
      buildPass: 0.2,
      prLandMerged: 0.5,
      prLandClosedUnmerged: -0.3,
      reworkSameSession: -0.2,
      reworkContinuation: -0.25,
      affirmation: 0.1,
    },
    weightsHash: 'deadbeefcafebabe',
    generatedAt: 0,
    outcomes: [
      {
        sessionId: 'sess-1',
        source: 'cli-direct',
        testPass: null,
        buildPass: null,
        prLand: 'open', // pre-join, verifier-derived
        noRework: null,
        affirmation: null,
        score: 0.5,
        linearLogit: 0,
        binary: 'unknown',
        weightsHash: 'deadbeefcafebabe',
      },
    ],
    scannedSessionIds: ['sess-1'],
  };
  await writeFile(
    path.join(outDir, 'analysis', 'composite-outcomes.json'),
    JSON.stringify(composite, null, 2),
    'utf8',
  );

  if (opts.withCacheEntry !== undefined) {
    const data: GhPrApiResponse = {
      number: 42,
      state: 'closed',
      merged: true,
      merged_at: '2026-05-01T00:00:00Z',
      closed_at: '2026-05-01T00:00:00Z',
      title: 'fixture',
      html_url: 'https://github.com/foo/bar/pull/42',
    };
    const cache: PrLandCacheFile = {
      version: 1,
      generatedAt: 1000,
      entries: {
        'foo/bar#42': {
          state: opts.withCacheEntry,
          fetchedAt: 1000,
          ...(opts.withCacheEntry === 'ok' ? { data } : {}),
          ...(opts.withCacheEntry === 'transient' ? { error: 'gh pings timed out' } : {}),
        },
      },
    };
    await writeFile(
      path.join(outDir, 'analysis', 'pr-land-cache.json'),
      JSON.stringify(cache, null, 2),
      'utf8',
    );
  }

  void opts.ghOk;
  return { outDir };
}

describe('buildPrLandJoin', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('happy path — fresh cache + merged PR joins prLand to "merged"', async () => {
    const { outDir } = await makeFixture('joined', { withCacheEntry: 'ok' });
    const r = await buildPrLandJoin({
      outDir,
      now: 2_000,
      cacheOnly: true, // use cache; do not hit the network
    });
    expect(r.fetchedCount).toBe(0);
    expect(r.reusedCount).toBe(1);
    expect(r.joinedCount).toBe(1);
    expect(r.authErrorEncountered).toBe(false);

    const updated = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'composite-outcomes.json'), 'utf8'),
    ) as CompositeOutcomesFile;
    expect(updated.outcomes[0]?.prLand).toBe('merged');
  });

  it('cache reuse — 404 entries are reused forever (never re-fetched)', async () => {
    const { outDir } = await makeFixture('notfound', { withCacheEntry: 'notFound' });
    // now ≫ ttl; entry should still be honored for 404.
    const r = await buildPrLandJoin({
      outDir,
      now: 1_000_000_000_000,
      ttlMs: 1,
      cacheOnly: true,
    });
    expect(r.fetchedCount).toBe(0);
    expect(r.reusedCount).toBe(1);
    // No data → no join (composite-outcomes left untouched).
    expect(r.joinedCount).toBe(0);
  });

  it('cache invalidation — transient entries past TTL force a re-fetch attempt', async () => {
    // With cacheOnly: true we won't actually hit gh, but the entry
    // should not be reused (fetchedCount remains 0 because cacheOnly).
    const { outDir } = await makeFixture('transient', { withCacheEntry: 'transient' });
    const r = await buildPrLandJoin({
      outDir,
      now: 1_000_000_000_000,
      ttlMs: 1, // anything <(now - fetchedAt) → stale
      cacheOnly: true,
    });
    // Not reused (stale), not fetched (cacheOnly) — both zero.
    expect(r.reusedCount).toBe(0);
    expect(r.fetchedCount).toBe(0);
    expect(r.joinedCount).toBe(0);
  });
});
