// Tests for the Rev3-B B5 backfill kernel.
// Uses the existing seeded fixture from A11 (4 v1 narratives + 1 v2)
// so we exercise the realistic mixed case without re-building a
// bespoke fixture here.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeConfidence,
  THRESHOLDS,
} from '@chat-arch/analysis';

import { openDb } from './connection.js';
import { MIGRATIONS, runMigrations } from './migrations/index.js';
import { backfillNarrativeProvenance } from './backfillNarrativeProvenance.js';
import { SEED_IDS, seedRev3Fixture } from './sdk/seedFixture.js';

interface BackfillCheckRow {
  readonly id: string;
  readonly schema_version: number;
  readonly intent: string | null;
  readonly observation: string | null;
  readonly inference: string | null;
  readonly attributed_to: string | null;
  readonly verified_at: string | null;
  readonly confidence: number | null;
  readonly supporting_count: number | null;
  readonly contradicting_count: number | null;
  readonly correlated_outcome_json: string | null;
}

describe('backfillNarrativeProvenance (B5)', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-b5-test-'));
    db = openDb(join(tmpDir, 'b5.db'));
    runMigrations(db, MIGRATIONS);
    await seedRev3Fixture(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('promotes all v1 narratives to v2 in one call (seedFixture has 4 v1 + 1 v2)', async () => {
    const result = await backfillNarrativeProvenance(db);
    expect(result.promoted).toBe(4);
    expect(result.untouched).toBe(1);

    const rows = db
      .prepare<[], { schema_version: number; cnt: number }>(
        `SELECT schema_version, COUNT(*) AS cnt FROM narratives GROUP BY schema_version ORDER BY schema_version`,
      )
      .all();
    expect(rows).toEqual([{ schema_version: 2, cnt: 5 }]);
  });

  it('idempotent — second call promotes 0, untouched count includes the already-promoted rows', async () => {
    const first = await backfillNarrativeProvenance(db);
    expect(first.promoted).toBe(4);

    const second = await backfillNarrativeProvenance(db);
    expect(second.promoted).toBe(0);
    expect(second.untouched).toBe(5);
  });

  it('populates provenance + attributedTo + confidence + counts on every promoted row', async () => {
    await backfillNarrativeProvenance(db);
    const rows = db
      .prepare<[], BackfillCheckRow>(
        `SELECT id, schema_version, intent, observation, inference,
                attributed_to, verified_at, confidence,
                supporting_count, contradicting_count, correlated_outcome_json
         FROM narratives ORDER BY id`,
      )
      .all();

    for (const row of rows) {
      if (row.id === SEED_IDS.narratives.n3) {
        // n3 was already v2 — backfill must NOT touch it. Verify the
        // pre-existing nulls survived.
        expect(row.schema_version).toBe(2);
        expect(row.intent).toBeNull();
        expect(row.attributed_to).toBeNull();
        expect(row.confidence).toBeNull();
        continue;
      }
      // Promoted rows.
      expect(row.schema_version).toBe(2);
      expect(row.intent).toBe('legacy-v1-backfill');
      expect(row.observation).not.toBeNull();
      expect(row.inference).not.toBeNull();
      expect(row.attributed_to).toBe('deterministic');
      expect(row.verified_at).toBeNull();
      expect(row.contradicting_count).toBe(0);
      expect(row.correlated_outcome_json).toBeNull();
      expect(typeof row.confidence).toBe('number');
      expect(row.confidence!).toBeGreaterThanOrEqual(0);
      expect(row.confidence!).toBeLessThanOrEqual(1);
      expect(typeof row.supporting_count).toBe('number');
      expect(row.supporting_count!).toBeGreaterThanOrEqual(0);
    }
  });

  it('supporting_count equals the count of narrative_evidence rows', async () => {
    await backfillNarrativeProvenance(db);
    // n1 had 2 evidence rows per seedFixture; n5 had 1; n2/n4 had 0.
    const n1 = db
      .prepare<[string], { supporting_count: number | null }>(
        `SELECT supporting_count FROM narratives WHERE id = ?`,
      )
      .get(SEED_IDS.narratives.n1);
    expect(n1?.supporting_count).toBe(2);

    const n5 = db
      .prepare<[string], { supporting_count: number | null }>(
        `SELECT supporting_count FROM narratives WHERE id = ?`,
      )
      .get(SEED_IDS.narratives.n5);
    expect(n5?.supporting_count).toBe(1);

    const n2 = db
      .prepare<[string], { supporting_count: number | null }>(
        `SELECT supporting_count FROM narratives WHERE id = ?`,
      )
      .get(SEED_IDS.narratives.n2);
    expect(n2?.supporting_count).toBe(0);

    const n4 = db
      .prepare<[string], { supporting_count: number | null }>(
        `SELECT supporting_count FROM narratives WHERE id = ?`,
      )
      .get(SEED_IDS.narratives.n4);
    expect(n4?.supporting_count).toBe(0);
  });

  it('confidence equals computeConfidence(supporting, 0, defaultPrior)', async () => {
    await backfillNarrativeProvenance(db);
    const rows = db
      .prepare<[], { supporting_count: number; confidence: number }>(
        `SELECT supporting_count, confidence FROM narratives
         WHERE schema_version = 2 AND attributed_to = 'deterministic'`,
      )
      .all();
    const prior = THRESHOLDS.narrativeRung.defaultPrior;
    for (const row of rows) {
      const expected = computeConfidence(row.supporting_count, 0, prior);
      expect(row.confidence).toBeCloseTo(expected, 9);
    }
  });

  it('returns {promoted: 0, untouched: 0} on an empty DB', async () => {
    // Fresh DB without seedFixture call.
    db.close();
    const fresh = openDb(join(tmpDir, 'empty.db'));
    try {
      runMigrations(fresh, MIGRATIONS);
      const r = await backfillNarrativeProvenance(fresh);
      expect(r.promoted).toBe(0);
      expect(r.untouched).toBe(0);
    } finally {
      fresh.close();
    }
  });

  it('truncates synthesized observation/inference at 200 chars (PII / placeholder boundary)', async () => {
    // Insert a v1 narrative with a long title and body.
    const longTitle = 'T'.repeat(500);
    const longBody = 'B'.repeat(500);
    db.prepare(
      `INSERT INTO narratives (id, project_id, sentiment, title, body, generated_at, action_type, schema_version)
       VALUES ('n-long', ?, 'positive', ?, ?, '2025-01-01T00:00:00Z', 'encode-as-pattern', 1)`,
    ).run(SEED_IDS.projects.p1, longTitle, longBody);

    await backfillNarrativeProvenance(db);

    const row = db
      .prepare<[string], { observation: string; inference: string }>(
        `SELECT observation, inference FROM narratives WHERE id = ?`,
      )
      .get('n-long');
    expect(row?.observation.length).toBe(200);
    expect(row?.inference.length).toBe(200);
  });
});
