import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildConfigHistoryFile } from './configHistory.js';

const tmpRoot = path.join(
  os.tmpdir(),
  `chat-arch-confighist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
}

async function initRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

describe('buildConfigHistoryFile', () => {
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('happy path — extracts commits touching CLAUDE.md from a real git repo', async () => {
    const repo = path.join(tmpRoot, 'happy-repo');
    const outDir = path.join(tmpRoot, 'happy-out');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await initRepo(repo);

    await writeFile(path.join(repo, 'CLAUDE.md'), '# rev 1\n', 'utf8');
    git(repo, 'add', 'CLAUDE.md');
    git(repo, 'commit', '-q', '-m', 'add CLAUDE.md');

    await writeFile(path.join(repo, 'CLAUDE.md'), '# rev 2\n', 'utf8');
    git(repo, 'add', 'CLAUDE.md');
    git(repo, 'commit', '-q', '-m', 'tweak CLAUDE.md');

    const r = await buildConfigHistoryFile({
      outDir,
      now: 1_000,
      configDirs: [repo],
    });
    expect(r.scannedDirs).toBe(1);
    expect(r.skippedDirs).toBe(0);
    expect(r.file.commits.length).toBe(2);
    // Sorted ascending by ts; both touch CLAUDE.md.
    expect(r.file.commits.every((c) => /CLAUDE\.md/.test(c.path))).toBe(true);
    expect(r.file.commits[0]?.ts).toBeLessThanOrEqual(
      r.file.commits[1]?.ts ?? Infinity,
    );
  });

  it('tolerates missing dirs — non-existent and non-git paths are skipped', async () => {
    const outDir = path.join(tmpRoot, 'tolerant-out');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    const fakeDir = path.join(tmpRoot, 'does-not-exist');
    const plainDir = path.join(tmpRoot, 'not-a-repo');
    await mkdir(plainDir, { recursive: true });

    const r = await buildConfigHistoryFile({
      outDir,
      now: 1_000,
      configDirs: [fakeDir, plainDir],
    });
    expect(r.scannedDirs).toBe(0);
    expect(r.skippedDirs).toBe(2);
    expect(r.file.commits).toHaveLength(0);
  });

  it('cache invalidation surrogate — second run reflects new commits (no in-file cache, just deterministic re-scan)', async () => {
    const repo = path.join(tmpRoot, 'rerun-repo');
    const outDir = path.join(tmpRoot, 'rerun-out');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await initRepo(repo);
    await writeFile(path.join(repo, 'CLAUDE.md'), '# r1\n', 'utf8');
    git(repo, 'add', 'CLAUDE.md');
    git(repo, 'commit', '-q', '-m', 'r1');

    const first = await buildConfigHistoryFile({
      outDir,
      now: 1,
      configDirs: [repo],
    });
    expect(first.file.commits).toHaveLength(1);

    await writeFile(path.join(repo, 'CLAUDE.md'), '# r2\n', 'utf8');
    git(repo, 'add', 'CLAUDE.md');
    git(repo, 'commit', '-q', '-m', 'r2');

    const second = await buildConfigHistoryFile({
      outDir,
      now: 2,
      configDirs: [repo],
    });
    expect(second.file.commits).toHaveLength(2);
    // Fresh re-scan: timestamps strictly nondecreasing.
    expect(second.file.commits[0]?.ts).toBeLessThanOrEqual(
      second.file.commits[1]?.ts ?? Infinity,
    );
  });
});
