// `topics` table SDK.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import { NotFoundError, UniqueViolationError, isUniqueViolation } from './errors.js';
import type { TopicRow } from './types.js';
import { buildUpdateSets } from './updateBuilder.js';

interface RawTopicRow {
  readonly id: string;
  readonly display_name: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

function rowFromRaw(raw: RawTopicRow): TopicRow {
  return {
    id: raw.id,
    displayName: raw.display_name,
    firstSeenAt: raw.first_seen_at,
    lastSeenAt: raw.last_seen_at,
  };
}

const SELECT_COLUMNS = 'id, display_name, first_seen_at, last_seen_at';

export function getTopicById(db: Database, id: string): TopicRow | null {
  const raw = db
    .prepare<[string], RawTopicRow>(`SELECT ${SELECT_COLUMNS} FROM topics WHERE id = ?`)
    .get(id);
  return raw ? rowFromRaw(raw) : null;
}

export function listTopics(db: Database): readonly TopicRow[] {
  const rows = db
    .prepare<[], RawTopicRow>(
      `SELECT ${SELECT_COLUMNS} FROM topics ORDER BY last_seen_at DESC, id`,
    )
    .all();
  return rows.map(rowFromRaw);
}

export interface InsertTopicInput {
  readonly id: string;
  readonly displayName: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export async function insertTopic(
  db: Database,
  input: InsertTopicInput,
): Promise<TopicRow> {
  return withWriteTransaction(db, (tx) => {
    try {
      tx.prepare(
        `INSERT INTO topics (id, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      ).run(input.id, input.displayName, input.firstSeenAt, input.lastSeenAt);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError('topic', input.id, err);
      }
      throw err;
    }
    const fresh = getTopicById(tx, input.id);
    if (!fresh) throw new NotFoundError('topic', input.id);
    return fresh;
  });
}

export interface UpdateTopicInput {
  readonly displayName?: string;
  readonly lastSeenAt?: string;
}

const UPDATE_COLUMN_MAP: Readonly<Record<keyof UpdateTopicInput, string>> = {
  displayName: 'display_name',
  lastSeenAt: 'last_seen_at',
};

export async function updateTopic(
  db: Database,
  id: string,
  patch: UpdateTopicInput,
): Promise<TopicRow> {
  return withWriteTransaction(db, (tx) => {
    const { sets, args } = buildUpdateSets(patch, UPDATE_COLUMN_MAP);
    if (sets.length > 0) {
      const info = tx
        .prepare(`UPDATE topics SET ${sets.join(', ')} WHERE id = ?`)
        .run(...args, id);
      if (info.changes === 0) throw new NotFoundError('topic', id);
    }
    const fresh = getTopicById(tx, id);
    if (!fresh) throw new NotFoundError('topic', id);
    return fresh;
  });
}

export async function deleteTopic(db: Database, id: string): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx.prepare('DELETE FROM topics WHERE id = ?').run(id);
    return info.changes > 0;
  });
}
