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
  | 'completion-claim';

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
