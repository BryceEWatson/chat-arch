import { describe, it, expect, afterEach } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runExport } from './index.js';

describe('runExport (Phase 1 stub)', () => {
  const outDir = path.join(
    os.tmpdir(),
    `chat-arch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('writes an empty manifest.json with schemaVersion 1', async () => {
    const result = await runExport({ outDir });
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.sessions).toHaveLength(0);
    const onDisk = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(onDisk.counts.cloud).toBe(0);
  });
});
