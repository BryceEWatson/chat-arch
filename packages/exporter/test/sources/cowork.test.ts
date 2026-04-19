import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { runCoworkExport } from '../../src/sources/cowork.js';
import { logger } from '../../src/lib/logger.js';
import type { UnifiedSessionEntry } from '@chat-arch/schema';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_APPDATA = path.join(here, '..', 'fixtures', 'appdata-fixture');

let outDir: string;
const warnings: string[] = [];

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cowork-test-'));
  warnings.length = 0;
  logger.setSink((line) => {
    warnings.push(line);
  });
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

describe('runCoworkExport (fixture)', () => {
  it('walks both roots and emits one entry per valid manifest', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    // 5 Cowork manifests on disk: old/mid/new/corrupt/scheduled. The corrupt
    // one is skipped, so 4 entries. 2 Desktop-CLI entries. Total 6.
    expect(result.counts.cowork).toBe(4);
    expect(result.counts['cli-desktop']).toBe(2);
    expect(result.entries.length).toBe(6);
    expect(result.sessionsSkipped).toBe(1);
  });

  it('writes cowork-sessions.json as valid JSON that parses back to the same entries', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    const file = path.join(outDir, 'cowork-sessions.json');
    const roundtripped = JSON.parse(await readFile(file, 'utf8')) as UnifiedSessionEntry[];
    expect(roundtripped).toHaveLength(result.entries.length);
    expect(roundtripped.map((e) => e.id).sort()).toEqual(result.entries.map((e) => e.id).sort());
  });

  it('falls back to stripped sessionId for entry id when manifest has no cliSessionId (old-schema Cowork)', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    const old = result.entries.find(
      (e) => e.rawSessionId === 'local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    );
    expect(old).toBeDefined();
    expect(old?.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    // No audit file → no result → no transcript copied.
    expect(old?.totalCostUsd).toBeNull();
    expect(old?.transcriptPath).toBeUndefined();
  });

  it('uses wall-clock durationMs (updatedAt - startedAt), never the summed audit durations (R2)', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    const mid = result.entries.find(
      (e) => e.rawSessionId === 'local_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    );
    expect(mid).toBeDefined();
    // Manifest: 1741020000000 → 1741020216000 = 216_000 ms. Summed result = 180_000.
    expect(mid?.durationMs).toBe(216_000);
    expect(mid?.totalCostUsd).toBeCloseTo(0.4, 10);
  });

  it('copies the embedded transcript and uses a POSIX-relative path in the entry', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    const mid = result.entries.find(
      (e) => e.rawSessionId === 'local_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    );
    expect(mid?.transcriptPath).toBe(
      'local-transcripts/cowork/bbbbbbbb-cccc-cccc-cccc-bbbbbbbbbbbb.jsonl',
    );
    // File must exist on disk.
    const abs = path.join(outDir, mid!.transcriptPath!);
    await expect(readFile(abs, 'utf8')).resolves.toContain('"type":"user"');
  });

  it('surfaces topTools on the cowork entry mined from the copied transcript (the real fix)', async () => {
    // The `mid` fixture transcript has two tool-using assistant lines:
    // Bash×2 + Read×1. audit.jsonl cannot carry tool names, so this
    // extraction is purely driven by the transcript.
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    const mid = result.entries.find(
      (e) => e.rawSessionId === 'local_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    );
    expect(mid?.topTools).toEqual({ Bash: 2, Read: 1 });
  });

  it('omits topTools on cowork entries whose transcript has no tool_use blocks', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    // The `old` fixture has no transcript on disk at all.
    const old = result.entries.find(
      (e) => e.rawSessionId === 'local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    );
    expect(old?.topTools).toBeUndefined();
  });

  it('emits warnOnce for forward-compat drift keys and still produces the entry', async () => {
    await runCoworkExport({ outDir, appDataClaudeRoot: FIXTURE_APPDATA });
    const driftWarns = warnings.filter((w) => w.includes('unknown key "fsDetectedFiles"'));
    expect(driftWarns).toHaveLength(1);
  });

  it('falls back to vmProcessName when processName does not locate the transcript (R10)', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    const scheduled = result.entries.find(
      (e) => e.rawSessionId === 'local_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    );
    expect(scheduled).toBeDefined();
    expect(scheduled?.transcriptPath).toBe(
      'local-transcripts/cowork/eeeeeeee-ffff-ffff-ffff-eeeeeeeeeeee.jsonl',
    );
  });

  it('truncates scheduled-task XML initialMessage to 200 chars (N2 pinning)', async () => {
    const result = await runCoworkExport({
      outDir,
      appDataClaudeRoot: FIXTURE_APPDATA,
    });
    const scheduled = result.entries.find(
      (e) => e.rawSessionId === 'local_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    );
    expect(scheduled?.preview).not.toBeNull();
    expect(scheduled!.preview!.startsWith('<')).toBe(true);
    expect(scheduled!.preview!.length).toBeLessThanOrEqual(200);
  });

  // Regression: "result line absent but assistant lines present" is a real
  // Cowork shape (~6% of observed live sessions). The gate must derive
  // assistantTurns from audit.assistantTurns, not from audit.resultLineCount.
  it('emits assistantTurns when audit has assistant lines but no result line', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-c5-'));
    try {
      const sessionDir = path.join(
        root,
        'local-agent-mode-sessions',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      );
      await mkdir(sessionDir, { recursive: true });
      const manifest = {
        sessionId: 'local_ffffffff-ffff-ffff-ffff-ffffffffffff',
        cliSessionId: 'ffffffff-aaaa-aaaa-aaaa-ffffffffffff',
        processName: 'c5-proc',
        cwd: '/sessions/c5-proc',
        userSelectedFolders: [],
        createdAt: 1745100000000,
        lastActivityAt: 1745100060000,
        model: 'claude-opus-4-7',
        isArchived: false,
        title: 'c5 regression session',
        vmProcessName: 'c5-proc',
        initialMessage: 'hello',
        enabledMcpTools: {},
        remoteMcpServersConfig: [],
        egressAllowedDomains: [],
        systemPrompt: '',
        accountName: '',
        emailAddress: '',
      };
      await writeFile(
        path.join(sessionDir, `${manifest.sessionId}.json`),
        JSON.stringify(manifest),
      );
      // audit.jsonl: 2 user + 3 assistant lines, NO result line.
      const auditDir = path.join(sessionDir, manifest.sessionId);
      await mkdir(auditDir, { recursive: true });
      const lines = [
        '{"type":"user","_audit_timestamp":"t"}',
        '{"type":"assistant","_audit_timestamp":"t"}',
        '{"type":"user","_audit_timestamp":"t"}',
        '{"type":"assistant","_audit_timestamp":"t"}',
        '{"type":"assistant","_audit_timestamp":"t"}',
      ];
      await writeFile(path.join(auditDir, 'audit.jsonl'), lines.join('\n') + '\n');

      const result = await runCoworkExport({ outDir, appDataClaudeRoot: root });
      const entry = result.entries.find((e) => e.rawSessionId === manifest.sessionId);
      expect(entry).toBeDefined();
      expect(entry!.userTurns).toBe(2);
      expect(entry!.assistantTurns).toBe(3);
      // Cost / result-derived fields remain null because there is no result line.
      expect(entry!.totalCostUsd).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
