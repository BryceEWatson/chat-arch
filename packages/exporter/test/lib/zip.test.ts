import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { unzipTo } from '../../src/lib/zip.js';

const execFileP = promisify(execFile);

let stagingDir: string;
let zipPath: string;
let destDir: string;

beforeEach(async () => {
  stagingDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-zip-stage-'));
  destDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-zip-dest-'));
  zipPath = path.join(stagingDir, '..', path.basename(stagingDir) + '.zip');
});

afterEach(async () => {
  await rm(stagingDir, { recursive: true, force: true });
  await rm(destDir, { recursive: true, force: true });
  await rm(zipPath, { force: true });
});

/**
 * Build a ZIP via PowerShell Compress-Archive — available on all modern
 * Windows hosts. We use this purely as fixture-construction; the library
 * under test is our yauzl wrapper, not PowerShell.
 */
async function buildZipWithPowerShell(sourceDir: string, outZip: string): Promise<void> {
  await execFileP('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${outZip}' -Force`,
  ]);
}

describe('unzipTo (yauzl wrapper)', () => {
  it('extracts a small ZIP produced by PowerShell Compress-Archive to disk', async () => {
    // Prepare a small tree.
    await writeFile(
      path.join(stagingDir, 'conversations.json'),
      JSON.stringify([{ uuid: 'x' }]),
      'utf8',
    );
    await writeFile(path.join(stagingDir, 'users.json'), '[]', 'utf8');
    await mkdir(path.join(stagingDir, 'sub'), { recursive: true });
    await writeFile(path.join(stagingDir, 'sub', 'inner.txt'), 'hello', 'utf8');

    await buildZipWithPowerShell(stagingDir, zipPath);

    await unzipTo(zipPath, destDir);

    const out = await readFile(path.join(destDir, 'conversations.json'), 'utf8');
    expect(JSON.parse(out)).toEqual([{ uuid: 'x' }]);

    const users = await readFile(path.join(destDir, 'users.json'), 'utf8');
    expect(users).toBe('[]');

    const inner = await readFile(path.join(destDir, 'sub', 'inner.txt'), 'utf8');
    expect(inner).toBe('hello');
  }, 30_000);

  it('rejects on a missing ZIP path', async () => {
    await expect(unzipTo(path.join(stagingDir, 'does-not-exist.zip'), destDir)).rejects.toThrow();
  });
});
