// Phase Rev3-C sub-task C4: add the `entity_states` table that backs
// the entity-states ledger (renamed + generalized from the prior
// `knowledge-debt-states.json` sidecar in C1+C2 / PR #70).
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` Phase Rev3-C:
//   "Wire the new entity-states ledger to read/write through the SQLite
//    SDK (not a separate JSON file going forward)."
//
// Column shapes mirror the v2 EntityStateEntry shape in
// `apps/standalone/src/pages/api/entity-states.ts` (PR #70 + iter-1):
//
//   - `entity_kind`  TEXT NOT NULL, allow-listed via CHECK to keep
//     the SDK from accepting arbitrary kinds. The set grows only when
//     a new entity type starts using the ledger.
//   - `entity_id`    TEXT NOT NULL, application-supplied (cluster id /
//     narrative id). 256-char cap enforced at the SDK layer.
//   - `state`        TEXT NOT NULL, CHECK-constrained to the three
//     known values.
//   - `updated_at`   INTEGER NOT NULL, ms-since-epoch, set at upsert.
//   - `size_at_state` INTEGER NOT NULL. Semantic differs by kind:
//     `sessionIds.length` for knowledge-debt clusters,
//     `evidence.length` for narratives. Closure A's growth-multiplier
//     re-promotion compares the live size against this snapshot.
//   - `dismissal_count` INTEGER NOT NULL DEFAULT 0. Increments each
//     time the entry transitions INTO `DISMISSED` from a non-DISMISSED
//     state; D1 (Closure B) reads this to drive the saturation rule
//     (`THRESHOLDS.narrativeRung.dismissDecay`, default ×2/×4/×8 cap
//     K=`narrativeRung.maxDismissals`).
//
// Composite PK `(entity_kind, entity_id)` matches the JSON v2 ledger's
// upsert key and gives us an O(log n) lookup for the upsert without
// any additional index. Adding a single ORDER BY for "most recently
// updated first" displays is covered by an `updated_at` index.
//
// NULL handling: every column is NOT NULL because every row carries
// real data (no half-written / pending rows in this table). The
// dismissal_count default of 0 lets writers omit it on inserts where
// the transition isn't a DISMISSED action.

import type { Database } from 'better-sqlite3';

import type { Migration } from './types.js';

const DDL = `
  CREATE TABLE entity_states (
    entity_kind TEXT NOT NULL
      CHECK (entity_kind IN ('knowledge-debt', 'narrative')),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK (state IN ('PENDING', 'INSTALLED', 'DISMISSED')),
    updated_at INTEGER NOT NULL,
    size_at_state INTEGER NOT NULL,
    dismissal_count INTEGER NOT NULL DEFAULT 0
      CHECK (dismissal_count >= 0),
    PRIMARY KEY (entity_kind, entity_id)
  );

  CREATE INDEX idx_entity_states_updated_at
    ON entity_states (updated_at DESC);
`;

export const entityStatesMigration: Migration = {
  id: '003-entity-states',
  name: 'Rev3-C entity_states table backing the unified ledger',
  up(db: Database): void {
    db.exec(DDL);
  },
};
