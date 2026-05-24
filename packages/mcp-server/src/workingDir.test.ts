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
});
