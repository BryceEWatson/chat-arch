import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { runCoworkExport } from '../../src/sources/cowork.js';
import { validateEntries } from '../../src/lib/validate-entry.js';
import { logger } from '../../src/lib/logger.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_APPDATA = path.join(here, '..', 'fixtures', 'appdata-fixture');

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-e2e-'));
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

describe('cowork integration (fixture appdata → outDir)', () => {
  it('produces the expected output layout, validates shape, and has no duplicate (source,id) pairs', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });

    // Output file exists and is parseable.
    const file = path.join(outDir, 'cowork-sessions.json');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);

    // Manifest copies landed in the right subdirs with the R3 naming.
    const coworkManifests = await readdir(path.join(outDir, 'manifests', 'cowork'));
    expect(coworkManifests).toHaveLength(4); // corrupt skipped
    expect(coworkManifests.every((n) => /^local_[0-9a-f-]+\.json$/.test(n))).toBe(true);

    const cliManifests = await readdir(path.join(outDir, 'manifests', 'cli-desktop'));
    expect(cliManifests).toHaveLength(2);

    // Transcripts: mid + new + scheduled (3); old had no cliSessionId.
    const transcripts = await readdir(path.join(outDir, 'local-transcripts', 'cowork'));
    expect(transcripts).toHaveLength(3);

    // Shape validation — zero errors.
    const errors = validateEntries(result.entries);
    expect(errors).toEqual([]);

    // No duplicate (source, id).
    const seen = new Set<string>();
    for (const e of result.entries) {
      const key = `${e.source}|${e.id}`;
      expect(seen.has(key), `duplicate (${key})`).toBe(false);
      seen.add(key);
    }

    // No audits/ directory was created (Q1).
    const layout = await readdir(outDir);
    expect(layout).not.toContain('audits');
  });
});
