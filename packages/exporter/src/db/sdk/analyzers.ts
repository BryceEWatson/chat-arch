// `analyzers` table SDK — kernel registry. The simplest table in the
// schema; serves as the canonical example of the SDK pattern:
//
//   - One Row interface in `types.ts` (camelCase).
//   - Mapping function `rowFrom...()` converts the snake_case
//     better-sqlite3 result to the Row shape.
//   - Reads are synchronous; writes go through `withWriteTransaction`
//     and return Promises.
//   - Prepared statements are recreated per call: better-sqlite3 caches
//     prepared statements internally on the Database handle. Adding a
//     module-level Map would duplicate that cache without measurable
//     benefit at the workloads we expect (low-throughput, kernel-
//     driven). Re-evaluate if profiling shows otherwise.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import { NotFoundError } from './errors.js';
import type { AnalyzerRow } from './types.js';

interface RawAnalyzerRow {
  readonly name: string;
  readonly version: string;
  readonly last_run_at: number | null;
  readonly calibration_completed_at: number | null;
  readonly prior: number;
}

function rowFromRaw(raw: RawAnalyzerRow): AnalyzerRow {
  return {
    name: raw.name,
    version: raw.version,
    lastRunAt: raw.last_run_at,
    calibrationCompletedAt: raw.calibration_completed_at,
    prior: raw.prior,
  };
}

export function getAnalyzerByName(db: Database, name: string): AnalyzerRow | null {
  const raw = db
    .prepare<[string], RawAnalyzerRow>(
      'SELECT name, version, last_run_at, calibration_completed_at, prior FROM analyzers WHERE name = ?',
    )
    .get(name);
  return raw ? rowFromRaw(raw) : null;
}

export function listAnalyzers(db: Database): readonly AnalyzerRow[] {
  const rows = db
    .prepare<[], RawAnalyzerRow>(
      'SELECT name, version, last_run_at, calibration_completed_at, prior FROM analyzers ORDER BY name',
    )
    .all();
  return rows.map(rowFromRaw);
}

export interface UpsertAnalyzerInput {
  readonly name: string;
  readonly version: string;
  readonly lastRunAt?: number | null;
  readonly calibrationCompletedAt?: number | null;
  readonly prior?: number;
}

/**
 * INSERT-OR-REPLACE — the registry tracks current-state per kernel,
 * not history. Run-history lives in `findings`. Default `prior=2.0`
 * matches the DDL default and `THRESHOLDS.narrativeRung.defaultPrior`.
 */
export async function upsertAnalyzer(
  db: Database,
  input: UpsertAnalyzerInput,
): Promise<AnalyzerRow> {
  return withWriteTransaction(db, (tx) => {
    tx.prepare(
      `INSERT INTO analyzers (name, version, last_run_at, calibration_completed_at, prior)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         version = excluded.version,
         last_run_at = excluded.last_run_at,
         calibration_completed_at = excluded.calibration_completed_at,
         prior = excluded.prior`,
    ).run(
      input.name,
      input.version,
      input.lastRunAt ?? null,
      input.calibrationCompletedAt ?? null,
      input.prior ?? 2.0,
    );
    const fresh = getAnalyzerByName(tx, input.name);
    if (!fresh) throw new NotFoundError('analyzer', input.name);
    return fresh;
  });
}

export async function deleteAnalyzer(db: Database, name: string): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx.prepare('DELETE FROM analyzers WHERE name = ?').run(name);
    return info.changes > 0;
  });
}
