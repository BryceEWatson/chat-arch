/**
 * Methods playbook — positive counterpart to corrections.
 *
 * The corrections pipeline mines moments where the user pushed back on the
 * AI (negative knowledge → CLAUDE.md/skill/agent upgrades). The playbook
 * pipeline mines moments where the user invoked an in-conversation
 * **prompt phrasing** that consistently produced verified outcomes
 * (positive knowledge → a "verbs I reach for" prompt-snippet library).
 *
 * Stage-1 output: heuristic-detected phrasings ranked by occurrence and,
 * when audit data is present, by downstream F-layer pass-rate. The skill
 * layer that consumes this is deferred to PR-B (encoding flow); for now
 * the sidecar is read directly by the viewer.
 *
 * Persistence: `analysis/playbook-candidates.json`. Schema mirrors
 * `correction-candidates.json` so the two surfaces stay shape-symmetric.
 */

import type { ScanStats } from './correction.js';

/**
 * One detected occurrence of a method phrasing in a single user turn.
 *
 * `lineNumber` is the 1-based transcript line where the user turn
 * starts; it powers the join against audit-results.json so the builder
 * can compute downstream pass-rate without re-parsing the transcript.
 */
export interface PlaybookHit {
  sessionId: string;
  /** 0-based index into the session's user turns. */
  userTurnIndex: number;
  /** 1-based line number of the user turn inside the transcript. */
  lineNumber: number;
  /** Verbatim matched phrase (truncated to 80 chars). */
  phrase: string;
  /** Up to ~500 chars of surrounding user text for human review. */
  excerpt: string;
}

/**
 * Downstream-audit rollup for one pattern. Computed at the builder layer
 * by joining hits against `audit-results.json` — for each hit, look at
 * the next N audit claims in the same session whose `lineNumber` is
 * greater than the hit's, and tally outcomes.
 *
 * Absent (or all zero) when no audit sidecar was present at scan time
 * or no claims fell in any hit's downstream window. Consumers MUST
 * gracefully degrade to occurrence-only ranking in that case.
 */
export interface PlaybookPatternAudit {
  pass: number;
  fail: number;
  inconclusive: number;
  /** pass / (pass + fail + inconclusive). 0 when total is 0. */
  passRate: number;
  /** Number of hits that contributed at least one downstream claim. */
  hitsWithSignal: number;
}

/**
 * Aggregate across all hits for one method-phrasing pattern. The viewer
 * renders one row per pattern, ranked by `score` (occurrence × pass-rate
 * when audit data is available; otherwise occurrence alone).
 */
export interface PlaybookPattern {
  /** Stable key — the detector's pattern family slug. */
  patternKey: string;
  /** Short human-readable label for the surface. */
  label: string;
  /** One-line description of what this phrasing does, for the surface. */
  description: string;
  hits: readonly PlaybookHit[];
  occurrenceCount: number;
  /** Distinct sessions where this pattern fired. */
  sessionIds: readonly string[];
  audit: PlaybookPatternAudit;
  /**
   * Ranking score, recomputed at build time.
   *   - When audit signal exists: occurrenceCount * passRate
   *   - Else: occurrenceCount (so the surface still ranks usefully)
   * Stored on disk so the viewer doesn't re-derive.
   */
  score: number;
}

export interface PlaybookCandidatesFile {
  version: 1;
  generatedAt: number;
  heuristicVersion: number;
  /** Whether the audit join produced any signal. False ⇒ rank by count. */
  hasAuditSignal: boolean;
  patterns: readonly PlaybookPattern[];
  scanStats: ScanStats;
}
