/**
 * Per-session composite outcome schema.
 *
 * Aggregates the existing AuditResult[] for a session (extended in Phase 1
 * with gh-PR / git-rework / affirmation claim families) into a single
 * record with a bounded score and a binary "good / bad / unknown" tag.
 *
 * The file is **self-describing**: weights live in the root, the per-row
 * `weightsHash` cross-checks against the file root's `weightsHash` so the
 * viewer can detect partial writes and recompute from primitives when
 * mismatched. Schema-shape changes bump `compositeVersion` (Phase 2 #13
 * will bump 1 → 2 to add `secondary`); weight refits bump `weightsVersion`.
 */

import type { SessionSource } from './unified.js';

export type CompositeOutcomeSignalKind =
  | 'test-pass'
  | 'test-fail'
  | 'build-pass'
  | 'build-fail'
  | 'pr-opened'
  | 'pr-merged'
  | 'pr-closed-unmerged'
  | 'rework-same-session'
  | 'rework-continuation'
  | 'affirmation';

export type CompositeBinary = 'good' | 'bad' | 'unknown';

export interface CompositeWeights {
  testPass: number;
  testFail: number;
  buildPass: number;
  prLandMerged: number;
  prLandClosedUnmerged: number;
  reworkSameSession: number;
  reworkContinuation: number;
  affirmation: number;
}

/**
 * Optional secondary dimensions for the v2 composite (Phase 2 #13 PR-review
 * feedback). NEVER collapsed into the primary score — the v1 score field
 * stays scalar; secondary is a drill-down surface.
 */
export interface CompositeSecondary {
  reviewSubstantiveCount?: number;
  reviewNitCount?: number;
  reviewIterations?: number;
  timeToMergeMs?: number;
}

export interface CompositeOutcome {
  sessionId: string;
  source: SessionSource;
  /** Booleans where signal observed; null when no evidence either way. */
  testPass: boolean | null;
  buildPass: boolean | null;
  prLand: 'merged' | 'closed-unmerged' | 'open' | 'none' | null;
  noRework: boolean | null;
  affirmation: boolean | null;
  /** Sigmoid-output composite in [0, 1]. */
  score: number;
  /** The raw linear logit before sigmoid; stored for sensitivity analysis. */
  linearLogit: number;
  binary: CompositeBinary;
  /** SHA-256 (first 16 hex chars) of canonicalized weights at compute time. */
  weightsHash: string;
  /** Optional secondary dims for v2; absent on v1 rows. */
  secondary?: CompositeSecondary;
}

export interface CompositeOutcomesFile {
  /** Schema-shape version. Phase 2 #13 bumps 1 → 2 to add `secondary`. */
  compositeVersion: 1 | 2;
  /** Weights-set version. Bumped when the calibration refit changes weights. */
  weightsVersion: number;
  /** Canonical weights used to compute every row in this file. */
  weights: CompositeWeights;
  /** SHA-256 (first 16 hex chars) of canonicalized weights. */
  weightsHash: string;
  generatedAt: number;
  outcomes: readonly CompositeOutcome[];
  /** Sessions actually scanned this run (for cache reuse decisions). */
  scannedSessionIds: readonly string[];
}
