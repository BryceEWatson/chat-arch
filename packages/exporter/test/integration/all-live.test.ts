import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionManifest } from '@chat-arch/schema';
import { runCoworkExport } from '../../src/sources/cowork.js';
import { runCliExport } from '../../src/sources/cli.js';
import { runCloudExport } from '../../src/sources/cloud.js';
import { mergeSources } from '../../src/merge.js';
import { validateEntries } from '../../src/lib/validate-entry.js';
import { logger } from '../../src/lib/logger.js';

const LIVE = process.env['CHAT_ARCH_LIVE'] === '1';
const maybeDescribe = LIVE ? describe : describe.skip;

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-all-live-'));
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

maybeDescribe('LIVE all integration — runs only with CHAT_ARCH_LIVE=1', () => {
  it('merges cowork + cli + cloud into a unified manifest with all 4 source counts and total ≈ 1463 ±15, <30s wall-clock', async () => {
    const started = Date.now();

    const cowork = await runCoworkExport({ outDir });
    const cli = await runCliExport({ outDir });
    const cloud = await runCloudExport({ outDir });

    const merged = mergeSources(cowork.entries, cli.entries, cloud.entries);
    const manifestAbs = path.join(outDir, 'manifest.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(manifestAbs, JSON.stringify(merged, null, 2) + '\n', 'utf8');

    const elapsedMs = Date.now() - started;
    console.log(
      `[all-live] merged=${merged.sessions.length} cowork=${merged.counts.cowork} cli-direct=${merged.counts['cli-direct']} cli-desktop=${merged.counts['cli-desktop']} cloud=${merged.counts.cloud} elapsedMs=${elapsedMs}`,
    );

    // Every source must have a non-zero count.
    expect(merged.counts.cowork).toBeGreaterThan(0);
    expect(merged.counts['cli-direct']).toBeGreaterThan(0);
    expect(merged.counts['cli-desktop']).toBeGreaterThan(0);
    expect(merged.counts.cloud).toBeGreaterThan(0);

    // Total count band.
    expect(merged.sessions.length).toBeGreaterThanOrEqual(1448);
    expect(merged.sessions.length).toBeLessThanOrEqual(1478);

    // Perf budget.
    expect(elapsedMs).toBeLessThan(30_000);

    // Shape validation across the merged manifest.
    const errors = validateEntries(merged.sessions);
    if (errors.length > 0) {
      console.error('[all-live] validation errors:', errors.slice(0, 20));
    }
    expect(errors).toEqual([]);

    // Uniqueness under (source, id).
    const seen = new Set<string>();
    for (const e of merged.sessions) {
      const key = `${e.source}|${e.id}`;
      expect(seen.has(key), `duplicate (${key})`).toBe(false);
      seen.add(key);
    }

    // Viewer-fetchable — parseable from disk.
    const disk = JSON.parse(await readFile(manifestAbs, 'utf8')) as SessionManifest;
    expect(disk.schemaVersion).toBe(1);
    expect(disk.sessions).toHaveLength(merged.sessions.length);
    expect(disk.counts).toEqual(merged.counts);
  }, 90_000);
});
