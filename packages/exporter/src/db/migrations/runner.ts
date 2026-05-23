// Idempotent migration runner for the chat-arch SQLite substrate.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §"SQLite write
// contract" item 4.
//
// Contract:
//   - On first run against an empty database, creates the
//     `schema_migrations` table and applies every migration in
//     `migrations` in order.
//   - On subsequent runs, applies only migrations whose `id` is not
//     yet present in `schema_migrations`.
//   - Each migration runs in its own transaction (BEGIN IMMEDIATE).
//     If a migration's `up()` throws, the transaction rolls back and
//     `schema_migrations` is unchanged — the next run will retry.
//   - Running twice against the same migrations list is a no-op
//     beyond the initial table-create. Tests must assert this.

import type { Database } from 'better-sqlite3';

import type { Migration } from './types.js';

/**
 * DDL for the `schema_migrations` ledger table. `IF NOT EXISTS` so
 * repeated calls are safe; the runner's first action on any call is to
 * ensure the table exists.
 */
const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

export interface RunMigrationsResult {
  /**
   * Migration IDs applied during this invocation, in apply order.
   * Empty array when every migration was already present.
   */
  readonly applied: readonly string[];
  /**
   * Migration IDs that were already present when the runner started.
   */
  readonly alreadyApplied: readonly string[];
}

/**
 * Apply every migration in `migrations` that isn't already recorded
 * in the database's `schema_migrations` ledger.
 *
 * `migrations` order is the apply order — the runner does NOT sort.
 * That's deliberate: ordering is the responsibility of the caller's
 * registry module (which keeps the list in a single canonical place,
 * see `./index.ts`), and an out-of-order migration list is a
 * programmer error worth surfacing.
 */
export function runMigrations(
  db: Database,
  migrations: readonly Migration[],
): RunMigrationsResult {
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const appliedRows = db
    .prepare<unknown[], { id: string }>('SELECT id FROM schema_migrations')
    .all();
  const alreadyApplied = new Set(appliedRows.map((r) => r.id));

  const insertApplied = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  const applied: string[] = [];
  for (const m of migrations) {
    if (alreadyApplied.has(m.id)) {
      continue;
    }
    // Each migration in its own BEGIN IMMEDIATE; if up() throws the
    // ledger row never lands and the runner can retry on next call.
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      insertApplied.run(m.id, m.name, Date.now());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // See transaction.ts — ROLLBACK can fail if SQLite already
        // auto-rolled back; the original error is more informative.
      }
      throw new Error(
        `Migration ${m.id} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  return {
    applied,
    alreadyApplied: Array.from(alreadyApplied),
  };
}
