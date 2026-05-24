// Tests for the migration runner. The contract under test:
//
//   - First run on an empty DB creates schema_migrations and applies
//     every migration in order.
//   - Second run with the same migrations list is a no-op (applied =
//     [], alreadyApplied = the full set).
//   - Adding a new migration after others have shipped applies only
//     the new one.
//   - A migration whose up() throws rolls back AND leaves
//     schema_migrations unchanged so the next run retries.
//   - Migration order is the array order — runner does not sort.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import {
  MigrationOrderError,
  assertMigrationIdsLexSorted,
  runMigrations,
} from './runner.js';
import type { Migration } from './types.js';

function makeMigration(id: string, sql: string): Migration {
  return {
    id,
    name: id,
    up: (db) => db.exec(sql),
  };
}

describe('runMigrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-migrate-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates schema_migrations and applies migrations in order on a fresh DB', () => {
    const db = openDb(join(tmpDir, 'fresh.db'));
    try {
      const migrations = [
        makeMigration('001-a', 'CREATE TABLE a (x INTEGER);'),
        makeMigration('002-b', 'CREATE TABLE b (y TEXT);'),
      ];

      const result = runMigrations(db, migrations);

      expect(result.applied).toEqual(['001-a', '002-b']);
      expect(result.alreadyApplied).toEqual([]);

      // schema_migrations exists and recorded both.
      const rows = db
        .prepare('SELECT id, name FROM schema_migrations ORDER BY id')
        .all() as { id: string; name: string }[];
      expect(rows.map((r) => r.id)).toEqual(['001-a', '002-b']);

      // Both tables exist.
      db.prepare('SELECT * FROM a LIMIT 1').all();
      db.prepare('SELECT * FROM b LIMIT 1').all();
    } finally {
      db.close();
    }
  });

  it('running twice is a no-op (idempotent)', () => {
    const db = openDb(join(tmpDir, 'idem.db'));
    try {
      const migrations = [
        makeMigration('001-a', 'CREATE TABLE a (x INTEGER);'),
      ];

      runMigrations(db, migrations);
      const second = runMigrations(db, migrations);

      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual(['001-a']);

      // Only one row in schema_migrations — no duplicate insert.
      const rows = db
        .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
        .get() as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('applies only new migrations on a partial-state DB', () => {
    const db = openDb(join(tmpDir, 'partial.db'));
    try {
      const initial = [makeMigration('001-a', 'CREATE TABLE a (x INTEGER);')];
      runMigrations(db, initial);

      // Now add a second migration and run again.
      const extended = [
        ...initial,
        makeMigration('002-b', 'CREATE TABLE b (y TEXT);'),
      ];
      const result = runMigrations(db, extended);

      expect(result.applied).toEqual(['002-b']);
      expect(result.alreadyApplied).toEqual(['001-a']);

      // Both tables now exist.
      db.prepare('SELECT * FROM a LIMIT 1').all();
      db.prepare('SELECT * FROM b LIMIT 1').all();
    } finally {
      db.close();
    }
  });

  it('rolls back a failed migration and leaves schema_migrations unchanged', () => {
    const db = openDb(join(tmpDir, 'fail.db'));
    try {
      const migrations: Migration[] = [
        makeMigration('001-a', 'CREATE TABLE a (x INTEGER);'),
        {
          id: '002-broken',
          name: 'broken',
          up: (txDb) => {
            txDb.exec('CREATE TABLE b (y TEXT);');
            throw new Error('intentional mid-migration failure');
          },
        },
      ];

      expect(() => runMigrations(db, migrations)).toThrow(/002-broken.*broken/);

      // 001-a's row is in schema_migrations (committed its own tx).
      // 002-broken's row is NOT (rolled back).
      const rows = db
        .prepare('SELECT id FROM schema_migrations ORDER BY id')
        .all() as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual(['001-a']);

      // Table `b` should NOT exist — the rollback should have
      // undone the CREATE TABLE.
      expect(() => db.prepare('SELECT * FROM b LIMIT 1').all()).toThrow(
        /no such table/i,
      );
    } finally {
      db.close();
    }
  });

  it('rejects an out-of-lex-order migration list with MigrationOrderError (D4)', () => {
    // D4 contract: ids must sort lexically in registry order. An
    // out-of-order list signals a silent-merge hazard (two parallel
    // branches both adding migration 002) — fail fast instead of
    // applying the wrong one first.
    const db = openDb(join(tmpDir, 'order.db'));
    try {
      expect(() =>
        runMigrations(db, [
          makeMigration('002-b', 'CREATE TABLE b (y TEXT);'),
          makeMigration('001-a', 'CREATE TABLE a (x INTEGER);'),
        ]),
      ).toThrow(MigrationOrderError);
    } finally {
      db.close();
    }
  });

  it('rejects two migrations with the same id (D4)', () => {
    // Two PRs both adding `002-foo` would merge cleanly into the
    // registry array but only one row could ever land in
    // schema_migrations. assertMigrationIdsLexSorted catches the
    // collision at startup.
    expect(() =>
      assertMigrationIdsLexSorted([
        { id: '001-a', name: 'a', up: () => {} },
        { id: '002-foo', name: 'foo', up: () => {} },
        { id: '002-foo', name: 'foo-collision', up: () => {} },
      ]),
    ).toThrow(MigrationOrderError);
  });

  it('accepts an empty migrations array', () => {
    expect(() => assertMigrationIdsLexSorted([])).not.toThrow();
  });

  it('accepts a single-migration array', () => {
    expect(() =>
      assertMigrationIdsLexSorted([
        { id: '001-a', name: 'a', up: () => {} },
      ]),
    ).not.toThrow();
  });
});
