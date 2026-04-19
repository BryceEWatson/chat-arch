import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { toPosixRelative } from '../../src/lib/paths.js';

describe('toPosixRelative', () => {
  it('returns forward-slash relative path for a nested file', () => {
    const base = path.resolve('out');
    const abs = path.join(base, 'manifests', 'cowork', 'local_x.json');
    expect(toPosixRelative(abs, base)).toBe('manifests/cowork/local_x.json');
  });

  it('throws when the target escapes the base directory', () => {
    const base = path.resolve('out');
    const outside = path.resolve('elsewhere', 'file.json');
    expect(() => toPosixRelative(outside, base)).toThrow(/not inside base/);
  });

  it('converts Windows-style backslashes in the absolute path to forward slashes', () => {
    // On any OS, `path.join` uses the platform separator. The output normalization
    // is what we care about — the function MUST never emit a backslash.
    const base = path.resolve('out');
    const abs = path.join(base, 'local-transcripts', 'cowork', 'u.jsonl');
    const rel = toPosixRelative(abs, base);
    expect(rel).not.toContain('\\');
    expect(rel).toBe('local-transcripts/cowork/u.jsonl');
  });
});
