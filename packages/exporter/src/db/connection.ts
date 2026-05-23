// Connection helper for the chat-arch SQLite substrate.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §"SQLite write
// contract" items 1 + 2.
//
// What this gives downstream callers:
//
//   - `journal_mode = WAL` — unlimited reader concurrency, single
//     writer per process. The journal lives next to the .db file as
//     `<name>.db-wal` + `<name>.db-shm` (already in `.gitignore`).
//   - `synchronous = NORMAL` — fsync on each commit but not every
//     write. WAL + NORMAL is the documented sweet spot for read-heavy
//     workloads; it survives application crashes (transactions roll
//     back from the WAL) and only loses durability against a kernel
//     panic mid-transaction.
//   - `foreign_keys = ON` — SQLite's per-connection default is OFF;
//     we enable it explicitly so the `FOREIGN KEY (...) REFERENCES`
//     constraints in the initial schema migration actually fire.
//   - `busy_timeout = 0` — we handle `SQLITE_BUSY` ourselves in
//     `withWriteTransaction` (see `./transaction.ts`) with explicit
//     50ms exponential backoff. Letting better-sqlite3's default
//     timeout fire would hide concurrency contention from the caller.
//
// Why this helper exists rather than callers doing `new Database(...)`
// directly: the four pragmas above are the connection contract from
// the spec amendment. Forgetting any of them silently degrades safety
// or performance, and there's no way to tell from the resulting DB
// file which connections were correctly configured.

import Database from 'better-sqlite3';

export interface OpenDbOptions {
  /**
   * Open the database read-only. Skips the WAL/synchronous pragmas
   * (read-only connections don't need them) but still enables
   * foreign_keys so joined queries respect FK constraints.
   */
  readonly readonly?: boolean;
}

/**
 * Open a SQLite database at `path` with the chat-arch connection
 * contract applied.
 *
 * Callers are responsible for closing the returned handle (typically
 * via `db.close()` in a `finally` block, or via process-exit cleanup
 * if the DB lives for the lifetime of the process).
 *
 * For `:memory:` databases, the WAL pragma is a no-op (SQLite reports
 * `memory` and ignores the WAL request); the other pragmas still apply
 * and the helper does not throw. Treat in-memory connections as a
 * test-only convenience.
 */
export function openDb(
  path: string,
  options: OpenDbOptions = {},
): Database.Database {
  const db = new Database(path, options.readonly ? { readonly: true } : {});

  // Foreign keys are per-connection in SQLite. Always on, even for
  // read-only connections (so joined queries see consistent state).
  db.pragma('foreign_keys = ON');

  if (options.readonly) {
    return db;
  }

  // WAL + synchronous=NORMAL per plan §"SQLite write contract" item 1.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // We handle SQLITE_BUSY in withWriteTransaction; disable the
  // implicit timeout that would otherwise mask contention.
  db.pragma('busy_timeout = 0');

  return db;
}
