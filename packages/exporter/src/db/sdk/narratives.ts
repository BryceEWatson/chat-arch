// `narratives` table SDK. Per-project Narrative entities; Rev3-B
// extends with provenance fields (schema_version → 2) — those land in
// the next phase, not here.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import { NotFoundError, UniqueViolationError, isUniqueViolation } from './errors.js';
import type { NarrativeRow } from './types.js';

interface RawNarrativeRow {
  readonly id: string;
  readonly project_id: string;
  readonly sentiment: string;
  readonly title: string;
  readonly body: string;
  readonly generated_at: string;
  readonly action_type: string;
  readonly schema_version: number;
}

function rowFromRaw(raw: RawNarrativeRow): NarrativeRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    sentiment: raw.sentiment,
    title: raw.title,
    body: raw.body,
    generatedAt: raw.generated_at,
    actionType: raw.action_type,
    schemaVersion: raw.schema_version,
  };
}

const SELECT_COLUMNS =
  'id, project_id, sentiment, title, body, generated_at, action_type, schema_version';

export function getNarrativeById(db: Database, id: string): NarrativeRow | null {
  const raw = db
    .prepare<[string], RawNarrativeRow>(
      `SELECT ${SELECT_COLUMNS} FROM narratives WHERE id = ?`,
    )
    .get(id);
  return raw ? rowFromRaw(raw) : null;
}

export interface ListNarrativesFilter {
  readonly projectId?: string;
  readonly sentiment?: string;
  readonly schemaVersion?: number;
}

export function listNarratives(
  db: Database,
  filter: ListNarrativesFilter = {},
): readonly NarrativeRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectId !== undefined) {
    where.push('project_id = ?');
    args.push(filter.projectId);
  }
  if (filter.sentiment !== undefined) {
    where.push('sentiment = ?');
    args.push(filter.sentiment);
  }
  if (filter.schemaVersion !== undefined) {
    where.push('schema_version = ?');
    args.push(filter.schemaVersion);
  }
  const whereClause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const sql = `SELECT ${SELECT_COLUMNS} FROM narratives${whereClause} ORDER BY generated_at DESC, id`;
  const rows = db.prepare<unknown[], RawNarrativeRow>(sql).all(...args);
  return rows.map(rowFromRaw);
}

export interface InsertNarrativeInput {
  readonly id: string;
  readonly projectId: string;
  readonly sentiment: string;
  readonly title: string;
  readonly body: string;
  readonly generatedAt: string;
  readonly actionType: string;
  /** Defaults to 1 (current schema version). */
  readonly schemaVersion?: number;
}

export async function insertNarrative(
  db: Database,
  input: InsertNarrativeInput,
): Promise<NarrativeRow> {
  return withWriteTransaction(db, (tx) => {
    try {
      tx.prepare(
        `INSERT INTO narratives (id, project_id, sentiment, title, body, generated_at, action_type, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.projectId,
        input.sentiment,
        input.title,
        input.body,
        input.generatedAt,
        input.actionType,
        input.schemaVersion ?? 1,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError('narrative', input.id, err);
      }
      throw err;
    }
    const fresh = getNarrativeById(tx, input.id);
    if (!fresh) throw new NotFoundError('narrative', input.id);
    return fresh;
  });
}

export interface UpdateNarrativeInput {
  readonly sentiment?: string;
  readonly title?: string;
  readonly body?: string;
  readonly actionType?: string;
  readonly schemaVersion?: number;
}

const UPDATE_COLUMN_MAP: Readonly<Record<keyof UpdateNarrativeInput, string>> = {
  sentiment: 'sentiment',
  title: 'title',
  body: 'body',
  actionType: 'action_type',
  schemaVersion: 'schema_version',
};

export async function updateNarrative(
  db: Database,
  id: string,
  patch: UpdateNarrativeInput,
): Promise<NarrativeRow> {
  return withWriteTransaction(db, (tx) => {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, col] of Object.entries(UPDATE_COLUMN_MAP)) {
      const value = (patch as Record<string, unknown>)[k];
      if (value !== undefined) {
        sets.push(`${col} = ?`);
        args.push(value);
      }
    }
    if (sets.length > 0) {
      args.push(id);
      const info = tx
        .prepare(`UPDATE narratives SET ${sets.join(', ')} WHERE id = ?`)
        .run(...args);
      if (info.changes === 0) throw new NotFoundError('narrative', id);
    }
    const fresh = getNarrativeById(tx, id);
    if (!fresh) throw new NotFoundError('narrative', id);
    return fresh;
  });
}

export async function deleteNarrative(db: Database, id: string): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx.prepare('DELETE FROM narratives WHERE id = ?').run(id);
    return info.changes > 0;
  });
}
