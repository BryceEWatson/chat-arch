// Migration registry — ordered list of every migration that has
// shipped on the chat-arch SQLite substrate, in apply order.
//
// New migrations append to this array. NEVER reorder, NEVER mutate
// the id or up() of an existing migration once it has shipped to
// users — that breaks the idempotency invariant in the runner.
//
// If a past migration needs to be changed (e.g. fix a bug), write a
// new compensating migration with a new id; don't edit history.

import type { Migration } from './types.js';
import { initialSchemaMigration } from './001-initial-schema.js';
import { narrativeProvenanceMigration } from './002-narrative-provenance.js';
import { entityStatesMigration } from './003-entity-states.js';

export const MIGRATIONS: readonly Migration[] = [
  initialSchemaMigration,
  narrativeProvenanceMigration,
  entityStatesMigration,
];

export { runMigrations } from './runner.js';
export type { Migration } from './types.js';
export type { RunMigrationsResult } from './runner.js';
