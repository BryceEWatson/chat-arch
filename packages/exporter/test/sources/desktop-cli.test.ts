import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processDesktopCliManifest } from '../../src/sources/desktop-cli.js';
import { logger } from '../../src/lib/logger.js';

let outDir: string;
const warnings: string[] = [];

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cli-desktop-'));
  await mkdir(path.join(outDir, 'manifests', 'cli-desktop'), { recursive: true });
  warnings.length = 0;
  logger.setSink((line) => {
    warnings.push(line);
  });
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

describe('processDesktopCliManifest', () => {
  it('builds an entry with userTurns=0, titleSource=manifest, and preserves the [1m] model suffix', async () => {
    const fixture = path.join(outDir, 'fixture.json');
    await writeFile(
      fixture,
      JSON.stringify({
        sessionId: 'local_cli-x-1',
        cliSessionId: 'cli-x-1-uuid',
        cwd: 'C:\\Users\\<r>\\Projects\\x',
        originCwd: 'C:\\Users\\<r>\\Projects\\x',
        createdAt: 1000,
        lastActivityAt: 5000,
        model: 'claude-opus-4-7[1m]',
        effort: 'xhigh',
        isArchived: false,
        title: '<redacted>',
        titleSource: 'auto',
        permissionMode: 'bypassPermissions',
        chromePermissionMode: 'skip_all_permission_checks',
        enabledMcpTools: {},
        remoteMcpServersConfig: [],
      }),
      'utf8',
    );
    const res = await processDesktopCliManifest(fixture, outDir);
    expect(res).not.toBeNull();
    const entry = res?.entry;
    expect(entry?.source).toBe('cli-desktop');
    expect(entry?.id).toBe('cli-x-1-uuid');
    expect(entry?.rawSessionId).toBe('local_cli-x-1');
    expect(entry?.userTurns).toBe(0);
    expect(entry?.titleSource).toBe('manifest');
    expect(entry?.model).toBe('claude-opus-4-7[1m]');
    expect(entry?.cwdKind).toBe('host');
    expect(entry?.totalCostUsd).toBeNull();
    expect(entry?.preview).toBeNull();
    expect(entry?.transcriptPath).toBeUndefined();
    expect(entry?.durationMs).toBe(4000);
    expect(res?.reused).toBe(false);
  });

  it('returns null and logs a warning when the manifest is not valid JSON', async () => {
    const fixture = path.join(outDir, 'broken.json');
    await writeFile(fixture, '{ not valid json', 'utf8');
    const res = await processDesktopCliManifest(fixture, outDir);
    expect(res).toBeNull();
    expect(warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
  });

  it('emits a warnOnce for unknown forward-compat keys but still emits the entry', async () => {
    const fixture = path.join(outDir, 'drift.json');
    await writeFile(
      fixture,
      JSON.stringify({
        sessionId: 'local_cli-drift',
        cliSessionId: 'cli-drift-uuid',
        cwd: 'C:\\x',
        originCwd: 'C:\\x',
        createdAt: 1,
        lastActivityAt: 2,
        model: 'claude-opus-4-7[1m]',
        effort: 'high',
        isArchived: false,
        title: 't',
        titleSource: 'auto',
        permissionMode: 'x',
        chromePermissionMode: 'y',
        enabledMcpTools: {},
        remoteMcpServersConfig: [],
        futureKey: '<r>',
      }),
      'utf8',
    );
    const res = await processDesktopCliManifest(fixture, outDir);
    expect(res).not.toBeNull();
    expect(warnings.some((w) => w.includes('unknown key "futureKey"'))).toBe(true);
  });

  it('reuses an entry verbatim on the second call when the manifest mtime is unchanged', async () => {
    const fixture = path.join(outDir, 'reuse.json');
    await writeFile(
      fixture,
      JSON.stringify({
        sessionId: 'local_cli-reuse',
        cliSessionId: 'cli-reuse-uuid',
        cwd: 'C:\\x',
        originCwd: 'C:\\x',
        createdAt: 1,
        lastActivityAt: 2,
        model: 'claude-opus-4-7',
        effort: 'high',
        isArchived: false,
        title: 't',
        titleSource: 'auto',
        permissionMode: 'x',
        chromePermissionMode: 'y',
        enabledMcpTools: {},
        remoteMcpServersConfig: [],
      }),
      'utf8',
    );
    const first = await processDesktopCliManifest(fixture, outDir);
    expect(first?.reused).toBe(false);
    expect(typeof first?.entry.sourceMtimeMs).toBe('number');

    // Seed a "previous" cache and re-process.
    const prev = new Map<string, (typeof first)['entry']>();
    if (first) prev.set(`cli-desktop:${first.entry.id}`, first.entry);
    const second = await processDesktopCliManifest(fixture, outDir, prev as never);
    expect(second?.reused).toBe(true);
    expect(second?.entry).toBe(first?.entry); // same reference, verbatim reuse
  });
});
