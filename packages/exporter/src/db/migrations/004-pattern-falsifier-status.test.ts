// DB-side tests for Phase Rev3-E sub-task E2 — the
// pattern-falsifier-status migration. Walks a freshly-migrated DB
// through inserting (a) a pre-Rev3-E pattern (falsifier_status NULL,
// back-compat) and (b) each of the three valid terminal states, then
// asserts the CHECK constraint rejects an out-of-domain value.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import { MIGRATIONS, runMigrations } from './index.js';

describe('Rev3-E pattern-falsifier-status migration (004)', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-rev3e-test-'));
    db = openDb(join(tmpDir, 'rev3e.db'));
    runMigrations(db, MIGRATIONS);
    // Seed the parents the patterns FK requires.
    db.prepare(
      `INSERT INTO projects (id, display_name, discovered_at, last_activity_at, sentiment, source)
       VALUES ('p1', 'P1', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'positive', 'desktop')`,
    ).run();
    db.prepare(
      `INSERT INTO narratives
        (id, project_id, sentiment, title, body, generated_at, action_type)
       VALUES ('n1', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern')`,
    ).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('all migrations are registered in apply order with 004 appended', () => {
    const applied = db
      .prepare<unknown[], { id: string }>('SELECT id FROM schema_migrations ORDER BY id')
      .all()
      .map((r) => r.id);
    expect(applied).toEqual([
      '001-initial-schema',
      '002-narrative-provenance',
      '003-entity-states',
      '004-pattern-falsifier-status',
    ]);
  });

  it('pre-Rev3-E insert (no falsifier_status column populated) still works', () => {
    db.prepare(
      `INSERT INTO patterns
        (id, source_narrative_id, project_id, title, body, encoded_at, appended_to_claude_md)
       VALUES ('pat-v1', 'n1', 'p1', 't', 'b', '2025-01-01T00:00:00Z', 0)`,
    ).run();
    const row = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT * FROM patterns WHERE id = ?`,
      )
      .get('pat-v1');
    expect(row?.['falsifier_status']).toBeNull();
  });

  it('accepts each of the three valid terminal states', () => {
    const states = ['verified', 'skipped-by-user', 'unavailable'];
    for (const [ix, status] of states.entries()) {
      db.prepare(
        `INSERT INTO patterns
          (id, source_narrative_id, project_id, title, body, encoded_at,
           appended_to_claude_md, falsifier_status)
         VALUES (?, 'n1', 'p1', 't', 'b', '2025-01-01T00:00:00Z', 0, ?)`,
      ).run(`pat-${ix}`, status);
      const row = db
        .prepare<[string], Record<string, unknown>>(
          `SELECT falsifier_status FROM patterns WHERE id = ?`,
        )
        .get(`pat-${ix}`);
      expect(row?.['falsifier_status']).toBe(status);
    }
  });

  it('rejects out-of-domain falsifier_status values via CHECK', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO patterns
          (id, source_narrative_id, project_id, title, body, encoded_at,
           appended_to_claude_md, falsifier_status)
         VALUES ('pat-bad', 'n1', 'p1', 't', 'b', '2025-01-01T00:00:00Z', 0, 'partly-verified')`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('running the full migration set twice is a no-op (idempotent end-to-end)', () => {
    // Already migrated via beforeEach. A second pass on the same DB
    // must apply zero new migrations.
    const second = runMigrations(db, MIGRATIONS);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([
      '001-initial-schema',
      '002-narrative-provenance',
      '003-entity-states',
      '004-pattern-falsifier-status',
    ]);
  });
});
