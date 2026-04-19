import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCoworkExport } from '../../src/sources/cowork.js';
import { runCliExport } from '../../src/sources/cli.js';
import { validateEntries } from '../../src/lib/validate-entry.js';
import { logger } from '../../src/lib/logger.js';
import type { UnifiedSessionEntry } from '@chat-arch/schema';

const LIVE = process.env['CHAT_ARCH_LIVE'] === '1';
const maybeDescribe = LIVE ? describe : describe.skip;

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cli-live-'));
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

maybeDescribe('LIVE CLI integration — runs only with CHAT_ARCH_LIVE=1', () => {
  it('produces ~157 (±13) entries, zero validation errors, <15s, with at least 4 enriched cli-desktop entries', async () => {
    // Phase 2 must run first so cli-desktop UUIDs are discoverable.
    await runCoworkExport({ outDir });

    const started = Date.now();
    const result = await runCliExport({ outDir });
    const elapsedMs = Date.now() - started;

    console.log(
      `[cli-live] entries=${result.entries.length} cli-direct=${result.counts['cli-direct']} cli-desktop=${result.counts['cli-desktop']} transcripts=${result.transcriptsCopied} skipped=${result.transcriptsSkipped} malformed=${result.malformedLinesTotal} elapsedMs=${elapsedMs}`,
    );

    // Count band — 157 ±13 per plan.
    expect(result.entries.length).toBeGreaterThanOrEqual(150);
    expect(result.entries.length).toBeLessThanOrEqual(170);

    // Perf gate.
    expect(elapsedMs).toBeLessThan(15_000);

    // Shape validation — zero errors on real data.
    const errors = validateEntries(result.entries);
    if (errors.length > 0) {
      console.error('[cli-live] validation errors:', errors.slice(0, 20));
    }
    expect(errors).toEqual([]);

    // At least 4 enriched cli-desktop entries with userTurns > 0.
    const desktopEnriched = result.entries.filter(
      (e) => e.source === 'cli-desktop' && e.userTurns > 0,
    );
    expect(desktopEnriched.length).toBeGreaterThanOrEqual(4);

    // Uniqueness under (source, id).
    const seen = new Set<string>();
    for (const e of result.entries) {
      const key = `${e.source}|${e.id}`;
      expect(seen.has(key), `duplicate (${key})`).toBe(false);
      seen.add(key);
    }

    // At least one entry's cwd contains '.' or '_' — proves lossy-path
    // avoidance (real cwd, not dir-name decoded).
    const lossyProof = result.entries.find(
      (e) => e.cwd !== undefined && (e.cwd.includes('.') || e.cwd.includes('_')),
    );
    expect(
      lossyProof,
      'expected at least one entry whose cwd retains "." or "_" — proves D15',
    ).toBeDefined();

    // transcriptPath exists on disk for every entry.
    for (const e of result.entries) {
      expect(e.transcriptPath, `entry ${e.id} has no transcriptPath`).toBeDefined();
      const abs = path.join(outDir, e.transcriptPath!);
      const st = await stat(abs);
      expect(st.isFile()).toBe(true);
    }

    // Round-trip cli-sessions.json.
    const parsed = JSON.parse(
      await readFile(path.join(outDir, 'cli-sessions.json'), 'utf8'),
    ) as UnifiedSessionEntry[];
    expect(parsed).toHaveLength(result.entries.length);
  }, 60_000);
});
