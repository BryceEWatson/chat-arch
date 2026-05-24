// `projects` table SDK + read helpers that join through the
// junction tables (`project_sessions`, `project_topics`) to recover
// the array-shaped relations the TS Project type exposes.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import { NotFoundError, UniqueViolationError, isUniqueViolation } from './errors.js';
import type { ProjectRow } from './types.js';

interface RawProjectRow {
  readonly id: string;
  readonly display_name: string;
  readonly discovered_at: string;
  readonly last_activity_at: string;
  readonly sentiment: string;
  readonly source: string;
}

function rowFromRaw(raw: RawProjectRow): ProjectRow {
  return {
    id: raw.id,
    displayName: raw.display_name,
    discoveredAt: raw.discovered_at,
    lastActivityAt: raw.last_activity_at,
    sentiment: raw.sentiment,
    source: raw.source,
  };
}

const SELECT_COLUMNS =
  'id, display_name, discovered_at, last_activity_at, sentiment, source';

export function getProjectById(db: Database, id: string): ProjectRow | null {
  const raw = db
    .prepare<[string], RawProjectRow>(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
    .get(id);
  return raw ? rowFromRaw(raw) : null;
}

export function listProjects(db: Database): readonly ProjectRow[] {
  const rows = db
    .prepare<[], RawProjectRow>(
      `SELECT ${SELECT_COLUMNS} FROM projects ORDER BY last_activity_at DESC, id`,
    )
    .all();
  return rows.map(rowFromRaw);
}

export interface InsertProjectInput {
  readonly id: string;
  readonly displayName: string;
  readonly discoveredAt: string;
  readonly lastActivityAt: string;
  readonly sentiment: string;
  readonly source: string;
}

export async function insertProject(
  db: Database,
  input: InsertProjectInput,
): Promise<ProjectRow> {
  return withWriteTransaction(db, (tx) => {
    try {
      tx.prepare(
        `INSERT INTO projects (id, display_name, discovered_at, last_activity_at, sentiment, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.displayName,
        input.discoveredAt,
        input.lastActivityAt,
        input.sentiment,
        input.source,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError('project', input.id, err);
      }
      throw err;
    }
    const fresh = getProjectById(tx, input.id);
    if (!fresh) throw new NotFoundError('project', input.id);
    return fresh;
  });
}

export interface UpdateProjectInput {
  readonly displayName?: string;
  readonly lastActivityAt?: string;
  readonly sentiment?: string;
  readonly source?: string;
}

export async function updateProject(
  db: Database,
  id: string,
  patch: UpdateProjectInput,
): Promise<ProjectRow> {
  return withWriteTransaction(db, (tx) => {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.displayName !== undefined) {
      sets.push('display_name = ?');
      args.push(patch.displayName);
    }
    if (patch.lastActivityAt !== undefined) {
      sets.push('last_activity_at = ?');
      args.push(patch.lastActivityAt);
    }
    if (patch.sentiment !== undefined) {
      sets.push('sentiment = ?');
      args.push(patch.sentiment);
    }
    if (patch.source !== undefined) {
      sets.push('source = ?');
      args.push(patch.source);
    }
    if (sets.length > 0) {
      args.push(id);
      const info = tx
        .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`)
        .run(...args);
      if (info.changes === 0) throw new NotFoundError('project', id);
    }
    const fresh = getProjectById(tx, id);
    if (!fresh) throw new NotFoundError('project', id);
    return fresh;
  });
}

export async function deleteProject(db: Database, id: string): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return info.changes > 0;
  });
}

/**
 * Return the session keys linked to a project via `project_sessions`.
 * Reconstructs the array-shaped `sessionIds[]` that the TS Project type
 * exposes (one ID per source, dedup at the caller if needed).
 */
export function listProjectSessionKeys(
  db: Database,
  projectId: string,
): readonly { readonly source: string; readonly id: string }[] {
  return db
    .prepare<
      [string],
      { readonly session_source: string; readonly session_id: string }
    >(
      `SELECT session_source, session_id FROM project_sessions WHERE project_id = ? ORDER BY session_source, session_id`,
    )
    .all(projectId)
    .map((row) => ({ source: row.session_source, id: row.session_id }));
}

export function listProjectTopicIds(
  db: Database,
  projectId: string,
): readonly string[] {
  return db
    .prepare<[string], { readonly topic_id: string }>(
      'SELECT topic_id FROM project_topics WHERE project_id = ? ORDER BY topic_id',
    )
    .all(projectId)
    .map((row) => row.topic_id);
}
