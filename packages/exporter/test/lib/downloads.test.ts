import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findLatestExportZip } from '../../src/lib/downloads.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-dl-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('findLatestExportZip', () => {
  it('returns null when the directory does not exist', async () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(await findLatestExportZip(missing)).toBeNull();
  });

  it('returns null when no matching files exist', async () => {
    await writeFile(path.join(tmpDir, 'random.txt'), 'nope', 'utf8');
    await writeFile(path.join(tmpDir, 'archive.zip'), 'nope', 'utf8');
    expect(await findLatestExportZip(tmpDir)).toBeNull();
  });

  it('picks the most recently modified matching ZIP', async () => {
    const olderName =
      'data-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-1700000000-deadbeef-batch-0000.zip';
    const newerName =
      'data-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-1800000000-cafe1234-batch-0001.zip';
    const noiseName = 'random.zip';
    const older = path.join(tmpDir, olderName);
    const newer = path.join(tmpDir, newerName);
    const noise = path.join(tmpDir, noiseName);
    await writeFile(older, 'x', 'utf8');
    await writeFile(newer, 'x', 'utf8');
    await writeFile(noise, 'x', 'utf8');

    const oldStamp = new Date('2024-01-01T00:00:00Z');
    const newStamp = new Date('2026-04-15T00:00:00Z');
    await utimes(older, oldStamp, oldStamp);
    await utimes(newer, newStamp, newStamp);

    const found = await findLatestExportZip(tmpDir);
    expect(found).toBe(newer);
  });

  it('matches the full regex including batch suffix', async () => {
    const valid = 'data-abc-1-deadbeef-batch-0000.zip';
    const invalid = 'data-abc-1-deadbeef-not-a-batch.zip';
    await writeFile(path.join(tmpDir, valid), 'x', 'utf8');
    await writeFile(path.join(tmpDir, invalid), 'x', 'utf8');
    const found = await findLatestExportZip(tmpDir);
    expect(found).toBe(path.join(tmpDir, valid));
  });
});
