// `session_messages` child-table SDK. The exporter writes these in
// bulk per session; kernel scans read them back. No `update` path —
// messages are immutable in the source transcripts; re-parses overwrite
// via the standard delete-then-bulk-insert pattern documented below.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import type { SessionKey, SessionMessageRow } from './types.js';

interface RawSessionMessageRow {
  readonly session_source: string;
  readonly session_id: string;
  readonly turn_index: number;
  readonly role: string;
  readonly content: string | null;
  readonly timestamp: number | null;
}

function rowFromRaw(raw: RawSessionMessageRow): SessionMessageRow {
  return {
    sessionSource: raw.session_source,
    sessionId: raw.session_id,
    turnIndex: raw.turn_index,
    role: raw.role,
    content: raw.content,
    timestamp: raw.timestamp,
  };
}

const SELECT_COLUMNS =
  'session_source, session_id, turn_index, role, content, timestamp';

export function listSessionMessages(
  db: Database,
  key: SessionKey,
): readonly SessionMessageRow[] {
  return db
    .prepare<[string, string], RawSessionMessageRow>(
      `SELECT ${SELECT_COLUMNS} FROM session_messages WHERE session_source = ? AND session_id = ? ORDER BY turn_index`,
    )
    .all(key.source, key.id)
    .map(rowFromRaw);
}

export interface InsertSessionMessageInput {
  readonly turnIndex: number;
  readonly role: string;
  readonly content?: string | null;
  readonly timestamp?: number | null;
}

/**
 * Replace the message rows for a session in a single transaction.
 * Pattern: kernel-driven re-parses recreate the full transcript rather
 * than diff it; one DELETE + bulk INSERT keeps the transaction small
 * and atomic. `inputs` is asserted to be already in turn-index order;
 * the SDK does not re-sort.
 */
export async function replaceSessionMessages(
  db: Database,
  key: SessionKey,
  inputs: readonly InsertSessionMessageInput[],
): Promise<readonly SessionMessageRow[]> {
  return withWriteTransaction(db, (tx) => {
    tx.prepare(
      'DELETE FROM session_messages WHERE session_source = ? AND session_id = ?',
    ).run(key.source, key.id);
    const insert = tx.prepare(
      `INSERT INTO session_messages (session_source, session_id, turn_index, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const input of inputs) {
      insert.run(
        key.source,
        key.id,
        input.turnIndex,
        input.role,
        input.content ?? null,
        input.timestamp ?? null,
      );
    }
    return listSessionMessages(tx, key);
  });
}
