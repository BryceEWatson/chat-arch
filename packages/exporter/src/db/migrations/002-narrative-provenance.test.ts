// DB-side tests for Phase Rev3-B sub-task B3 — the narrative
// provenance migration. Walks a freshly-migrated DB through
// inserting both a v1-shape narrative (legacy columns only) and a
// v2-shape narrative (provenance columns populated), then asserts the
// CHECK constraints reject malformed inputs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import { MIGRATIONS, runMigrations } from './index.js';

describe('Rev3-B narrative-provenance migration (002)', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-rev3b-test-'));
    db = openDb(join(tmpDir, 'rev3b.db'));
    runMigrations(db, MIGRATIONS);
    db.prepare(
      `INSERT INTO projects (id, display_name, discovered_at, last_activity_at, sentiment, source)
       VALUES ('p1', 'P1', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'positive', 'desktop')`,
    ).run();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('both migrations are registered in apply order', () => {
    const applied = db
      .prepare<unknown[], { id: string }>('SELECT id FROM schema_migrations ORDER BY id')
      .all()
      .map((r) => r.id);
    expect(applied).toEqual([
      '001-initial-schema',
      '002-narrative-provenance',
    ]);
  });

  it('legacy v1 insert (no provenance columns) still works', () => {
    db.prepare(
      `INSERT INTO narratives
        (id, project_id, sentiment, title, body, generated_at, action_type, schema_version)
       VALUES ('n-v1', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern', 1)`,
    ).run();
    const row = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT * FROM narratives WHERE id = ?`,
      )
      .get('n-v1');
    expect(row?.['schema_version']).toBe(1);
    expect(row?.['intent']).toBeNull();
    expect(row?.['observation']).toBeNull();
    expect(row?.['inference']).toBeNull();
    expect(row?.['attributed_to']).toBeNull();
    expect(row?.['verified_at']).toBeNull();
    expect(row?.['confidence']).toBeNull();
    expect(row?.['supporting_count']).toBeNull();
    expect(row?.['contradicting_count']).toBeNull();
    expect(row?.['correlated_outcome_json']).toBeNull();
  });

  it('v2 insert with full provenance round-trips', () => {
    db.prepare(
      `INSERT INTO narratives (
        id, project_id, sentiment, title, body, generated_at, action_type, schema_version,
        intent, observation, inference, attributed_to, verified_at,
        confidence, supporting_count, contradicting_count, correlated_outcome_json
      ) VALUES (
        'n-v2', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern', 2,
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    ).run(
      'detect X-before-Y',
      'X precedes Y in 5/7 sessions',
      'X-before-Y is the right ordering for this project',
      'deterministic',
      '2026-05-23T00:00:00Z',
      0.62,
      5,
      1,
      JSON.stringify({ delta: 0.14, standardError: 0.06, citedCount: 5, uncitedCount: 12 }),
    );
    const row = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT * FROM narratives WHERE id = ?`,
      )
      .get('n-v2');
    expect(row?.['schema_version']).toBe(2);
    expect(row?.['intent']).toBe('detect X-before-Y');
    expect(row?.['attributed_to']).toBe('deterministic');
    expect(row?.['confidence']).toBe(0.62);
    expect(row?.['supporting_count']).toBe(5);
    expect(row?.['contradicting_count']).toBe(1);
    expect(JSON.parse(String(row?.['correlated_outcome_json']))).toEqual({
      delta: 0.14,
      standardError: 0.06,
      citedCount: 5,
      uncitedCount: 12,
    });
  });

  it('rejects attributed_to values outside the CHECK list', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO narratives
          (id, project_id, sentiment, title, body, generated_at, action_type, schema_version, attributed_to)
         VALUES ('n-bad', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern', 2, 'made-up-attribution')`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('rejects confidence outside [0, 1]', () => {
    for (const bad of [-0.1, 1.1, 2]) {
      expect(() =>
        db.prepare(
          `INSERT INTO narratives
            (id, project_id, sentiment, title, body, generated_at, action_type, schema_version, confidence)
           VALUES ('n-c', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern', 2, ?)`,
        ).run(bad),
      ).toThrow(/CHECK constraint/);
    }
  });

  it('rejects negative supporting_count / contradicting_count', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO narratives
          (id, project_id, sentiment, title, body, generated_at, action_type, schema_version, supporting_count)
         VALUES ('n-s', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern', 2, -1)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db.prepare(
        `INSERT INTO narratives
          (id, project_id, sentiment, title, body, generated_at, action_type, schema_version, contradicting_count)
         VALUES ('n-c', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern', 2, -1)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });

  it('narrative_evidence.turn_index round-trips and rejects negatives', () => {
    db.prepare(
      `INSERT INTO sessions (id, source, raw_session_id, started_at, updated_at, duration_ms, title, title_source)
       VALUES ('s1', 'cli-direct', 'r', 1000, 1000, 0, 't', 'extracted')`,
    ).run();
    db.prepare(
      `INSERT INTO narratives (id, project_id, sentiment, title, body, generated_at, action_type)
       VALUES ('n-ev', 'p1', 'positive', 't', 'b', '2025-01-01T00:00:00Z', 'encode-as-pattern')`,
    ).run();

    // Insert with turn_index populated.
    db.prepare(
      `INSERT INTO narrative_evidence
        (narrative_id, evidence_index, session_source, session_id, anchor, excerpt, turn_index)
       VALUES ('n-ev', 0, 'cli-direct', 's1', 'turn:3', 'snippet', 3)`,
    ).run();
    // Insert with turn_index NULL (optional per B2).
    db.prepare(
      `INSERT INTO narrative_evidence
        (narrative_id, evidence_index, session_source, session_id, turn_index)
       VALUES ('n-ev', 1, 'cli-direct', 's1', NULL)`,
    ).run();

    const rows = db
      .prepare<[string], { evidence_index: number; turn_index: number | null }>(
        `SELECT evidence_index, turn_index FROM narrative_evidence WHERE narrative_id = ? ORDER BY evidence_index`,
      )
      .all('n-ev');
    expect(rows).toEqual([
      { evidence_index: 0, turn_index: 3 },
      { evidence_index: 1, turn_index: null },
    ]);

    // Negative turn_index rejected.
    expect(() =>
      db.prepare(
        `INSERT INTO narrative_evidence (narrative_id, evidence_index, session_source, session_id, turn_index)
         VALUES ('n-ev', 2, 'cli-direct', 's1', -1)`,
      ).run(),
    ).toThrow(/CHECK constraint/);
  });
});
