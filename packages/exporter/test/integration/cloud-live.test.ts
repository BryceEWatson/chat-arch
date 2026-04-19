import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { runCloudExport } from '../../src/sources/cloud.js';
import { validateEntries } from '../../src/lib/validate-entry.js';
import { logger } from '../../src/lib/logger.js';

const LIVE = process.env['CHAT_ARCH_LIVE'] === '1';
const maybeDescribe = LIVE ? describe : describe.skip;

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cloud-live-'));
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

maybeDescribe('LIVE cloud integration — runs only with CHAT_ARCH_LIVE=1', () => {
  it('produces 1033 ±5 entries, 285 ±5 summaries, <20s wall-clock, zero validation errors, "Visualizing chat history data" present', async () => {
    const started = Date.now();
    const result = await runCloudExport({ outDir });
    const elapsedMs = Date.now() - started;

    console.log(
      `[cloud-live] zip=${result.zipPath} entries=${result.entries.length} skipped=${result.conversationsSkipped} elapsedMs=${elapsedMs}`,
    );

    // Count band.
    expect(result.entries.length).toBeGreaterThanOrEqual(1028);
    expect(result.entries.length).toBeLessThanOrEqual(1038);

    // Summary band (27.6% expected — 285 ±5).
    const summaryCount = result.entries.filter((e) => e.summary !== undefined).length;
    console.log(`[cloud-live] with-summary=${summaryCount}`);
    expect(summaryCount).toBeGreaterThanOrEqual(280);
    expect(summaryCount).toBeLessThanOrEqual(290);

    // Perf gate.
    expect(elapsedMs).toBeLessThan(20_000);

    // Canary entry.
    const canary = result.entries.find((e) => e.title === 'Visualizing chat history data');
    expect(canary, 'expected "Visualizing chat history data" conversation').toBeDefined();

    // Shape validation.
    const errors = validateEntries(result.entries);
    if (errors.length > 0) {
      console.error('[cloud-live] validation errors:', errors.slice(0, 20));
    }
    expect(errors).toEqual([]);

    // Uniqueness under (source, id).
    const seen = new Set<string>();
    for (const e of result.entries) {
      const key = `${e.source}|${e.id}`;
      expect(seen.has(key), `duplicate (${key})`).toBe(false);
      seen.add(key);
    }

    // Every entry has a transcriptPath that exists on disk.
    for (const e of result.entries.slice(0, 50)) {
      expect(e.transcriptPath).toBeDefined();
      const abs = path.join(outDir, e.transcriptPath!);
      const st = await stat(abs);
      expect(st.isFile()).toBe(true);
    }

    // Round-trip the manifest.
    const parsed = JSON.parse(
      await readFile(path.join(outDir, 'cloud-manifest.json'), 'utf8'),
    ) as UnifiedSessionEntry[];
    expect(parsed).toHaveLength(result.entries.length);
  }, 60_000);
});
