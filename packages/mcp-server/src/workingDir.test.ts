import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertPathWithinWorkingDir,
  resolveWorkingDir,
  WorkingDirError,
} from './workingDir.js';

// Pick the platform's path conventions so the test runs on both
// Windows and POSIX runners. The kernel uses `path.isAbsolute` +
// `path.basename` + `path.sep` so we follow suit.
const ABS = path.resolve('/tmp/chat-arch-data');
const ABS_WRONG = path.resolve('/tmp/some-other-dir');

describe('resolveWorkingDir', () => {
  it('accepts an absolute path with basename chat-arch-data', () => {
    const wd = resolveWorkingDir(ABS);
    expect(wd.absolute).toBe(path.resolve(ABS));
  });

  it('rejects empty string', () => {
    expect(() => resolveWorkingDir('')).toThrowError(WorkingDirError);
    try {
      resolveWorkingDir('   ');
    } catch (e) {
      expect((e as WorkingDirError).code).toBe('empty');
    }
  });

  it('rejects relative path', () => {
    try {
      resolveWorkingDir('chat-arch-data');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkingDirError);
      expect((e as WorkingDirError).code).toBe('not-absolute');
      return;
    }
    throw new Error('expected resolveWorkingDir to throw');
  });

  it('rejects absolute path with wrong basename', () => {
    try {
      resolveWorkingDir(ABS_WRONG);
    } catch (e) {
      expect(e).toBeInstanceOf(WorkingDirError);
      expect((e as WorkingDirError).code).toBe('wrong-basename');
      return;
    }
    throw new Error('expected resolveWorkingDir to throw');
  });

  it('normalizes trailing slash + redundant separators', () => {
    const noisy = ABS + path.sep + path.sep;
    const wd = resolveWorkingDir(noisy);
    expect(wd.absolute).toBe(path.resolve(ABS));
  });

  it('trims surrounding whitespace before validation', () => {
    const wd = resolveWorkingDir(`  ${ABS}  `);
    expect(wd.absolute).toBe(path.resolve(ABS));
  });

  // iter-1 hardening: adversarial review flagged UNC paths and
  // Windows drive-letter case mismatch as containment-policy bugs.
  describe('platform-specific hardening (iter-1)', () => {
    const isWin = process.platform === 'win32';

    it.runIf(isWin)('rejects Windows UNC paths with network-path code', () => {
      try {
        resolveWorkingDir('\\\\server\\share\\chat-arch-data');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkingDirError);
        expect((e as WorkingDirError).code).toBe('network-path');
        return;
      }
      throw new Error('expected UNC path to be rejected on win32');
    });

    it.runIf(!isWin)('non-Windows platforms do not apply the UNC rule', () => {
      // POSIX: a path starting with `\\` is not meaningful as a
      // network path; the resolver normalizes it to something
      // path.isAbsolute won't accept anyway. Just confirm the
      // rule is platform-gated, not unconditional.
      try {
        resolveWorkingDir('\\\\server\\share\\chat-arch-data');
      } catch (e) {
        // Will throw with 'not-absolute' on POSIX — that's fine,
        // the rule we're testing is that we don't get
        // 'network-path' off-platform.
        expect((e as WorkingDirError).code).not.toBe('network-path');
        return;
      }
      // If it didn't throw at all, also acceptable (this branch
      // doesn't run on win32 so we're not asserting a specific
      // platform behavior beyond "no false network-path firing").
    });
  });
});

describe('assertPathWithinWorkingDir', () => {
  const wd = resolveWorkingDir(ABS);

  it('accepts a relative child path', () => {
    const resolved = assertPathWithinWorkingDir(wd, 'narratives/foo.json');
    expect(resolved).toBe(path.resolve(ABS, 'narratives/foo.json'));
  });

  it('accepts an absolute path that is within the working dir', () => {
    const child = path.resolve(ABS, 'analysis/curator-feed.json');
    const resolved = assertPathWithinWorkingDir(wd, child);
    expect(resolved).toBe(child);
  });

  it('rejects parent-traversal via ..', () => {
    try {
      assertPathWithinWorkingDir(wd, '../escaped.json');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkingDirError);
      expect((e as WorkingDirError).code).toBe('traversal');
      return;
    }
    throw new Error('expected assertPathWithinWorkingDir to throw');
  });

  it('rejects absolute path outside the working dir', () => {
    try {
      assertPathWithinWorkingDir(wd, path.resolve('/etc/passwd'));
    } catch (e) {
      expect(e).toBeInstanceOf(WorkingDirError);
      expect((e as WorkingDirError).code).toBe('traversal');
      return;
    }
    throw new Error('expected assertPathWithinWorkingDir to throw');
  });

  it('rejects sibling directory whose name starts with workingDir.absolute (the trailing-sep bug)', () => {
    // Classic startsWith pitfall: `/tmp/chat-arch-data-evil` STARTS
    // with `/tmp/chat-arch-data` (no trailing sep). The kernel
    // must require the sep boundary or it leaks.
    const evilSibling = ABS + '-evil';
    try {
      assertPathWithinWorkingDir(wd, evilSibling);
    } catch (e) {
      expect(e).toBeInstanceOf(WorkingDirError);
      expect((e as WorkingDirError).code).toBe('traversal');
      return;
    }
    throw new Error(
      `expected assertPathWithinWorkingDir to reject sibling "${evilSibling}"`,
    );
  });

  it('accepts the working dir itself (path === root)', () => {
    const resolved = assertPathWithinWorkingDir(wd, ABS);
    expect(resolved).toBe(path.resolve(ABS));
  });

  it('rejects empty candidate', () => {
    try {
      assertPathWithinWorkingDir(wd, '');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkingDirError);
      expect((e as WorkingDirError).code).toBe('empty');
      return;
    }
    throw new Error('expected assertPathWithinWorkingDir to throw on empty');
  });

  // iter-1 hardening: Windows drive-letter case mismatch.
  describe('Windows case-insensitive containment (iter-1)', () => {
    const isWin = process.platform === 'win32';

    it.runIf(isWin)('accepts a candidate whose drive letter case differs from the working dir', () => {
      // Build a working dir with the drive letter in one case,
      // then probe with the opposite case. NTFS treats both as
      // the same volume; the kernel must too.
      const wdUpper = resolveWorkingDir('C:\\tmp\\chat-arch-data');
      const lowerCandidate = 'c:\\tmp\\chat-arch-data\\foo.json';
      // Pre-fix: this would throw 'traversal' because
      // `path.resolve` preserves the literal case and the lexical
      // startsWith comparison would mismatch.
      const resolved = assertPathWithinWorkingDir(wdUpper, lowerCandidate);
      expect(typeof resolved).toBe('string');
    });

    it.runIf(isWin)('accepts an inverse drive-letter mismatch (wd lower, candidate upper)', () => {
      const wdLower = resolveWorkingDir('c:\\tmp\\chat-arch-data');
      const upperCandidate = 'C:\\tmp\\chat-arch-data\\nested\\bar.json';
      const resolved = assertPathWithinWorkingDir(wdLower, upperCandidate);
      expect(typeof resolved).toBe('string');
    });

    it.runIf(isWin)('still rejects a TRULY-outside path even with case-insensitive compare', () => {
      // Sanity: the case-insensitive compare must not over-relax
      // the containment rule. A path outside the WD root still
      // throws traversal.
      const wd = resolveWorkingDir('C:\\tmp\\chat-arch-data');
      try {
        assertPathWithinWorkingDir(wd, 'C:\\Windows\\System32\\config\\sam');
      } catch (e) {
        expect((e as WorkingDirError).code).toBe('traversal');
        return;
      }
      throw new Error('expected traversal rejection');
    });
  });
});
