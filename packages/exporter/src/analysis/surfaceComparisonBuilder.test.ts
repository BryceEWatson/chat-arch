import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CompositeOutcomesFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { buildSurfaceComparisonFile } from './surfaceComparisonBuilder.js';
import type { ArchetypesFile } from './archetypesBuilder.js';

describe('buildSurfaceComparisonFile', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    `chat-arch-surface-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function makeEntry(
    id: string,
    source: 'cli-direct' | 'cli-desktop' | 'cowork' | 'cloud',
  ): UnifiedSessionEntry {
    return {
      id,
      source,
      rawSessionId: id,
      startedAt: 0,
      updatedAt: 0,
      durationMs: 0,
      title: id,
      titleSource: 'first-prompt',
      preview: null,
      userTurns: 0,
      model: null,
      cwdKind: 'host',
      totalCostUsd: null,
    } as UnifiedSessionEntry;
  }

  async function writeArchetypes(
    outDir: string,
    assignments: Record<string, string>,
  ): Promise<void> {
    const file: ArchetypesFile = {
      version: 1,
      generatedAt: 0,
      archetypeVersion: 1,
      centroids: [],
      assignments,
      silhouette: 0,
      chosenK: 1,
      scannedSessionIds: Object.keys(assignments),
    };
    await writeFile(
      path.join(outDir, 'analysis', 'archetypes.json'),
      JSON.stringify(file),
      'utf8',
    );
  }

  async function writeComposite(
    outDir: string,
    rows: Array<{ sessionId: string; binary: 'good' | 'bad' | 'unknown' }>,
  ): Promise<void> {
    const file: CompositeOutcomesFile = {
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
      weightsHash: 'deadbeefdeadbeef',
      generatedAt: 0,
      outcomes: rows.map((r) => ({
        sessionId: r.sessionId,
        source: 'cli-direct',
        testPass: null,
        buildPass: null,
        prLand: null,
        noRework: null,
        affirmation: null,
        score: r.binary === 'good' ? 0.7 : 0.3,
        linearLogit: 0,
        binary: r.binary,
        weightsHash: 'deadbeefdeadbeef',
      })),
      scannedSessionIds: rows.map((r) => r.sessionId),
    };
    await writeFile(
      path.join(outDir, 'analysis', 'composite-outcomes.json'),
      JSON.stringify(file),
      'utf8',
    );
  }

  it('happy path: builds cells per (source, archetype) and runs pairwise tests on n≥8 cells', async () => {
    const outDir = path.join(tmpRoot, 'happy');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    // Two cells, each with n=10 — both clear minNForRate=8.
    // Cell cli-direct|A: 8/10 good. Cell cloud|A: 2/10 good. Two-prop
    // z-test should reject equal proportions cleanly.
    const sessions: UnifiedSessionEntry[] = [];
    const assignments: Record<string, string> = {};
    const compositeRows: Array<{ sessionId: string; binary: 'good' | 'bad' | 'unknown' }> = [];

    for (let i = 0; i < 10; i += 1) {
      const id = `cli-${i}`;
      sessions.push(makeEntry(id, 'cli-direct'));
      assignments[id] = 'archetype-0';
      compositeRows.push({ sessionId: id, binary: i < 8 ? 'good' : 'bad' });
    }
    for (let i = 0; i < 10; i += 1) {
      const id = `cloud-${i}`;
      sessions.push(makeEntry(id, 'cloud'));
      assignments[id] = 'archetype-0';
      compositeRows.push({ sessionId: id, binary: i < 2 ? 'good' : 'bad' });
    }

    await writeArchetypes(outDir, assignments);
    await writeComposite(outDir, compositeRows);

    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 10, 'cli-desktop': 0, cowork: 0, cloud: 10 },
      sessions,
    } as SessionManifest;

    const result = await buildSurfaceComparisonFile(manifest, { outDir, now: 1 });

    expect(result.cellsTotal).toBe(2);
    expect(result.cellsDisplayable).toBe(2);
    expect(result.pairsTested).toBe(1);
    expect(result.pairsSignificant).toBe(1);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'surface-comparison.json'), 'utf8'),
    );
    expect(onDisk.cells).toHaveLength(2);
    expect(onDisk.pairwise[0].pValue).toBeLessThan(0.05);
    expect(onDisk.pairwise[0].pValueAdjusted).toBeLessThan(0.05);
    // T3: a 10v10 cell pair with goodA=8, goodB=2 → expected counts
    // E(good, A) = 10*10/20 = 5, E(good, B) = 5, E(bad, A) = 5, E(bad, B) = 5.
    // All ≥ 5 → z-test branch.
    expect(onDisk.pairwise[0].testMethod).toBe('z-test');
  });

  it('T3: uses Fisher exact when min expected cell count < 5', async () => {
    const outDir = path.join(tmpRoot, 'fisher');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    // Two small cells: cli-direct n=8 (7 good, 1 bad); cloud n=8 (1 good,
    // 7 bad). Both ≥ minNForRate=8 to qualify for pairwise; row sums
    // R1=8, R2=8, col sums C1=8 (good), C2=8 (bad), N=16.
    // E(good, A) = 8*8/16 = 4 < 5 → Fisher branch triggers.
    const sessions: UnifiedSessionEntry[] = [];
    const assignments: Record<string, string> = {};
    const compositeRows: Array<{ sessionId: string; binary: 'good' | 'bad' | 'unknown' }> = [];
    for (let i = 0; i < 8; i += 1) {
      const id = `cli-${i}`;
      sessions.push(makeEntry(id, 'cli-direct'));
      assignments[id] = 'archetype-0';
      compositeRows.push({ sessionId: id, binary: i < 7 ? 'good' : 'bad' });
    }
    for (let i = 0; i < 8; i += 1) {
      const id = `cloud-${i}`;
      sessions.push(makeEntry(id, 'cloud'));
      assignments[id] = 'archetype-0';
      compositeRows.push({ sessionId: id, binary: i < 1 ? 'good' : 'bad' });
    }

    await writeArchetypes(outDir, assignments);
    await writeComposite(outDir, compositeRows);

    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 8, 'cli-desktop': 0, cowork: 0, cloud: 8 },
      sessions,
    } as SessionManifest;

    const result = await buildSurfaceComparisonFile(manifest, { outDir, now: 1 });

    expect(result.cellsTotal).toBe(2);
    expect(result.cellsDisplayable).toBe(2);
    expect(result.pairsTested).toBe(1);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'surface-comparison.json'), 'utf8'),
    );
    // Fisher exact for [[7,1],[1,7]] → p ≈ 0.0103.
    expect(onDisk.pairwise[0].testMethod).toBe('fisher-exact');
    expect(onDisk.pairwise[0].pValue).toBeGreaterThan(0.005);
    expect(onDisk.pairwise[0].pValue).toBeLessThan(0.02);
  });

  it('reuse-ish: deterministic over identical input (re-run = same output)', async () => {
    const outDir = path.join(tmpRoot, 'det');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    const sessions: UnifiedSessionEntry[] = [];
    const assignments: Record<string, string> = {};
    const compositeRows: Array<{ sessionId: string; binary: 'good' | 'bad' | 'unknown' }> = [];
    for (let i = 0; i < 12; i += 1) {
      const id = `s-${i}`;
      sessions.push(makeEntry(id, i % 2 === 0 ? 'cli-direct' : 'cloud'));
      assignments[id] = i % 3 === 0 ? 'archetype-0' : 'archetype-1';
      compositeRows.push({ sessionId: id, binary: i % 2 === 0 ? 'good' : 'bad' });
    }
    await writeArchetypes(outDir, assignments);
    await writeComposite(outDir, compositeRows);

    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 6, 'cli-desktop': 0, cowork: 0, cloud: 6 },
      sessions,
    } as SessionManifest;

    const a = await buildSurfaceComparisonFile(manifest, { outDir, now: 1 });
    const b = await buildSurfaceComparisonFile(manifest, { outDir, now: 2 });
    expect(b.cellsTotal).toBe(a.cellsTotal);
    expect(b.file.cells).toEqual(a.file.cells);
    expect(b.file.pairwise).toEqual(a.file.pairwise);
  });

  it('missing-input-graceful: aborts with clear error when archetypes.json is missing', async () => {
    const outDir = path.join(tmpRoot, 'missing-arche');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    const sessions = [makeEntry('s-1', 'cli-direct')];
    const manifest: SessionManifest = {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': 1, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions,
    } as SessionManifest;

    await expect(
      buildSurfaceComparisonFile(manifest, { outDir, now: 1 }),
    ).rejects.toThrow(/archetypes\.json/);
  });
});
