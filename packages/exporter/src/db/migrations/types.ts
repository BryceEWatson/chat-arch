// Migration shape for the chat-arch SQLite migration framework.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §"SQLite write
// contract" item 4 ("Schema migrations. Versioned via a
// schema_migrations table (migration_id, applied_at). Each Rev 3 phase
// that adds tables/columns ships a migration script; tests assert
// idempotence (running the migration twice is a no-op).")
//
// Design choice: code-as-data. Each migration is a TypeScript module
// exporting `{ id, name, up }` rather than scanning a directory at
// runtime. Reasons: (1) the import graph is statically analyzable,
// so a missing migration file fails at build time; (2) the runner
// doesn't need filesystem access (works against in-memory DBs in
// tests); (3) ordering is explicit in the registry array, not implicit
// from filename sort.

import type { Database } from 'better-sqlite3';

export interface Migration {
  /**
   * Stable identifier. Convention: zero-padded sequence + kebab-case
   * description, e.g. `001-initial-schema`, `002-narrative-provenance`.
   * Persisted in `schema_migrations.id` — never rename.
   */
  readonly id: string;
  /**
   * Human-readable name. Persisted in `schema_migrations.name` for
   * debugging; may be renamed without affecting the runner.
   */
  readonly name: string;
  /**
   * Apply the migration. Runs inside a `BEGIN IMMEDIATE` transaction
   * managed by the runner — implementations should NOT call BEGIN /
   * COMMIT themselves. Either the whole migration applies and gets
   * recorded in `schema_migrations`, or none of it does.
   */
  readonly up: (db: Database) => void;
}
