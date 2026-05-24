// `patterns` table SDK. Encoded actionable rules promoted from
// Narratives. The `appended_to_claude_md` 0/1 column is exposed as
// `boolean` on the Row type.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import { NotFoundError, UniqueViolationError, isUniqueViolation } from './errors.js';
import type { PatternRow } from './types.js';
import { buildUpdateSets } from './updateBuilder.js';

interface RawPatternRow {
  readonly id: string;
  readonly source_narrative_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly body: string;
  readonly encoded_at: string;
  readonly appended_to_claude_md: number;
}

function rowFromRaw(raw: RawPatternRow): PatternRow {
  return {
    id: raw.id,
    sourceNarrativeId: raw.source_narrative_id,
    projectId: raw.project_id,
    title: raw.title,
    body: raw.body,
    encodedAt: raw.encoded_at,
    appendedToClaudeMd: raw.appended_to_claude_md === 1,
  };
}

const SELECT_COLUMNS =
  'id, source_narrative_id, project_id, title, body, encoded_at, appended_to_claude_md';

export function getPatternById(db: Database, id: string): PatternRow | null {
  const raw = db
    .prepare<[string], RawPatternRow>(`SELECT ${SELECT_COLUMNS} FROM patterns WHERE id = ?`)
    .get(id);
  return raw ? rowFromRaw(raw) : null;
}

export interface ListPatternsFilter {
  readonly projectId?: string;
  readonly sourceNarrativeId?: string;
  readonly appendedToClaudeMd?: boolean;
}

export function listPatterns(
  db: Database,
  filter: ListPatternsFilter = {},
): readonly PatternRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectId !== undefined) {
    where.push('project_id = ?');
    args.push(filter.projectId);
  }
  if (filter.sourceNarrativeId !== undefined) {
    where.push('source_narrative_id = ?');
    args.push(filter.sourceNarrativeId);
  }
  if (filter.appendedToClaudeMd !== undefined) {
    where.push('appended_to_claude_md = ?');
    args.push(filter.appendedToClaudeMd ? 1 : 0);
  }
  const whereClause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const sql = `SELECT ${SELECT_COLUMNS} FROM patterns${whereClause} ORDER BY encoded_at DESC, id`;
  const rows = db.prepare<unknown[], RawPatternRow>(sql).all(...args);
  return rows.map(rowFromRaw);
}

export interface InsertPatternInput {
  readonly id: string;
  readonly sourceNarrativeId: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly encodedAt: string;
  readonly appendedToClaudeMd?: boolean;
}

export async function insertPattern(
  db: Database,
  input: InsertPatternInput,
): Promise<PatternRow> {
  return withWriteTransaction(db, (tx) => {
    try {
      tx.prepare(
        `INSERT INTO patterns (id, source_narrative_id, project_id, title, body, encoded_at, appended_to_claude_md)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.sourceNarrativeId,
        input.projectId,
        input.title,
        input.body,
        input.encodedAt,
        input.appendedToClaudeMd ? 1 : 0,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError('pattern', input.id, err);
      }
      throw err;
    }
    const fresh = getPatternById(tx, input.id);
    if (!fresh) throw new NotFoundError('pattern', input.id);
    return fresh;
  });
}

export interface UpdatePatternInput {
  readonly title?: string;
  readonly body?: string;
  readonly appendedToClaudeMd?: boolean;
}

interface UpdatePatternPersisted {
  readonly title?: string;
  readonly body?: string;
  readonly appendedToClaudeMd?: number;
}

const UPDATE_COLUMN_MAP: Readonly<Record<keyof UpdatePatternPersisted, string>> = {
  title: 'title',
  body: 'body',
  appendedToClaudeMd: 'appended_to_claude_md',
};

export async function updatePattern(
  db: Database,
  id: string,
  patch: UpdatePatternInput,
): Promise<PatternRow> {
  // SQLite stores booleans as 0/1; transform before delegating. Only
  // include keys actually present so exactOptionalPropertyTypes is happy.
  const persisted: UpdatePatternPersisted = {
    ...(patch.title !== undefined && { title: patch.title }),
    ...(patch.body !== undefined && { body: patch.body }),
    ...(patch.appendedToClaudeMd !== undefined && {
      appendedToClaudeMd: patch.appendedToClaudeMd ? 1 : 0,
    }),
  };
  return withWriteTransaction(db, (tx) => {
    const { sets, args } = buildUpdateSets(persisted, UPDATE_COLUMN_MAP);
    if (sets.length > 0) {
      const info = tx
        .prepare(`UPDATE patterns SET ${sets.join(', ')} WHERE id = ?`)
        .run(...args, id);
      if (info.changes === 0) throw new NotFoundError('pattern', id);
    }
    const fresh = getPatternById(tx, id);
    if (!fresh) throw new NotFoundError('pattern', id);
    return fresh;
  });
}

export async function deletePattern(db: Database, id: string): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx.prepare('DELETE FROM patterns WHERE id = ?').run(id);
    return info.changes > 0;
  });
}
