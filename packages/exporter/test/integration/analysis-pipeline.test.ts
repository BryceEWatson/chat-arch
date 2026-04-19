import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { runAnalysis } from '../../src/analysis/index.js';
import { logger } from '../../src/lib/logger.js';

/**
 * Plan `phase6-plan-revised.md:177` — "Integration test for the full
 * exporter pipeline (all tier-1 `analysis/*.json` present and valid after
 * run; tier-2 files never written by Phase 6)".
 *
 * Uses a small synthetic manifest (≤10 sessions) so the test is deterministic
 * and fast. Asserts:
 *   (a) `duplicates.exact.json`, `zombies.heuristic.json`, `meta.json` all
 *       exist on disk after `runAnalysis`.
 *   (b) None of the six Phase-7-reserved filenames are written.
 *   (c) `meta.json.counts.sessions` matches the fixture's session count.
 *   (d) `meta.json.tiers.browser.files` lists exactly the three Phase-6 files.
 */

const PHASE_7_RESERVED = [
  'duplicates.semantic.json',
  'zombies.diagnosed.json',
  'reloops.json',
  'handoffs.json',
  'cost-diagnoses.json',
  'skill-seeds.json',
];

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-analysis-'));
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

function mkSession(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cowork',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `session ${id}`,
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    modelsUsed: [],
    cwdKind: 'none',
    cwd: null,
    project: null,
    totalCostUsd: null,
    tokenTotals: null,
    ...overrides,
  } as unknown as UnifiedSessionEntry;
}

describe('Phase 6 analysis pipeline integration', () => {
  it('writes all three tier-1 files, writes no tier-2 files, and meta matches', async () => {
    const sessions: UnifiedSessionEntry[] = [
      mkSession('a1', {
        source: 'cloud',
        preview: 'first prompt body long enough to pass min-length filter',
      }),
      mkSession('a2', {
        source: 'cloud',
        preview: 'first prompt body long enough to pass min-length filter',
      }),
      mkSession('a3', {
        source: 'cloud',
        preview: 'a different first prompt that is also long enough to pass filter',
      }),
      mkSession('b1', { source: 'cowork', project: 'alpha', startedAt: 1 }),
      mkSession('b2', { source: 'cowork', project: 'alpha', startedAt: 2 }),
      mkSession('c1', { source: 'cli-direct', project: 'beta' }),
    ];
    const manifest: SessionManifest = {
      schemaVersion: 2,
      sessions,
      counts: { total: sessions.length, bySource: {} },
      generatedAt: 0,
    } as unknown as SessionManifest;

    const now = 1_700_000_000_000;
    const result = await runAnalysis(manifest, {
      outDir,
      now,
      exporterRunId: 'test-run-id',
      gitSha: null,
    });

    // (a) Three tier-1 files exist.
    const dirEntries = await readdir(path.join(outDir, 'analysis'));
    expect(dirEntries).toContain('duplicates.exact.json');
    expect(dirEntries).toContain('zombies.heuristic.json');
    expect(dirEntries).toContain('meta.json');

    // (b) No Phase-7 reserved filename exists.
    for (const reserved of PHASE_7_RESERVED) {
      expect(
        dirEntries,
        `tier-2 reserved file "${reserved}" must not be written by Phase 6`,
      ).not.toContain(reserved);
    }

    // Parse meta.
    const meta = JSON.parse(await readFile(path.join(outDir, 'analysis', 'meta.json'), 'utf8')) as {
      version: number;
      generatedAt: number;
      exporterRunId: string;
      tiers: { browser: { files: string[] }; local?: unknown };
      counts: { sessions: number };
    };

    // (c) Session count in meta matches fixture.
    expect(meta.counts.sessions).toBe(sessions.length);

    // (d) browser.files lists exactly the three Phase-6 files.
    expect(meta.tiers.browser.files.sort()).toEqual(
      ['duplicates.exact.json', 'zombies.heuristic.json'].sort(),
    );
    // Phase 6 does not populate the `local` tier.
    expect(meta.tiers.local).toBeUndefined();

    // version + run-id plumbing.
    expect(meta.version).toBe(1);
    expect(meta.exporterRunId).toBe('test-run-id');
    expect(meta.generatedAt).toBe(now);

    // Duplicates file parses & is schema-correct.
    const dup = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'duplicates.exact.json'), 'utf8'),
    ) as { version: number; tier: string; clusters: Array<{ sessionIds: string[] }> };
    expect(dup.version).toBe(1);
    expect(dup.tier).toBe('browser');
    // a1+a2 duplicate (both cloud, prompt above 40-char threshold); a3 unique.
    expect(dup.clusters).toHaveLength(1);
    expect(dup.clusters[0]!.sessionIds.sort()).toEqual(['a1', 'a2']);

    // Zombies file parses.
    const zom = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'zombies.heuristic.json'), 'utf8'),
    ) as { version: number; tier: string };
    expect(zom.version).toBe(1);
    expect(zom.tier).toBe('browser');

    // result.analysisDir plumbed.
    expect(result.analysisDir).toBe(path.join(outDir, 'analysis'));
  });
});
