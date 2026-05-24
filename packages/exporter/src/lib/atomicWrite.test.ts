import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteJson,
  atomicWriteJsonSync,
  atomicWriteTextSync,
  stampedTmpPath,
} from './atomicWrite.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'chat-arch-atomic-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('stampedTmpPath', () => {
  it('appends a stamp with pid, timestamp, and 6 base36 chars', () => {
    const stamped = stampedTmpPath(join(workdir, 'foo.json'));
    expect(stamped).toMatch(
      new RegExp(`foo\\.json\\.tmp-\\d+-\\d+-[0-9a-z]{6}$`),
    );
  });

  it('produces distinct names for back-to-back calls in the same process', () => {
    const a = stampedTmpPath(join(workdir, 'foo.json'));
    const b = stampedTmpPath(join(workdir, 'foo.json'));
    expect(a).not.toBe(b);
  });
});

describe('atomicWriteJsonSync', () => {
  it('writes the JSON-stringified value with a trailing newline', () => {
    const target = join(workdir, 'sync.json');
    atomicWriteJsonSync(target, { hello: 'world' });
    expect(readFileSync(target, 'utf8')).toBe('{\n  "hello": "world"\n}\n');
  });

  it('leaves no orphan .tmp file in the destination directory after success', () => {
    const target = join(workdir, 'sync.json');
    atomicWriteJsonSync(target, { ok: true });
    const lingering = readdirSync(workdir).filter((n) => n.includes('.tmp-'));
    expect(lingering).toEqual([]);
  });

  it('two simultaneous writers to the same target do not share a tmp path', async () => {
    // S3 race-guard regression: if two atomicWrite calls share a tmp
    // filename, one's rename() steamrolls the other's. With the stamp
    // in place the names diverge by Math.random() + timestamp.
    const target = join(workdir, 'race.json');
    // Spam many writes in parallel; final on-disk content must be one
    // of the inputs (not a torn write or a missing file).
    const writers = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => atomicWriteJsonSync(target, { i })),
    );
    await Promise.all(writers);
    const final = JSON.parse(readFileSync(target, 'utf8')) as { i: number };
    expect(typeof final.i).toBe('number');
    expect(final.i).toBeGreaterThanOrEqual(0);
    expect(final.i).toBeLessThan(20);
    const lingering = readdirSync(workdir).filter((n) => n.includes('.tmp-'));
    expect(lingering).toEqual([]);
  });
});

describe('atomicWriteTextSync', () => {
  it('writes arbitrary text byte-for-byte', () => {
    const target = join(workdir, 'export.md');
    atomicWriteTextSync(target, '# Title\n\nBody — no trailing newline.');
    expect(readFileSync(target, 'utf8')).toBe(
      '# Title\n\nBody — no trailing newline.',
    );
  });
});

describe('atomicWriteJson (async)', () => {
  it('round-trips content through tmp + rename', async () => {
    const target = join(workdir, 'async.json');
    await atomicWriteJson(target, '{"async":true}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"async":true}\n');
  });
});
