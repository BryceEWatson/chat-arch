// Phase Rev3-B sub-task B3: add provenance columns to the
// `narratives` table + `turn_index` to `narrative_evidence`.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` Phase Rev3-B:
//   "Add provenance fields (intent, observation, inference,
//    attributedTo, verifiedAt, confidence, supportingCount,
//    contradictingCount, correlatedOutcome) to the Narrative table."
//
// Column shapes mirror `packages/schema/src/narrative.ts`:
//   - `intent` / `observation` / `inference` — TEXT, NULL allowed at
//     the DB layer (B5 backfill populates them post-write); writers
//     on schemaVersion=2 must set all three (enforced at the SDK
//     boundary via `validateNarrative`).
//   - `attributed_to` — TEXT ('deterministic' | 'deterministic-with-prior'
//     | 'llm-derived' | 'falsifier-verified'). NULL on legacy v1 rows.
//   - `verified_at` — TEXT (ISO-8601), NULL until first falsifier run.
//   - `confidence` — REAL in [0,1], NULL on legacy v1 rows.
//   - `supporting_count` / `contradicting_count` — INTEGER ≥ 0,
//     NULL on legacy v1 rows.
//   - `correlated_outcome_json` — TEXT (JSON-stringified
//     `NarrativeCorrelatedOutcome`), NULL when below significance gate.
//
// `schema_version` (INTEGER) lands on `narratives` to discriminate
// the row shape; the existing `001-initial-schema.ts` already creates
// this column with DEFAULT 1, so we don't re-add it here.
//
// `narrative_evidence` gets `turn_index` (INTEGER, NULL allowed) for
// the B2 turn-precision anchor.
//
// All ADD COLUMN operations are nullable + no default (or default
// NULL), so existing rows survive the migration with all new columns
// NULL — i.e. they remain valid as schemaVersion=1.

import type { Database } from 'better-sqlite3';

import type { Migration } from './types.js';

const DDL = `
  ALTER TABLE narratives ADD COLUMN intent TEXT;
  ALTER TABLE narratives ADD COLUMN observation TEXT;
  ALTER TABLE narratives ADD COLUMN inference TEXT;
  ALTER TABLE narratives ADD COLUMN attributed_to TEXT
    CHECK (attributed_to IS NULL OR attributed_to IN (
      'deterministic',
      'deterministic-with-prior',
      'llm-derived',
      'falsifier-verified'
    ));
  ALTER TABLE narratives ADD COLUMN verified_at TEXT;
  ALTER TABLE narratives ADD COLUMN confidence REAL
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
  ALTER TABLE narratives ADD COLUMN supporting_count INTEGER
    CHECK (supporting_count IS NULL OR supporting_count >= 0);
  ALTER TABLE narratives ADD COLUMN contradicting_count INTEGER
    CHECK (contradicting_count IS NULL OR contradicting_count >= 0);
  ALTER TABLE narratives ADD COLUMN correlated_outcome_json TEXT;

  ALTER TABLE narrative_evidence ADD COLUMN turn_index INTEGER
    CHECK (turn_index IS NULL OR turn_index >= 0);
`;

export const narrativeProvenanceMigration: Migration = {
  id: '002-narrative-provenance',
  name: 'Rev3-B narrative provenance columns + evidence turn_index',
  up(db: Database): void {
    db.exec(DDL);
  },
};
