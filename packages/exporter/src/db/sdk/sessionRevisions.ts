// `session_revisions` child-table SDK. Append-only audit trail for
// transcript-state changes (pruned/recovered/missing) — no update or
// delete API. The DDL FK on `(session_source, session_id)` cascades
// delete, so revisions vanish with the parent session.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import type { SessionKey, SessionRevisionRow } from './types.js';

interface RawSessionRevisionRow {
  readonly id: number;
  readonly session_source: string;
  readonly session_id: string;
  readonly observed_at: number;
  readonly transcript_status: string;
}

function rowFromRaw(raw: RawSessionRevisionRow): SessionRevisionRow {
  return {
    id: raw.id,
    sessionSource: raw.session_source,
    sessionId: raw.session_id,
    observedAt: raw.observed_at,
    transcriptStatus: raw.transcript_status,
  };
}

const SELECT_COLUMNS = 'id, session_source, session_id, observed_at, transcript_status';

export function listSessionRevisions(
  db: Database,
  key: SessionKey,
): readonly SessionRevisionRow[] {
  return db
    .prepare<[string, string], RawSessionRevisionRow>(
      `SELECT ${SELECT_COLUMNS} FROM session_revisions WHERE session_source = ? AND session_id = ? ORDER BY observed_at, id`,
    )
    .all(key.source, key.id)
    .map(rowFromRaw);
}

export interface AppendSessionRevisionInput {
  readonly observedAt: number;
  readonly transcriptStatus: string;
}

export async function appendSessionRevision(
  db: Database,
  key: SessionKey,
  input: AppendSessionRevisionInput,
): Promise<SessionRevisionRow> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(
        `INSERT INTO session_revisions (session_source, session_id, observed_at, transcript_status)
         VALUES (?, ?, ?, ?)`,
      )
      .run(key.source, key.id, input.observedAt, input.transcriptStatus);
    const raw = tx
      .prepare<[number | bigint], RawSessionRevisionRow>(
        `SELECT ${SELECT_COLUMNS} FROM session_revisions WHERE id = ?`,
      )
      .get(info.lastInsertRowid);
    if (!raw) {
      throw new Error(
        `session_revisions row vanished mid-transaction (lastInsertRowid=${String(info.lastInsertRowid)})`,
      );
    }
    return rowFromRaw(raw);
  });
}
