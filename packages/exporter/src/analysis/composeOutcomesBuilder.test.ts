import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CompositeOutcomesFile, SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import {
  COMPOSITE_VERSION,
  WEIGHTS_VERSION,
  buildCompositeOutcomesFile,
} from './composeOutcomesBuilder.js';

const tmpRoot = path.join(
  os.tmpdir(),
  `chat-arch-composite-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

interface Fixture {
  outDir: string;
  manifest: SessionManifest;
}

async function makeFixture(subdir: string): Promise<Fixture> {
  const outDir = path.join(tmpRoot, subdir);
  await mkdir(path.join(outDir, 'analysis'), { recursive: true });
  await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

  // Session with a tests-pass-claim followed by a passing Bash test.
  // Verifier should resolve tests-pass-claim → pass, composite primary
  // testPass → true, weight > 0 contributes positively to logit.
  const transcript = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'All tests pass now.' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'PASS', is_error: false }],
      },
    }),
  ].join('\n');
  const transcriptPath = path.join('transcripts', 'sess-1.jsonl');
  await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

  const entry: UnifiedSessionEntry = {
    id: 'sess-1',
    source: 'cli-direct',
    title: 'fixture',
    preview: '',
    messageCount: 3,
    createdAt: 0,
    updatedAt: 100,
    transcriptPath,
  } as UnifiedSessionEntry;
  const manifest: SessionManifest = {
    schemaVersion: 1,
    generatedAt: 0,
    counts: { cli: 1, cloud: 0, cowork: 0, total: 1 },
    sessions: [entry],
  } as SessionManifest;
  return { outDir, manifest };
}

describe('buildCompositeOutcomesFile', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('happy path — extracts test-pass primary signal and writes the sidecar atomically', async () => {
    const { outDir, manifest } = await makeFixture('happy');
    const result = await buildCompositeOutcomesFile(manifest, {
      outDir,
      now: 1_000,
    });

    expect(result.scannedSessions).toBe(1);
    expect(result.reusedSessions).toBe(0);
    expect(result.missingTranscripts).toBe(0);
    expect(result.file.outcomes).toHaveLength(1);

    const row = result.file.outcomes[0];
    expect(row?.sessionId).toBe('sess-1');
    expect(row?.testPass).toBe(true);
    // weightsHash is propagated from kernel; root and row agree.
    expect(row?.weightsHash).toBe(result.file.weightsHash);
    expect(result.file.compositeVersion).toBe(COMPOSITE_VERSION);
    expect(result.file.weightsVersion).toBe(WEIGHTS_VERSION);

    // The file was written atomically — tmp must be gone, canonical present.
    const canonical = path.join(outDir, 'analysis', 'composite-outcomes.json');
    const onDisk = JSON.parse(await readFile(canonical, 'utf8')) as CompositeOutcomesFile;
    expect(onDisk.outcomes).toHaveLength(1);
    expect(onDisk.weightsHash).toBe(row?.weightsHash);

    await expect(readFile(`${canonical}.tmp`, 'utf8')).rejects.toThrow();
  });

  it('cache reuse — second pass with no transcript changes reuses prior rows', async () => {
    const { outDir, manifest } = await makeFixture('reuse');
    // updatedAt=100, first generatedAt=200 → cached on second run.
    await buildCompositeOutcomesFile(manifest, { outDir, now: 200 });

    const second = await buildCompositeOutcomesFile(manifest, { outDir, now: 300 });
    expect(second.reusedSessions).toBe(1);
    expect(second.scannedSessions).toBe(0);
    // Row content preserved across the reuse.
    expect(second.file.outcomes[0]?.testPass).toBe(true);
  });

  it('automation-exclusion — automated session is excluded, interactive twin included', async () => {
    const { outDir, manifest } = await makeFixture('automation');
    // Add an automated twin pointing at the SAME transcript as sess-1 so
    // the only difference is `automationTemplateId`. The interactive
    // session must compose an outcome; the automated one must not.
    const interactive = manifest.sessions[0] as UnifiedSessionEntry;
    const automated: UnifiedSessionEntry = {
      ...interactive,
      id: 'sess-auto',
      automationTemplateId: 'status-paragraph',
    } as UnifiedSessionEntry;
    const twoManifest: SessionManifest = {
      ...manifest,
      sessions: [interactive, automated],
    } as SessionManifest;

    const result = await buildCompositeOutcomesFile(twoManifest, {
      outDir,
      now: 1_000,
    });

    expect(result.scannedSessions).toBe(1);
    expect(result.file.outcomes).toHaveLength(1);
    const ids = result.file.outcomes.map((o) => o.sessionId);
    expect(ids).toContain('sess-1');
    expect(ids).not.toContain('sess-auto');
    expect(result.file.scannedSessionIds).not.toContain('sess-auto');
  });

  it('cache invalidation — bumping the weightsHash invalidates every row', async () => {
    const { outDir, manifest } = await makeFixture('invalidate');
    await buildCompositeOutcomesFile(manifest, { outDir, now: 200 });

    // Pass custom weights; the FNV hash will differ → cache miss.
    const customWeights = {
      testPass: 0.99, // changed
      testFail: -0.4,
      buildPass: 0.2,
      prLandMerged: 0.5,
      prLandClosedUnmerged: -0.3,
      reworkSameSession: -0.2,
      reworkContinuation: -0.25,
      affirmation: 0.1,
    } as const;
    const second = await buildCompositeOutcomesFile(manifest, {
      outDir,
      now: 300,
      weights: { ...customWeights },
    });
    expect(second.reusedSessions).toBe(0);
    expect(second.scannedSessions).toBe(1);
  });
});
