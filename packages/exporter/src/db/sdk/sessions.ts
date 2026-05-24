// `sessions` table SDK. Composite primary key `(source, id)` —
// callers pass a `SessionKey` rather than a single string.
//
// Child-row helpers (`session_messages`, `session_revisions`) live in
// sibling files (`sessionMessages.ts`, `sessionRevisions.ts`) — split
// out because each child table is a distinct insertion path with its
// own validation rather than a derivable view.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import { NotFoundError, UniqueViolationError, isUniqueViolation } from './errors.js';
import type { SessionKey, SessionRow } from './types.js';

interface RawSessionRow {
  readonly id: string;
  readonly source: string;
  readonly raw_session_id: string;
  readonly started_at: number;
  readonly updated_at: number;
  readonly duration_ms: number;
  readonly title: string;
  readonly title_source: string;
  readonly preview: string | null;
  readonly project_id: string | null;
  readonly message_count: number;
  readonly tokens_input: number;
  readonly tokens_output: number;
  readonly tokens_cache_creation: number;
  readonly tokens_cache_read: number;
}

function rowFromRaw(raw: RawSessionRow): SessionRow {
  return {
    id: raw.id,
    source: raw.source,
    rawSessionId: raw.raw_session_id,
    startedAt: raw.started_at,
    updatedAt: raw.updated_at,
    durationMs: raw.duration_ms,
    title: raw.title,
    titleSource: raw.title_source,
    preview: raw.preview,
    projectId: raw.project_id,
    messageCount: raw.message_count,
    tokensInput: raw.tokens_input,
    tokensOutput: raw.tokens_output,
    tokensCacheCreation: raw.tokens_cache_creation,
    tokensCacheRead: raw.tokens_cache_read,
  };
}

const SELECT_COLUMNS =
  'id, source, raw_session_id, started_at, updated_at, duration_ms, title, title_source, preview, project_id, message_count, tokens_input, tokens_output, tokens_cache_creation, tokens_cache_read';

export function getSession(db: Database, key: SessionKey): SessionRow | null {
  const raw = db
    .prepare<[string, string], RawSessionRow>(
      `SELECT ${SELECT_COLUMNS} FROM sessions WHERE source = ? AND id = ?`,
    )
    .get(key.source, key.id);
  return raw ? rowFromRaw(raw) : null;
}

export interface ListSessionsFilter {
  readonly projectId?: string | null;
  readonly source?: string;
  /** ms since epoch — only sessions started at-or-after this point. */
  readonly startedAtMin?: number;
  /** ms since epoch — only sessions started before this point. */
  readonly startedAtMax?: number;
  /** Max rows (default unlimited). */
  readonly limit?: number;
}

export function listSessions(
  db: Database,
  filter: ListSessionsFilter = {},
): readonly SessionRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.projectId !== undefined) {
    if (filter.projectId === null) {
      where.push('project_id IS NULL');
    } else {
      where.push('project_id = ?');
      args.push(filter.projectId);
    }
  }
  if (filter.source !== undefined) {
    where.push('source = ?');
    args.push(filter.source);
  }
  if (filter.startedAtMin !== undefined) {
    where.push('started_at >= ?');
    args.push(filter.startedAtMin);
  }
  if (filter.startedAtMax !== undefined) {
    where.push('started_at < ?');
    args.push(filter.startedAtMax);
  }
  const whereClause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const limitClause = filter.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : '';
  const sql = `SELECT ${SELECT_COLUMNS} FROM sessions${whereClause} ORDER BY started_at DESC, source, id${limitClause}`;
  const rows = db.prepare<unknown[], RawSessionRow>(sql).all(...args);
  return rows.map(rowFromRaw);
}

export interface InsertSessionInput {
  readonly id: string;
  readonly source: string;
  readonly rawSessionId: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly durationMs: number;
  readonly title: string;
  readonly titleSource: string;
  readonly preview?: string | null;
  readonly projectId?: string | null;
  readonly messageCount?: number;
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly tokensCacheCreation?: number;
  readonly tokensCacheRead?: number;
}

export async function insertSession(
  db: Database,
  input: InsertSessionInput,
): Promise<SessionRow> {
  return withWriteTransaction(db, (tx) => {
    try {
      tx.prepare(
        `INSERT INTO sessions (id, source, raw_session_id, started_at, updated_at, duration_ms, title, title_source, preview, project_id, message_count, tokens_input, tokens_output, tokens_cache_creation, tokens_cache_read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.source,
        input.rawSessionId,
        input.startedAt,
        input.updatedAt,
        input.durationMs,
        input.title,
        input.titleSource,
        input.preview ?? null,
        input.projectId ?? null,
        input.messageCount ?? 0,
        input.tokensInput ?? 0,
        input.tokensOutput ?? 0,
        input.tokensCacheCreation ?? 0,
        input.tokensCacheRead ?? 0,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError('session', { source: input.source, id: input.id }, err);
      }
      throw err;
    }
    const fresh = getSession(tx, { source: input.source, id: input.id });
    if (!fresh) throw new NotFoundError('session', { source: input.source, id: input.id });
    return fresh;
  });
}

export interface UpdateSessionInput {
  readonly updatedAt?: number;
  readonly durationMs?: number;
  readonly title?: string;
  readonly titleSource?: string;
  readonly preview?: string | null;
  readonly projectId?: string | null;
  readonly messageCount?: number;
  readonly tokensInput?: number;
  readonly tokensOutput?: number;
  readonly tokensCacheCreation?: number;
  readonly tokensCacheRead?: number;
}

const UPDATE_COLUMN_MAP: Readonly<Record<keyof UpdateSessionInput, string>> = {
  updatedAt: 'updated_at',
  durationMs: 'duration_ms',
  title: 'title',
  titleSource: 'title_source',
  preview: 'preview',
  projectId: 'project_id',
  messageCount: 'message_count',
  tokensInput: 'tokens_input',
  tokensOutput: 'tokens_output',
  tokensCacheCreation: 'tokens_cache_creation',
  tokensCacheRead: 'tokens_cache_read',
};

export async function updateSession(
  db: Database,
  key: SessionKey,
  patch: UpdateSessionInput,
): Promise<SessionRow> {
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
      args.push(key.source, key.id);
      const info = tx
        .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE source = ? AND id = ?`)
        .run(...args);
      if (info.changes === 0) throw new NotFoundError('session', key);
    }
    const fresh = getSession(tx, key);
    if (!fresh) throw new NotFoundError('session', key);
    return fresh;
  });
}

export async function deleteSession(db: Database, key: SessionKey): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare('DELETE FROM sessions WHERE source = ? AND id = ?')
      .run(key.source, key.id);
    return info.changes > 0;
  });
}
