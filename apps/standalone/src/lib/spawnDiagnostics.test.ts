import { describe, it, expect } from 'vitest';
import {
  exitCodeHint,
  isWindowsDllInitFailure,
  translateSpawnError,
  WINDOWS_DLL_INIT_FAILURE,
  WINDOWS_DLL_INIT_FAILURE_NEGATIVE,
} from './spawnDiagnostics.js';

describe('translateSpawnError', () => {
  it('maps ENOENT + claude → install-CLI hint', () => {
    const out = translateSpawnError(
      new Error("spawn ENOENT 'claude.cmd' not on PATH"),
    );
    expect(out).toMatch(/claude CLI was not found on PATH/);
    expect(out).toMatch(/Install Claude Code/);
  });

  it('maps generic ENOENT without claude → missing-executable', () => {
    const out = translateSpawnError(new Error('ENOENT: spawn pnpm.cmd'));
    expect(out).toMatch(/required executable was not found on PATH/);
  });

  it('maps EACCES → permission-denied', () => {
    const out = translateSpawnError(new Error('EACCES'));
    expect(out).toMatch(/permission denied/);
  });

  it('falls back to the raw message for unknown errors', () => {
    expect(translateSpawnError(new Error('thing broke'))).toBe('thing broke');
  });
});

describe('isWindowsDllInitFailure', () => {
  it('matches the positive 0xC0000142 form', () => {
    expect(isWindowsDllInitFailure(WINDOWS_DLL_INIT_FAILURE)).toBe(true);
    expect(isWindowsDllInitFailure(0xc0000142)).toBe(true);
  });

  it('matches the signed-int32 negative form (the value Node actually delivers)', () => {
    expect(isWindowsDllInitFailure(WINDOWS_DLL_INIT_FAILURE_NEGATIVE)).toBe(
      true,
    );
    expect(isWindowsDllInitFailure(-1073741502)).toBe(true);
  });

  it('returns false for null + unrelated codes', () => {
    expect(isWindowsDllInitFailure(null)).toBe(false);
    expect(isWindowsDllInitFailure(0)).toBe(false);
    expect(isWindowsDllInitFailure(1)).toBe(false);
    expect(isWindowsDllInitFailure(137)).toBe(false);
  });
});

describe('exitCodeHint', () => {
  it('annotates positive Windows DLL-init code', () => {
    expect(exitCodeHint(0xc0000142)).toMatch(/Windows DLL initialization/);
  });

  it('annotates negative Windows DLL-init code', () => {
    expect(exitCodeHint(-1073741502)).toMatch(/Windows DLL initialization/);
  });

  it('annotates SIGKILL-ish 137 → OOM', () => {
    expect(exitCodeHint(137)).toMatch(/out of memory/);
  });

  it('annotates SIGSEGV-ish 139 → segfault', () => {
    expect(exitCodeHint(139)).toMatch(/segmentation fault/);
  });

  it('returns empty for null + unknown codes', () => {
    expect(exitCodeHint(null)).toBe('');
    expect(exitCodeHint(1)).toBe('');
    expect(exitCodeHint(0)).toBe('');
  });
});
