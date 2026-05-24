// Phase Rev3-E sub-task E2: add `falsifier_status` column to the
// `patterns` table for the Closure-C falsifier-gating signal.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` Phase Rev3-E:
//   "Pattern entity schema gains `falsifierStatus: 'verified' |
//    'skipped-by-user' | 'unavailable'`."
//
// Column shape mirrors `packages/schema/src/pattern.ts`:
//   - `falsifier_status` — TEXT, NULL allowed for pre-Rev3-E rows.
//     CHECK constraint enumerates the three terminal states matching
//     `PatternFalsifierStatus` so the DB can catch typos before the
//     SDK can.
//
// ADD COLUMN is nullable + no default, so existing rows survive the
// migration with `falsifier_status` NULL — i.e. they remain valid
// pre-Rev3-E patterns until a re-encode or backfill populates them.

import type { Database } from 'better-sqlite3';

import type { Migration } from './types.js';

const DDL = `
  ALTER TABLE patterns ADD COLUMN falsifier_status TEXT
    CHECK (falsifier_status IS NULL OR falsifier_status IN (
      'verified',
      'skipped-by-user',
      'unavailable'
    ));
`;

export const patternFalsifierStatusMigration: Migration = {
  id: '004-pattern-falsifier-status',
  name: 'Rev3-E pattern falsifier_status column',
  up(db: Database): void {
    db.exec(DDL);
  },
};
