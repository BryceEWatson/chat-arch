// Single-writer write transaction helper for chat-arch SQLite.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §"SQLite write
// contract" items 2 + 3.
//
// Why not just `db.transaction(fn)()` (better-sqlite3's built-in)? The
// built-in uses `BEGIN DEFERRED`, which acquires a write lock lazily —
// the lock is escalated on the first INSERT/UPDATE. With multiple
// kernel subprocesses contending for the same database, `DEFERRED` can
// deadlock when two processes have read locks and both try to escalate
// simultaneously (SQLite returns `SQLITE_BUSY` to one of them, but
// only AFTER work has been done). `BEGIN IMMEDIATE` acquires the
// write lock up front: first contender wins, others get `SQLITE_BUSY`
// immediately and can retry without wasted work.
//
// The retry policy is the one pinned in the plan: 50ms exponential
// backoff, doubling, capped at 1s elapsed. After 1s the caller gets a
// `WriterBusyError` and is expected to surface a "writer busy" banner
// or requeue. Concrete reasoning: chat-arch's concurrency profile is
// "a few kernels in parallel" (Wave-7 cap on parallelMap is in the low
// single digits), not "hundreds of writers" — 1s is enough headroom
// for any single competing writer to finish a typical batch.

import type { Database } from 'better-sqlite3';

export class WriterBusyError extends Error {
  constructor(elapsedMs: number, cause?: unknown) {
    super(
      `SQLite writer busy for ${elapsedMs}ms (exceeded retry budget). ` +
        `Surface this as a "writer busy" banner and requeue.`,
    );
    this.name = 'WriterBusyError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export interface WithWriteTransactionOptions {
  /**
   * Total time (ms) we'll spend retrying on SQLITE_BUSY before
   * surfacing `WriterBusyError`. Default 1000 per plan.
   */
  readonly maxElapsedMs?: number;
  /**
   * Initial backoff delay (ms). Doubles on each retry. Default 50.
   */
  readonly initialBackoffMs?: number;
  /**
   * Test hook: provide a deterministic sleep implementation. Default
   * is `setTimeout`-based. Tests pass a fake-timer sleep to avoid
   * real waits.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ELAPSED_MS = 1000;
const DEFAULT_INITIAL_BACKOFF_MS = 50;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` ... `COMMIT` transaction.
 *
 * On `SQLITE_BUSY`, retries with exponential backoff (default
 * 50ms → 100ms → 200ms → ...) until `maxElapsedMs` (default 1000ms).
 * After that, throws `WriterBusyError`.
 *
 * Any other error from `fn` rolls back the transaction and re-throws.
 *
 * `fn` MAY include reads as well as writes — `BEGIN IMMEDIATE`
 * acquires the write lock up front, so reads inside the transaction
 * are guaranteed consistent with the writes.
 */
export async function withWriteTransaction<T>(
  db: Database,
  fn: (db: Database) => T,
  options: WithWriteTransactionOptions = {},
): Promise<T> {
  const maxElapsedMs = options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  const startedAt = Date.now();
  let backoff = initialBackoffMs;
  let lastBusyError: unknown;

  // Loop on SQLITE_BUSY only. Any other error bubbles immediately.
  while (Date.now() - startedAt < maxElapsedMs) {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isBusyError(err)) {
        lastBusyError = err;
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      throw err;
    }

    try {
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ROLLBACK can fail if the transaction was already torn down
        // by the underlying error (e.g. SQLite auto-rollback on schema
        // mismatch). Swallow — the original error is more informative.
      }
      throw err;
    }
  }

  throw new WriterBusyError(Date.now() - startedAt, lastBusyError);
}
