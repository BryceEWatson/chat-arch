import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CompositeOutcome,
  CompositeOutcomesFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { buildReflexiveFile, type ReflexiveFile } from './reflexiveBuilder.js';

const tmpRoot = path.join(
  os.tmpdir(),
  `chat-arch-reflexive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function mkOutcome(
  sessionId: string,
  binary: CompositeOutcome['binary'],
  score: number,
): CompositeOutcome {
  return {
    sessionId,
    source: 'cli-direct',
    testPass: null,
    buildPass: null,
    prLand: null,
    noRework: null,
    affirmation: null,
    score,
    linearLogit: 0,
    binary,
    weightsHash: 'h',
  };
}

async function writeFixtures(outDir: string): Promise<SessionManifest> {
  await mkdir(path.join(outDir, 'analysis'), { recursive: true });
  await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

  const sessions: UnifiedSessionEntry[] = [];
  const outcomes: CompositeOutcome[] = [];

  // 4 treated sessions (cwd contains 'chat-arch') — half good, half bad.
  for (let i = 0; i < 4; i += 1) {
    const id = `t-${i}`;
    sessions.push({
      id,
      source: 'cli-direct',
      title: id,
      preview: '',
      messageCount: 1,
      createdAt: 1_000 + i,
      startedAt: 1_000 + i,
      updatedAt: 1_000 + i,
      cwd: `C:/Users/Test/Projects/chat-arch`,
      projectId: 'chat-arch',
    } as UnifiedSessionEntry);
    outcomes.push(mkOutcome(id, i < 2 ? 'good' : 'bad', i < 2 ? 0.8 : 0.2));
  }

  // 4 control sessions (no chat-arch reference).
  for (let i = 0; i < 4; i += 1) {
    const id = `c-${i}`;
    sessions.push({
      id,
      source: 'cli-direct',
      title: id,
      preview: '',
      messageCount: 1,
      createdAt: 1_000 + i,
      startedAt: 1_000 + i,
      updatedAt: 1_000 + i,
      cwd: `C:/Users/Test/Projects/other-project`,
      projectId: 'other',
    } as UnifiedSessionEntry);
    outcomes.push(mkOutcome(id, i < 1 ? 'good' : 'bad', i < 1 ? 0.7 : 0.3));
  }

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
    weightsHash: 'h',
    generatedAt: 0,
    outcomes,
    scannedSessionIds: outcomes.map((o) => o.sessionId),
  };
  await writeFile(
    path.join(outDir, 'analysis', 'composite-outcomes.json'),
    JSON.stringify(composite, null, 2),
    'utf8',
  );
  return {
    schemaVersion: 1,
    generatedAt: 0,
    counts: { cli: 8, cloud: 0, cowork: 0, total: 8 },
    sessions,
  } as SessionManifest;
}

describe('buildReflexiveFile', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('happy path — matches treated vs control on cwd and computes delta + E-value', async () => {
    const outDir = path.join(tmpRoot, 'happy');
    const manifest = await writeFixtures(outDir);
    const r = await buildReflexiveFile(manifest, { outDir, now: 1 });
    expect(r.nTreated).toBe(4);
    expect(r.nControl).toBe(4);
    expect(r.file.result.pairs).toHaveLength(4);
    // Methodology surface set.
    expect(r.file.methodology.covariates.length).toBeGreaterThan(0);
    expect(r.file.methodology.notes.toLowerCase()).toContain('collider bias');
  });

  it('cache reuse surrogate — second run is deterministic (no in-file cache; pure recompute)', async () => {
    const outDir = path.join(tmpRoot, 'rerun');
    const manifest = await writeFixtures(outDir);
    const a = await buildReflexiveFile(manifest, { outDir, now: 1 });
    const b = await buildReflexiveFile(manifest, { outDir, now: 2 });
    expect(b.nTreated).toBe(a.nTreated);
    expect(b.file.result.meanDelta).toBe(a.file.result.meanDelta);
  });

  it('cache invalidation — empty composite sidecar produces empty result without error', async () => {
    const outDir = path.join(tmpRoot, 'empty');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    // No composite-outcomes.json — builder should emit a degraded but
    // structurally-valid sidecar.
    const manifest: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cli: 0, cloud: 0, cowork: 0, total: 0 },
      sessions: [],
    } as SessionManifest;
    const r = await buildReflexiveFile(manifest, { outDir, now: 1 });
    expect(r.nTreated).toBe(0);
    expect(r.nControl).toBe(0);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'reflexive.json'), 'utf8'),
    ) as ReflexiveFile;
    expect(onDisk.result.pairs).toHaveLength(0);
  });
});
