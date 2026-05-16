/**
 * Continuum-health sidecar shape (v2 §5 B.1 / B.2).
 *
 * Written by the analysis orchestrator after every successful scan to
 * `analysis/continuum-health.json`. Drives the viewer footer + the daily
 * brief's "Continuum health" section. Captures both the per-status entry
 * histogram and per-source capture-rate warnings.
 */

import type { SessionSource } from './unified.js';

export type ContinuumWarningKind =
  | 'missing-rate-high'
  | 'crashed-count-high';

export interface ContinuumWarning {
  source: SessionSource;
  kind: ContinuumWarningKind;
  /** Observed value (a count or a ratio depending on kind). */
  value: number;
  /** Threshold the value crossed. */
  threshold: number;
}

export interface ContinuumHealth {
  version: 1;
  /** ISO 8601 timestamp of the most recent scan attempt. */
  lastScanAt: string;
  /** ISO 8601 of the most recent scan that completed without error. */
  lastSuccessfulScanAt: string | null;
  /** Cumulative count of consecutive successful scans (resets to 0 on failure). */
  consecutiveSuccesses: number;
  /** Distinct sources represented in the manifest at scan time. */
  sourcesScanned: readonly SessionSource[];
  entriesByStatus: {
    ok: number;
    missing: number;
    crashed: number;
    pruned: number;
  };
  /** Sessions whose startedAt is later than the prior lastSuccessfulScanAt. */
  newSessionsSinceLast: number;
  warnings: readonly ContinuumWarning[];
}
