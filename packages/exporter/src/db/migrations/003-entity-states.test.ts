// DB-side tests for the Phase Rev3-C C4 entity_states migration (003).
// Walks a freshly-migrated DB through inserts + CHECK-constraint
// rejections + verifies the updated_at index exists.

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
         (entity_kind, entity_id, state, updated_at, size_at_state)
       VALUES ('narrative', 'narr-1', 'PENDING', 1000, 5)`,
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
        `INSERT INTO entity_states (entity_kind, entity_id, state, updated_at, size_at_state)
         VALUES ('pattern', 'p-1', 'PENDING', 1000, 0)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK rejects state outside the three-value union', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, updated_at, size_at_state)
         VALUES ('narrative', 'narr-1', 'ACKNOWLEDGED', 1000, 0)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('CHECK rejects negative dismissal_count', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, updated_at, size_at_state, dismissal_count)
         VALUES ('narrative', 'narr-1', 'DISMISSED', 1000, 0, -1)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('PRIMARY KEY (entity_kind, entity_id) rejects duplicate inserts', () => {
    db.prepare(
      `INSERT INTO entity_states (entity_kind, entity_id, state, updated_at, size_at_state)
       VALUES ('narrative', 'narr-1', 'PENDING', 1000, 0)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO entity_states (entity_kind, entity_id, state, updated_at, size_at_state)
         VALUES ('narrative', 'narr-1', 'INSTALLED', 2000, 0)`,
      ).run(),
    ).toThrow(/UNIQUE constraint|PRIMARY KEY/);
  });

  it('same entity_id under two different kinds coexists (composite PK)', () => {
    db.prepare(
      `INSERT INTO entity_states (entity_kind, entity_id, state, updated_at, size_at_state)
       VALUES ('narrative', 'shared-id', 'PENDING', 1000, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO entity_states (entity_kind, entity_id, state, updated_at, size_at_state)
       VALUES ('knowledge-debt', 'shared-id', 'INSTALLED', 2000, 0)`,
    ).run();
    const count = db
      .prepare<[], { cnt: number }>('SELECT COUNT(*) AS cnt FROM entity_states')
      .get();
    expect(count?.cnt).toBe(2);
  });

  it('idx_entity_states_updated_at index is registered', () => {
    const idx = db
      .prepare<[], { name: string } | undefined>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_entity_states_updated_at'`,
      )
      .get();
    expect(idx?.name).toBe('idx_entity_states_updated_at');
  });
});
