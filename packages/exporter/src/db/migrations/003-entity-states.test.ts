// DB-side tests for Phase Rev3-C C4-foundation migration (003).
// Walks a freshly-migrated DB through entity_states inserts +
// asserts the CHECK constraints reject malformed inputs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import { MIGRATIONS, runMigrations } from './index.js';

describe('Rev3-C entity_states migration (003)', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-rev3c-test-'));
    db = openDb(join(tmpDir, 'rev3c.db'));
    runMigrations(db, MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all three migrations register in apply order', () => {
    const applied = db
      .prepare<unknown[], { id: string }>(
        'SELECT id FROM schema_migrations ORDER BY id',
      )
      .all()
      .map((r) => r.id);
    expect(applied).toEqual([
      '001-initial-schema',
      '002-narrative-provenance',
      '003-entity-states',
    ]);
  });

  it('entity_states table accepts a valid PENDING insert', () => {
    db.prepare(
      `INSERT INTO entity_states
         (entity_kind, entity_id, state, size_at_state, updated_at)
       VALUES ('narrative', 'narr-1', 'PENDING', 5, 1000)`,
    ).run();
    const row = db
      .prepare<[], Record<string, unknown>>(`SELECT * FROM entity_states`)
      .get();
    expect(row?.['entity_kind']).toBe('narrative');
    expect(row?.['state']).toBe('PENDING');
    expect(row?.['size_at_state']).toBe(5);
    expect(row?.['dismissal_count']).toBe(0); // DEFAULT 0
  });

  it('CHECK rejects entity_kind outside the two-value union', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, updated_at)
         VALUES ('pattern', 'p-1', 'PENDING', 0, 1000)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK rejects state outside the three-value union', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, updated_at)
         VALUES ('narrative', 'narr-1', 'ACKNOWLEDGED', 0, 1000)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK rejects negative size_at_state', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, updated_at)
         VALUES ('narrative', 'narr-1', 'PENDING', -1, 1000)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK rejects negative dismissal_count', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, dismissal_count, updated_at)
         VALUES ('narrative', 'narr-1', 'DISMISSED', 0, -1, 1000)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('PRIMARY KEY (entity_kind, entity_id) rejects duplicate inserts', () => {
    db.prepare(
      `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, updated_at)
       VALUES ('narrative', 'narr-1', 'PENDING', 0, 1000)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, updated_at)
         VALUES ('narrative', 'narr-1', 'INSTALLED', 0, 2000)`,
      ).run(),
    ).toThrow(/UNIQUE constraint|PRIMARY KEY/);
  });

  it('same entity_id under two different kinds coexists (composite PK)', () => {
    db.prepare(
      `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, updated_at)
       VALUES ('narrative', 'shared-id', 'PENDING', 0, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO entity_states (entity_kind, entity_id, state, size_at_state, updated_at)
       VALUES ('knowledge-debt', 'shared-id', 'INSTALLED', 0, 2000)`,
    ).run();
    const count = db
      .prepare<[], { cnt: number }>('SELECT COUNT(*) AS cnt FROM entity_states')
      .get();
    expect(count?.cnt).toBe(2);
  });
});
