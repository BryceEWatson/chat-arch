// Phase Rev3-C sub-task C4 (foundation) — entity_states table for
// the generalized dismiss-state ledger.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase Rev3-C:
//   "Wire the new entity-states ledger to read/write through the
//    SQLite SDK (not a separate JSON file going forward)."
//
// This migration adds the storage table. API-side wiring (replacing
// the JSON file with SDK calls + one-time JSON-→-SQLite import) lands
// in a follow-on PR; this one keeps scope to the schema.
//
// Shape mirrors `EntityStateEntry` in `apps/standalone/src/pages/api/
// entity-states.ts`:
//   - Composite PK `(entity_kind, entity_id)` — one entry per entity.
//   - `entity_kind` CHECK restricted to the two known kinds.
//   - `state` CHECK restricted to `PENDING` | `INSTALLED` | `DISMISSED`.
//   - `size_at_state` INTEGER ≥ 0 — snapshot at state change for the
//     growth-multiplier re-promotion rule.
//   - `dismissal_count` INTEGER ≥ 0 DEFAULT 0 — Phase Rev3-D Closure
//     B saturation counter.
//   - `updated_at` INTEGER (ms since epoch).
//
// `entity_id` is TEXT with a max length check applied at the SDK
// boundary (256 chars per the existing API validator); SQLite
// doesn't enforce VARCHAR(n) so the DDL omits the length.

import type { Database } from 'better-sqlite3';

import type { Migration } from './types.js';

const DDL = `
  CREATE TABLE entity_states (
    entity_kind TEXT NOT NULL
      CHECK (entity_kind IN ('knowledge-debt', 'narrative')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK (state IN ('PENDING', 'INSTALLED', 'DISMISSED')),
    size_at_state INTEGER NOT NULL
      CHECK (size_at_state >= 0),
    dismissal_count INTEGER NOT NULL DEFAULT 0
      CHECK (dismissal_count >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity_kind, entity_id)
  );

  CREATE INDEX idx_entity_states_kind ON entity_states (entity_kind);
  CREATE INDEX idx_entity_states_state ON entity_states (state);
`;

export const entityStatesMigration: Migration = {
  id: '003-entity-states',
  name: 'Rev3-C entity_states table for the generalized dismiss-state ledger',
  up(db: Database): void {
    db.exec(DDL);
  },
};
