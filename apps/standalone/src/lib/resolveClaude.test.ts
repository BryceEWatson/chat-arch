import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeBin } from './resolveClaude.js';

let workdir: string;
const SAVED_ENV = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'chat-arch-resolve-claude-'));
  // Wipe the env vars the resolver inspects so each test starts clean.
  delete process.env['CLAUDE_BIN'];
  delete process.env['CLAUDE_CODE_EXECPATH'];
  // We don't touch APPDATA in env-driven tests; the APPDATA branch is
  // Windows-only and requires the full %APPDATA%\Claude\claude-code\
  // version-directory shape, which is covered by integration not unit.
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  process.env = { ...SAVED_ENV };
});

describe('resolveClaudeBin precedence', () => {
  it('returns env when CLAUDE_BIN points at an existing file', () => {
    const bin = join(workdir, 'envClaude.exe');
    writeFileSync(bin, '');
    process.env['CLAUDE_BIN'] = bin;
    const r = resolveClaudeBin();
    expect(r.source).toBe('env');
    expect(r.file).toBe(bin);
    expect(r.useShell).toBe(false);
  });

  it('falls through env when CLAUDE_BIN is set but the file does not exist', () => {
    process.env['CLAUDE_BIN'] = join(workdir, 'nope.exe');
    const r = resolveClaudeBin();
    expect(r.source).not.toBe('env');
  });

  it('returns execpath when CLAUDE_BIN is unset and CLAUDE_CODE_EXECPATH points at a real file', () => {
    const bin = join(workdir, 'execpathClaude.exe');
    writeFileSync(bin, '');
    process.env['CLAUDE_CODE_EXECPATH'] = bin;
    const r = resolveClaudeBin();
    expect(r.source).toBe('execpath');
    expect(r.file).toBe(bin);
    expect(r.useShell).toBe(false);
  });

  it('execpath does not win over CLAUDE_BIN when both are set', () => {
    const envBin = join(workdir, 'envWins.exe');
    const exec = join(workdir, 'execLoses.exe');
    writeFileSync(envBin, '');
    writeFileSync(exec, '');
    process.env['CLAUDE_BIN'] = envBin;
    process.env['CLAUDE_CODE_EXECPATH'] = exec;
    const r = resolveClaudeBin();
    expect(r.source).toBe('env');
    expect(r.file).toBe(envBin);
  });

  it('falls back to bare "claude" on PATH when no env var resolves', () => {
    // Also unset APPDATA so the Windows branch can't accidentally hit
    // a real install on the test runner's machine.
    delete process.env['APPDATA'];
    const r = resolveClaudeBin();
    expect(r.source).toBe('path');
    expect(r.file).toBe('claude');
    expect(r.useShell).toBe(process.platform === 'win32');
  });
});
