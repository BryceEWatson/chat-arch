// Tests for the initial schema migration (Rev3-A.A5). Asserts every
// promised table + index exists, foreign keys actually fire, and
// running the runner twice over the same registry is a no-op.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import { MIGRATIONS, runMigrations } from './index.js';

const EXPECTED_TABLES = [
  'analyzers',
  'projects',
  'topics',
  'sessions',
  'session_messages',
  'session_revisions',
  'narratives',
  'narrative_evidence',
  'patterns',
  'project_sessions',
  'project_topics',
  'topic_sessions',
  'findings',
];

const EXPECTED_INDEXES = [
  'idx_sessions_project',
  'idx_sessions_started',
  'idx_session_messages_session',
  'idx_session_revisions_session',
  'idx_narratives_project',
  'idx_patterns_project',
  'idx_findings_kernel',
  'idx_findings_project',
];

describe('001-initial-schema migration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-initial-schema-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates every promised entity + junction + findings + analyzers table', () => {
    const db = openDb(join(tmpDir, 'schema.db'));
    try {
      runMigrations(db, MIGRATIONS);

      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);

      for (const expected of EXPECTED_TABLES) {
        expect(tables).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('creates every promised index', () => {
    const db = openDb(join(tmpDir, 'indexes.db'));
    try {
      runMigrations(db, MIGRATIONS);

      const indexes = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);

      for (const expected of EXPECTED_INDEXES) {
        expect(indexes).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('enforces narrative→project FK (insert without parent project fails)', () => {
    const db = openDb(join(tmpDir, 'fk.db'));
    try {
      runMigrations(db, MIGRATIONS);

      expect(() =>
        db
          .prepare(
            `INSERT INTO narratives
              (id, project_id, sentiment, title, body, generated_at, action_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'n1',
            'project-that-does-not-exist',
            'positive',
            'title',
            'body',
            '2026-01-01',
            'encode-as-pattern',
          ),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it('CASCADE deletes evidence rows when a narrative is deleted', () => {
    const db = openDb(join(tmpDir, 'cascade.db'));
    try {
      runMigrations(db, MIGRATIONS);

      // Seed: one project, one narrative, two evidence rows.
      db.prepare(
        `INSERT INTO projects
          (id, display_name, discovered_at, last_activity_at, sentiment, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('p1', 'Project 1', '2026-01-01', '2026-01-02', 'positive', 'cli-cwd');

      db.prepare(
        `INSERT INTO narratives
          (id, project_id, sentiment, title, body, generated_at, action_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'n1',
        'p1',
        'positive',
        'title',
        'body',
        '2026-01-02',
        'encode-as-pattern',
      );

      db.prepare(
        `INSERT INTO narrative_evidence
          (narrative_id, evidence_index, session_id, excerpt)
         VALUES (?, ?, ?, ?)`,
      ).run('n1', 0, 's1', 'evidence A');
      db.prepare(
        `INSERT INTO narrative_evidence
          (narrative_id, evidence_index, session_id, excerpt)
         VALUES (?, ?, ?, ?)`,
      ).run('n1', 1, 's2', 'evidence B');

      // Delete the narrative. Evidence rows must vanish via CASCADE.
      db.prepare('DELETE FROM narratives WHERE id = ?').run('n1');
      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM narrative_evidence')
        .get() as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('SET NULL on sessions.project_id when the project is deleted', () => {
    const db = openDb(join(tmpDir, 'setnull.db'));
    try {
      runMigrations(db, MIGRATIONS);

      db.prepare(
        `INSERT INTO projects
          (id, display_name, discovered_at, last_activity_at, sentiment, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('p1', 'Project 1', '2026-01-01', '2026-01-02', 'positive', 'cli-cwd');

      db.prepare(
        `INSERT INTO sessions
          (id, source, raw_session_id, started_at, updated_at, duration_ms,
           title, title_source, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'cli-direct', 's1', 1000, 2000, 1000, 'Title', 'first-prompt', 'p1');

      db.prepare('DELETE FROM projects WHERE id = ?').run('p1');

      const row = db
        .prepare('SELECT project_id FROM sessions WHERE source = ? AND id = ?')
        .get('cli-direct', 's1') as { project_id: string | null };
      expect(row.project_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('running the full migration set twice is a no-op (idempotent end-to-end)', () => {
    const dbPath = join(tmpDir, 'idem.db');
    {
      const db = openDb(dbPath);
      try {
        const first = runMigrations(db, MIGRATIONS);
        expect(first.applied).toEqual(['001-initial-schema']);
      } finally {
        db.close();
      }
    }
    {
      const db = openDb(dbPath);
      try {
        const second = runMigrations(db, MIGRATIONS);
        expect(second.applied).toEqual([]);
        expect(second.alreadyApplied).toEqual(['001-initial-schema']);
      } finally {
        db.close();
      }
    }
  });
});
