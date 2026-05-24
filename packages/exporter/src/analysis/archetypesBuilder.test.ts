import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { buildArchetypesFile } from './archetypesBuilder.js';

/**
 * Three required cases:
 *   - happy path: enough varied sessions to surface centroids
 *   - cache reuse: archetype clustering is whole-corpus (no per-session
 *     cache), so the "reuse" guarantee here is "same input + same seed
 *     → same archetypeVersion across runs"
 *   - missing-input-graceful: a manifest with zero sessions that carry
 *     `topTools` produces a valid, empty file
 */
describe('buildArchetypesFile', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    `chat-arch-archetypes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  function makeEntry(
    id: string,
    tools: Record<string, number> | undefined,
  ): UnifiedSessionEntry {
    return {
      id,
      source: 'cli-direct',
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
      ...(tools !== undefined ? { topTools: tools } : {}),
    } as UnifiedSessionEntry;
  }

  function makeManifest(sessions: UnifiedSessionEntry[]): SessionManifest {
    return {
      schemaVersion: 4,
      generatedAt: 0,
      counts: { 'cli-direct': sessions.length, 'cli-desktop': 0, cowork: 0, cloud: 0 },
      sessions,
    } as SessionManifest;
  }

  it('happy path: clusters varied sessions, emits archetypeVersion, writes file', async () => {
    const outDir = path.join(tmpRoot, 'happy');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    // Build 60 sessions across two distinct profiles so the kernel
    // (k=5..7, archetypeMinSize=20) has enough mass to surface ≥1
    // archetype. The shape doesn't matter for this test; just that we
    // get a valid file out and the version hash is non-zero.
    const sessions: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      sessions.push(
        makeEntry(`read-${i}`, {
          Read: 10 + i % 3,
          Edit: 1,
          Bash: 0,
        }),
      );
    }
    for (let i = 0; i < 30; i += 1) {
      sessions.push(
        makeEntry(`edit-${i}`, {
          Read: 1,
          Edit: 15 + (i % 4),
          Bash: 3,
        }),
      );
    }

    const result = await buildArchetypesFile(makeManifest(sessions), {
      outDir,
      now: 1,
      seed: 42,
    });

    expect(result.scannedSessions).toBe(60);
    expect(result.skippedSessions).toBe(0);
    expect(result.file.archetypeVersion).not.toBe(0);
    expect(result.file.chosenK).toBeGreaterThan(0);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'archetypes.json'), 'utf8'),
    );
    expect(onDisk.version).toBe(1);
    expect(typeof onDisk.archetypeVersion).toBe('number');
    expect(Object.keys(onDisk.assignments)).toHaveLength(60);
  });

  it('determinism: same input + same seed → same archetypeVersion (reuse guarantee)', async () => {
    const outDir = path.join(tmpRoot, 'reuse');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    const sessions: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 50; i += 1) {
      sessions.push(
        makeEntry(`s-${i}`, {
          Read: 5 + (i % 2),
          Edit: i % 3 === 0 ? 10 : 1,
          Bash: i % 5,
        }),
      );
    }
    const manifest = makeManifest(sessions);

    const first = await buildArchetypesFile(manifest, { outDir, now: 1, seed: 42 });
    const second = await buildArchetypesFile(manifest, { outDir, now: 2, seed: 42 });
    expect(second.file.archetypeVersion).toBe(first.file.archetypeVersion);
    expect(second.file.chosenK).toBe(first.file.chosenK);
  });

  it('missing-input-graceful: zero sessions with topTools → empty file, no crash', async () => {
    const outDir = path.join(tmpRoot, 'empty');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    const sessions = [
      makeEntry('no-tools-1', undefined),
      makeEntry('no-tools-2', undefined),
    ];
    const result = await buildArchetypesFile(makeManifest(sessions), {
      outDir,
      now: 1,
    });
    expect(result.scannedSessions).toBe(0);
    expect(result.skippedSessions).toBe(2);
    expect(result.file.centroids).toEqual([]);

    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'archetypes.json'), 'utf8'),
    );
    expect(onDisk.centroids).toEqual([]);
    expect(onDisk.assignments).toEqual({});
  });
});
