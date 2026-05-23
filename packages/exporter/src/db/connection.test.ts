// Tests for the connection helper. Verifies the four-pragma contract
// per plan §"SQLite write contract" actually applies on a real
// file-backed DB.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from './connection.js';

describe('openDb connection contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-conn-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens a file-backed DB with WAL + synchronous=NORMAL + foreign_keys=ON', () => {
    const db = openDb(join(tmpDir, 'conn.db'));
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      // synchronous=NORMAL is integer 1.
      expect(db.pragma('synchronous', { simple: true })).toBe(1);
      // foreign_keys is integer 1 when ON.
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      // busy_timeout 0 means we handle SQLITE_BUSY ourselves.
      expect(db.pragma('busy_timeout', { simple: true })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('opens read-only when options.readonly is true and skips WAL pragmas', () => {
    // Seed a file-backed DB first so the read-only open has something
    // to point at; the WAL setup is a side effect of the seed.
    const dbPath = join(tmpDir, 'ro.db');
    const seedDb = openDb(dbPath);
    seedDb.exec('CREATE TABLE t (x INTEGER)');
    seedDb.close();

    const ro = openDb(dbPath, { readonly: true });
    try {
      // foreign_keys still on even for read-only.
      expect(ro.pragma('foreign_keys', { simple: true })).toBe(1);
      // Read still works.
      const row = ro.prepare('SELECT COUNT(*) AS n FROM t').get() as {
        n: number;
      };
      expect(row.n).toBe(0);
      // Write fails.
      expect(() => ro.exec('INSERT INTO t VALUES (1)')).toThrow();
    } finally {
      ro.close();
    }
  });

  it('foreign_keys = ON actually enforces FK constraints on writes', () => {
    const db = openDb(join(tmpDir, 'fk.db'));
    try {
      db.exec(`
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES parent (id) ON DELETE CASCADE
        );
      `);
      // Inserting a child with no matching parent must fail with the
      // FK constraint error — that's the contract we promise downstream
      // migration authors and SDK callers.
      expect(() =>
        db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run(
          'c1',
          'nonexistent',
        ),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });
});
