// `@chat-arch/exporter/db` — entry point for consumers that need to
// open the chat-arch SQLite substrate from outside the exporter
// process (Phase Rev3-C C4: the standalone Astro app reads/writes
// the entity-states ledger directly through this surface).
//
// Why a dedicated subpath: the main `@chat-arch/exporter` entry pulls
// in source-specific export modules + the cloud/cowork/cli graph, and
// importing those into a standalone API endpoint would expand the
// server-side bundle for no benefit. `./db` exposes just the
// substrate primitives — connection + migrations + SDK — so callers
// pay only for what they use.

export { openDb } from './connection.js';
export type { OpenDbOptions } from './connection.js';

// Re-export the better-sqlite3 Database instance type so downstream
// packages (e.g. apps/standalone) can type their handle without
// taking a direct dep on the native module — the exporter owns that
// contract. Aliased as `Database` (not `Database.Database`) for
// callsite ergonomics.
import type Database_ from 'better-sqlite3';
export type Database = Database_.Database;

export { runMigrations, MIGRATIONS } from './migrations/index.js';
export type {
  Migration,
  RunMigrationsResult,
} from './migrations/index.js';

// `WriterBusyError` + `withWriteTransaction` are intentionally NOT
// re-exported here — the SDK uses them internally via the relative
// `./transaction.js` import, and no current `apps/standalone` caller
// reaches for them directly. Add a re-export when a real consumer
// materializes; until then, dead surface adds bundle / cognitive cost.

export * from './sdk/index.js';
