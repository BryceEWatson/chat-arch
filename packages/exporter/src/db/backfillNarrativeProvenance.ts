/**
 * Phase Rev3-B sub-task B5 — one-shot backfill kernel that promotes
 * legacy schemaVersion=1 narratives to schemaVersion=2 with
 * provenance + confidence fields populated.
 *
 * Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase Rev3-B
 *   "Backfill kernel — one-shot run over any existing narratives
 *    (post zero-data start, normally empty) computing confidence
 *    + setting `attributedTo='deterministic'` + bumping to
 *    schemaVersion 2."
 *
 * Backfill contract:
 *   - For each v1 row (`schema_version = 1`):
 *     - `supportingCount` = `COUNT(*) FROM narrative_evidence
 *       WHERE narrative_id = ?` (every existing evidence row treated
 *       as supporting; legacy data has no contradiction tracking).
 *     - `contradictingCount` = 0 (no legacy contradiction info).
 *     - `prior` = `THRESHOLDS.narrativeRung.defaultPrior` (legacy
 *       narratives that survived in the corpus are treated as
 *       informally calibrated; the conservative uncalibratedPrior
 *       would over-suppress them).
 *     - `confidence` = `computeConfidence(supporting, 0, prior)`.
 *     - `attributedTo` = `'deterministic'` per plan §B5.
 *     - `provenance` = synthesized placeholder ({ intent:
 *       'legacy-v1-backfill', observation: title[0..200], inference:
 *       body[0..200] }). Future kernel re-runs will overwrite with
 *       real provenance.
 *     - `schema_version` = 2.
 *   - All writes inside a single `withWriteTransaction` for atomicity;
 *     a partial backfill never lands on disk.
 *
 * Idempotent: a second call on the same DB does nothing (the
 * `schema_version = 1` filter excludes already-backfilled rows).
 *
 * Pure relative to the seed fixture used in tests: same input → same
 * output (no Date.now(), no PRNG, no I/O outside the passed Database
 * handle).
 */

import type { Database } from 'better-sqlite3';

import { computeConfidence, THRESHOLDS } from '@chat-arch/analysis';

import { withWriteTransaction } from './transaction.js';

/** Maximum length for the synthesized provenance.observation/inference
 *  placeholder. Truncate aggressively — these are placeholders only.
 *  See header doc for the rationale. */
const PROVENANCE_PLACEHOLDER_MAX_LEN = 200;

export interface BackfillResult {
  /** Number of v1 rows promoted to v2. */
  readonly promoted: number;
  /** Number of v2 rows that were untouched. */
  readonly untouched: number;
}

interface LegacyRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

interface EvidenceCountRow {
  readonly cnt: number;
}

/**
 * Run the backfill on every v1 narrative in `db`. Returns a count
 * summary. Safe to call repeatedly — already-backfilled (v2) rows
 * are excluded by the SELECT filter.
 */
export async function backfillNarrativeProvenance(
  db: Database,
): Promise<BackfillResult> {
  const legacy = db
    .prepare<[], LegacyRow>(
      `SELECT id, title, body FROM narratives WHERE schema_version = 1`,
    )
    .all();

  const v2Count = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM narratives WHERE schema_version = 2`,
    )
    .get();
  const untouched = v2Count?.cnt ?? 0;

  if (legacy.length === 0) {
    return { promoted: 0, untouched };
  }

  const prior = THRESHOLDS.narrativeRung.defaultPrior;

  await withWriteTransaction(db, (tx) => {
    const countEvidence = tx.prepare<[string], EvidenceCountRow>(
      `SELECT COUNT(*) AS cnt FROM narrative_evidence WHERE narrative_id = ?`,
    );
    const update = tx.prepare(
      `UPDATE narratives SET
        intent = ?,
        observation = ?,
        inference = ?,
        attributed_to = 'deterministic',
        verified_at = NULL,
        confidence = ?,
        supporting_count = ?,
        contradicting_count = 0,
        correlated_outcome_json = NULL,
        schema_version = 2
       WHERE id = ? AND schema_version = 1`,
    );
    for (const row of legacy) {
      const evidenceCount = countEvidence.get(row.id)?.cnt ?? 0;
      const confidence = computeConfidence(evidenceCount, 0, prior);
      // computeConfidence returns NaN only on invalid inputs we
      // control (evidence count is non-negative INTEGER from SQL;
      // prior is THRESHOLDS-pinned). Defensive guard regardless.
      const safeConfidence = Number.isFinite(confidence) ? confidence : 0;
      const observation = row.title.slice(0, PROVENANCE_PLACEHOLDER_MAX_LEN);
      const inference = row.body.slice(0, PROVENANCE_PLACEHOLDER_MAX_LEN);
      update.run(
        'legacy-v1-backfill',
        observation,
        inference,
        safeConfidence,
        evidenceCount,
        row.id,
      );
    }
  });

  return { promoted: legacy.length, untouched };
}
