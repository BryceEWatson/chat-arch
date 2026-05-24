import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import {
  assertDataDirContained,
  DataDirGuardError,
  SAFE_DATA_ROOT_REL,
} from './dataDirGuard.js';

const REPO = sep === '\\' ? 'C:\\repo' : '/repo';
const SAFE = resolve(REPO, SAFE_DATA_ROOT_REL);

describe('assertDataDirContained', () => {
  it('accepts the default relative path', () => {
    expect(assertDataDirContained(SAFE_DATA_ROOT_REL, REPO)).toBe(SAFE);
  });

  it('accepts subdirectories inside the safe root', () => {
    const sub = SAFE_DATA_ROOT_REL + '/analysis';
    expect(assertDataDirContained(sub, REPO)).toBe(resolve(REPO, sub));
  });

  it('accepts an absolute path equal to the safe root', () => {
    expect(assertDataDirContained(SAFE, REPO)).toBe(SAFE);
  });

  it('rejects a relative path with ..', () => {
    expect(() => assertDataDirContained('../etc', REPO)).toThrow(DataDirGuardError);
  });

  it('rejects an absolute path outside the safe root', () => {
    const outside = sep === '\\' ? 'C:\\Windows\\System32' : '/etc';
    expect(() => assertDataDirContained(outside, REPO)).toThrow(DataDirGuardError);
  });

  it('rejects a path that starts with the safe-root string but diverges', () => {
    // E.g. safe root is `/repo/apps/standalone/public/chat-arch-data`,
    // attacker tries `/repo/apps/standalone/public/chat-arch-data-evil`.
    const sibling = SAFE + '-evil';
    expect(() => assertDataDirContained(sibling, REPO)).toThrow(DataDirGuardError);
  });

  it('rejects ../ inside a longer path', () => {
    const sneaky = SAFE_DATA_ROOT_REL + '/../../../etc';
    expect(() => assertDataDirContained(sneaky, REPO)).toThrow(DataDirGuardError);
  });

  it('error carries the attempted resolved path', () => {
    try {
      assertDataDirContained('../etc', REPO);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DataDirGuardError);
      expect((e as DataDirGuardError).attempted).toBe(resolve(REPO, '../etc'));
    }
  });
});
