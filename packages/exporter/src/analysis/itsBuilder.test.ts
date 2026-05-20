import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CompositeOutcomesFile } from '@chat-arch/schema';
import { buildItsAnalysisFile, type ItsFile } from './itsBuilder.js';
import type { ConfigHistoryFile } from './configHistory.js';

const tmpRoot = path.join(
  os.tmpdir(),
  `chat-arch-its-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

async function writeFixtures(
  outDir: string,
  opts: { withComposite: boolean; withConfig: boolean },
): Promise<void> {
  await mkdir(path.join(outDir, 'analysis'), { recursive: true });
  if (opts.withComposite) {
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
      outcomes: [
        {
          sessionId: 's-pre',
          source: 'cli-direct',
          testPass: false,
          buildPass: null,
          prLand: null,
          noRework: null,
          affirmation: null,
          score: 0.2,
          linearLogit: -1,
          binary: 'bad',
          weightsHash: 'h',
        },
        {
          sessionId: 's-post',
          source: 'cli-direct',
          testPass: true,
          buildPass: true,
          prLand: 'merged',
          noRework: null,
          affirmation: true,
          score: 0.8,
          linearLogit: 1.5,
          binary: 'good',
          weightsHash: 'h',
        },
      ],
      scannedSessionIds: ['s-pre', 's-post'],
    };
    await writeFile(
      path.join(outDir, 'analysis', 'composite-outcomes.json'),
      JSON.stringify(composite, null, 2),
      'utf8',
    );
  }
  if (opts.withConfig) {
    const config: ConfigHistoryFile = {
      version: 1,
      generatedAt: 0,
      commits: [
        {
          sha: 'abc',
          ts: 100_000,
          path: 'CLAUDE.md',
          subject: 'tweak rules',
        },
      ],
    };
    await writeFile(
      path.join(outDir, 'analysis', 'config-history.json'),
      JSON.stringify(config, null, 2),
      'utf8',
    );
  }
}

describe('buildItsAnalysisFile', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('happy path — joins composite outcomes + config commits into ITS contrasts', async () => {
    const outDir = path.join(tmpRoot, 'happy');
    await writeFixtures(outDir, { withComposite: true, withConfig: true });

    // s-pre at ts < commit, s-post at ts > commit → contrast windows populate.
    const sessionUpdatedAt = new Map<string, number>([
      ['s-pre', 50_000],
      ['s-post', 150_000],
    ]);
    const r = await buildItsAnalysisFile({
      outDir,
      now: 1,
      sessionUpdatedAt,
      windowDays: 1, // 1 day = 86_400_000 ms, well covers our 50k/150k
    });
    expect(r.commitsAnalyzed).toBe(1);
    const onDisk = JSON.parse(
      await readFile(path.join(outDir, 'analysis', 'its-analysis.json'), 'utf8'),
    ) as ItsFile;
    expect(onDisk.results).toHaveLength(1);
    expect(onDisk.results[0]?.pre.n).toBe(1);
    expect(onDisk.results[0]?.post.n).toBe(1);
  });

  it('missing prerequisite — emits empty results file gracefully', async () => {
    const outDir = path.join(tmpRoot, 'missing');
    await writeFixtures(outDir, { withComposite: false, withConfig: false });

    const r = await buildItsAnalysisFile({
      outDir,
      now: 1,
      sessionUpdatedAt: new Map(),
    });
    expect(r.commitsAnalyzed).toBe(0);
    expect(r.file.results).toHaveLength(0);
  });

  it('reuses kernel output across runs deterministically (no in-file cache, recompute always)', async () => {
    const outDir = path.join(tmpRoot, 'rerun');
    await writeFixtures(outDir, { withComposite: true, withConfig: true });
    const sessionUpdatedAt = new Map<string, number>([
      ['s-pre', 50_000],
      ['s-post', 150_000],
    ]);
    const a = await buildItsAnalysisFile({
      outDir,
      now: 1,
      sessionUpdatedAt,
      windowDays: 1,
    });
    const b = await buildItsAnalysisFile({
      outDir,
      now: 2,
      sessionUpdatedAt,
      windowDays: 1,
    });
    expect(b.commitsAnalyzed).toBe(a.commitsAnalyzed);
    expect(b.file.results[0]?.pre.n).toBe(a.file.results[0]?.pre.n);
    expect(b.file.results[0]?.post.n).toBe(a.file.results[0]?.post.n);
  });
});
