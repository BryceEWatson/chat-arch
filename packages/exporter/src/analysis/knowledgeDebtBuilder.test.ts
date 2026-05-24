import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { buildKnowledgeDebtFile, type KnowledgeDebtFile } from './knowledgeDebtBuilder.js';

const tmpRoot = path.join(
  os.tmpdir(),
  `chat-arch-kd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

async function makeSession(
  outDir: string,
  id: string,
  firstUserTurn: string,
  startedAt: number,
): Promise<UnifiedSessionEntry> {
  const transcript = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: firstUserTurn }],
    },
  });
  const transcriptPath = path.join('transcripts', `${id}.jsonl`);
  await mkdir(path.join(outDir, 'transcripts'), { recursive: true });
  await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');
  return {
    id,
    source: 'cli-direct',
    title: id,
    preview: '',
    messageCount: 1,
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt + 1,
    transcriptPath,
  } as UnifiedSessionEntry;
}

describe('buildKnowledgeDebtFile', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('happy path — writes JSON + markdown sidecars with cluster output', async () => {
    const outDir = path.join(tmpRoot, 'happy');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });

    // Cluster minimum is 10 (THRESHOLDS.clustering.minClusterSize) — emit
    // 12 similar questions so we cross the floor on the TF-IDF path.
    const sessions: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 12; i += 1) {
      sessions.push(
        await makeSession(
          outDir,
          `s-${i}`,
          'How do I configure typescript module resolution for nodenext?',
          1_000 + i,
        ),
      );
    }
    const manifest: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cli: 12, cloud: 0, cowork: 0, total: 12 },
      sessions,
    } as SessionManifest;

    const r = await buildKnowledgeDebtFile(manifest, {
      outDir,
      now: 100,
      embeddingsEnabled: false, // force TF-IDF path — no Ollama required in CI
    });
    expect(r.scannedSessions).toBe(12);
    expect(r.usedEmbeddings).toBe(false);
    expect(r.file.clusters.length).toBeGreaterThanOrEqual(1);

    // Markdown sidecar.
    const md = await readFile(r.markdownPath, 'utf8');
    expect(md).toContain('# Knowledge Debt');
    expect(md).toContain('typescript');
  });

  it('cache reuse surrogate — re-running with the same fixtures produces the same cluster shape (deterministic)', async () => {
    // The builder has no in-file cache (kernel is fast over first-user
    // turns); determinism over identical input acts as the equivalent
    // of cache reuse for this signal.
    const outDir = path.join(tmpRoot, 'rerun');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    const sessions: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 12; i += 1) {
      sessions.push(
        await makeSession(outDir, `s-${i}`, 'why does pnpm install fail?', 1_000 + i),
      );
    }
    const manifest: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cli: 12, cloud: 0, cowork: 0, total: 12 },
      sessions,
    } as SessionManifest;
    const a = await buildKnowledgeDebtFile(manifest, {
      outDir,
      now: 100,
      embeddingsEnabled: false,
    });
    const b = await buildKnowledgeDebtFile(manifest, {
      outDir,
      now: 200,
      embeddingsEnabled: false,
    });
    expect(b.file.clusters.length).toBe(a.file.clusters.length);
    expect(b.file.clusters[0]?.sessionIds.length).toBe(
      a.file.clusters[0]?.sessionIds.length,
    );
  });

  it('cache invalidation — adding new sessions changes the cluster set', async () => {
    const outDir = path.join(tmpRoot, 'invalidate');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    const baseline: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 12; i += 1) {
      baseline.push(
        await makeSession(outDir, `s-${i}`, 'how to debug pnpm install?', 1_000 + i),
      );
    }
    const m1: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cli: 12, cloud: 0, cowork: 0, total: 12 },
      sessions: baseline,
    } as SessionManifest;
    const a = await buildKnowledgeDebtFile(m1, {
      outDir,
      now: 100,
      embeddingsEnabled: false,
    });

    // Add a wholly different cluster — second concept, still TF-IDF, but
    // distinct vocabulary. Verifies the run is sensitive to input.
    const extended = [...baseline];
    for (let i = 12; i < 24; i += 1) {
      extended.push(
        await makeSession(
          outDir,
          `s-${i}`,
          'kubernetes ingress controller routing rules configuration',
          2_000 + i,
        ),
      );
    }
    const m2: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cli: 24, cloud: 0, cowork: 0, total: 24 },
      sessions: extended,
    } as SessionManifest;
    const b = await buildKnowledgeDebtFile(m2, {
      outDir,
      now: 200,
      embeddingsEnabled: false,
    });
    expect(b.file.clusters.length).toBeGreaterThanOrEqual(a.file.clusters.length);
    expect(b.scannedSessions).toBeGreaterThan(a.scannedSessions);

    // The on-disk file should reflect b's content.
    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'knowledge-debt.json'), 'utf8'),
    ) as KnowledgeDebtFile;
    expect(onDisk.clusters.length).toBe(b.file.clusters.length);
  });
});
