// `findings` table SDK. Generic kernel-output table — payload is opaque
// JSON; optional FK columns let the UI filter without parsing.
//
// The `(session_source, session_id)` pair is both-or-neither — enforced
// at the schema level (CHECK constraint, D3 fix on PR #57). The SDK
// asserts the same invariant at the input boundary so callers get a
// typed error rather than a SQLITE_CONSTRAINT_CHECK at insert time.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import type { FindingRow, FindingsFilter, SessionKey } from './types.js';

interface RawFindingRow {
  readonly id: number;
  readonly kernel: string;
  readonly payload_json: string;
  readonly emitted_at: number;
  readonly project_id: string | null;
  readonly topic_id: string | null;
  readonly session_source: string | null;
  readonly session_id: string | null;
  readonly narrative_id: string | null;
  readonly pattern_id: string | null;
}

function rowFromRaw(raw: RawFindingRow): FindingRow {
  return {
    id: raw.id,
    kernel: raw.kernel,
    payloadJson: raw.payload_json,
    emittedAt: raw.emitted_at,
    projectId: raw.project_id,
    topicId: raw.topic_id,
    sessionSource: raw.session_source,
    sessionId: raw.session_id,
    narrativeId: raw.narrative_id,
    patternId: raw.pattern_id,
  };
}

const SELECT_COLUMNS =
  'id, kernel, payload_json, emitted_at, project_id, topic_id, session_source, session_id, narrative_id, pattern_id';

export function getFindingById(db: Database, id: number): FindingRow | null {
  const raw = db
    .prepare<[number], RawFindingRow>(`SELECT ${SELECT_COLUMNS} FROM findings WHERE id = ?`)
    .get(id);
  return raw ? rowFromRaw(raw) : null;
}

export function listFindings(
  db: Database,
  filter: FindingsFilter = {},
): readonly FindingRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.kernel !== undefined) {
    where.push('kernel = ?');
    args.push(filter.kernel);
  }
  for (const col of ['projectId', 'topicId', 'narrativeId', 'patternId'] as const) {
    const value = filter[col];
    if (value === undefined) continue;
    const sqlCol = col === 'projectId'
      ? 'project_id'
      : col === 'topicId'
        ? 'topic_id'
        : col === 'narrativeId'
          ? 'narrative_id'
          : 'pattern_id';
    if (value === null) {
      where.push(`${sqlCol} IS NULL`);
    } else {
      where.push(`${sqlCol} = ?`);
      args.push(value);
    }
  }
  const whereClause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const sql = `SELECT ${SELECT_COLUMNS} FROM findings${whereClause} ORDER BY emitted_at DESC, id DESC`;
  const rows = db.prepare<unknown[], RawFindingRow>(sql).all(...args);
  return rows.map(rowFromRaw);
}

export interface InsertFindingInput {
  readonly kernel: string;
  readonly payloadJson: string;
  readonly emittedAt: number;
  readonly projectId?: string | null;
  readonly topicId?: string | null;
  /** Pass both-or-neither: the schema CHECK enforces it. */
  readonly sessionKey?: SessionKey | null;
  readonly narrativeId?: string | null;
  readonly patternId?: string | null;
}

export async function insertFinding(
  db: Database,
  input: InsertFindingInput,
): Promise<FindingRow> {
  const sessionSource = input.sessionKey?.source ?? null;
  const sessionId = input.sessionKey?.id ?? null;
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(
        `INSERT INTO findings (kernel, payload_json, emitted_at, project_id, topic_id, session_source, session_id, narrative_id, pattern_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kernel,
        input.payloadJson,
        input.emittedAt,
        input.projectId ?? null,
        input.topicId ?? null,
        sessionSource,
        sessionId,
        input.narrativeId ?? null,
        input.patternId ?? null,
      );
    const raw = tx
      .prepare<[number | bigint], RawFindingRow>(
        `SELECT ${SELECT_COLUMNS} FROM findings WHERE id = ?`,
      )
      .get(info.lastInsertRowid);
    if (!raw) {
      throw new Error(
        `findings row vanished mid-transaction (lastInsertRowid=${String(info.lastInsertRowid)})`,
      );
    }
    return rowFromRaw(raw);
  });
}

export async function deleteFinding(db: Database, id: number): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx.prepare('DELETE FROM findings WHERE id = ?').run(id);
    return info.changes > 0;
  });
}
