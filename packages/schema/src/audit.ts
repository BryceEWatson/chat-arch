/**
 * F-layer audit shapes (v2 §5 Layer F).
 *
 * The auditor extracts assistant claims (claim extractor — F.1), runs an
 * evidence verifier against each claim (F.2), and rolls up by claim type
 * and project (F.3). All thresholds + regex patterns live in
 * `packages/analysis/src/auditConfig.ts` so this file stays a pure schema.
 */

import type { SessionSource } from './unified.js';

export type ClaimType =
  | 'fix-claim'
  | 'tests-pass-claim'
  | 'verification-claim'
  | 'addition-claim'
  | 'build-pass-claim'
  | 'completion-claim'
  // Phase 1 Wave 2 (Stream B) — outcome-substrate claim families. The
  // verifier (`packages/analysis/src/auditEvidence.ts`) inspects the
  // structured `TimelineEvent` stream — Bash `tool_use` input.command
  // plus the following `tool_result.isError` — to assign pass / fail /
  // inconclusive. `affirmation` is the positive-polarity mirror of
  // `completion-claim`: a forward window over USER turns checked
  // against `AFFIRMATION_PATTERNS`.
  | 'gh-pr-opened'
  | 'gh-pr-merged'
  | 'gh-pr-closed-unmerged'
  | 'git-revert'
  | 'git-reset-hard'
  | 'git-force-push'
  | 'affirmation';

export type AuditOutcome = 'pass' | 'fail' | 'inconclusive';

/**
 * One extracted assistant claim. Written to `analysis/audit-claims.json`
 * before verification runs. Includes line number + a small context window
 * so reviewers can click through to the source transcript.
 */
export interface AuditClaim {
  sessionId: string;
  source: SessionSource;
  /** 1-based line number of the assistant message inside the transcript. */
  lineNumber: number;
  claimType: ClaimType;
  /** The matched text span (the literal claim, not the surrounding). */
  span: string;
  /** Up to ~400 chars of surrounding assistant text for human review. */
  surroundingContext: string;
}

/**
 * Result of the F.2 verifier for a single claim. Persisted to
 * `analysis/audit-results.json`. `outcome` is one of pass/fail/inconclusive;
 * `reason` is a short human-readable string explaining the verdict.
 */
export interface AuditResult extends AuditClaim {
  outcome: AuditOutcome;
  reason: string;
}

export interface AuditResultsFile {
  version: 1;
  generatedAt: number;
  /**
   * Snapshot of `AUDIT_CONFIG_VERSION` (from `auditConfig.ts`) at write
   * time. Phase 1 Wave 5 (Stream A): added so the migration test can
   * detect cache invalidation across the 1.1.0 → 1.2.0 boundary. Optional
   * on the type for back-compat with 1.1.0 sidecars; emitted on every
   * 1.2.0 write.
   */
  auditConfigVersion?: number;
  totals: Record<AuditOutcome, number>;
  results: readonly AuditResult[];
}

export interface ClaimTypeStats {
  pass: number;
  fail: number;
  inconclusive: number;
}

/**
 * Cross-session aggregate. Drives the daily brief's "audit concerns"
 * section and the `/audit` viewer surface.
 */
export interface AuditSummary {
  version: 1;
  generatedAt: number;
  totals: Record<AuditOutcome, number>;
  byClaimType: Record<ClaimType, ClaimTypeStats>;
  /** Top failures: claim type, count, and a sample of three result spans. */
  topFailureClaimTypes: readonly {
    claimType: ClaimType;
    failCount: number;
    failRate: number;
    samples: readonly { sessionId: string; span: string; reason: string }[];
  }[];
  byProject?: Readonly<Record<string, ClaimTypeStats>>;
}
