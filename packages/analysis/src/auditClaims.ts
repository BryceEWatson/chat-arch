/**
 * F.1 — claim extractor.
 *
 * Pure function: walks an array of (lineNumber, assistantText) pairs and
 * returns every claim that matches one of the configured regex families.
 * The caller (the analysis orchestrator) is responsible for materializing
 * the assistant-text array from each transcript JSONL — see
 * `packages/exporter/src/analysis/auditClaims.ts` (Node I/O shell) for
 * the wiring.
 *
 * Recall-over-precision. The F.2 verifier (Wave 3) decides pass /
 * fail / inconclusive per claim.
 */

import type { AuditClaim, ClaimType, SessionSource } from '@chat-arch/schema';
import { CLAIM_PATTERNS, SURROUNDING_CONTEXT_CHARS } from './auditConfig.js';

export interface AssistantMessage {
  /** 1-based line number inside the transcript file. */
  lineNumber: number;
  text: string;
}

export interface ExtractClaimsResult {
  claims: readonly AuditClaim[];
  /** Per-claim-type counts for the run, for quick diagnostics. */
  totalsByClaimType: Readonly<Record<ClaimType, number>>;
}

const EMPTY_TOTALS: Readonly<Record<ClaimType, number>> = {
  'fix-claim': 0,
  'tests-pass-claim': 0,
  'verification-claim': 0,
  'addition-claim': 0,
  'build-pass-claim': 0,
  'completion-claim': 0,
  // v2 outcome-substrate families
  'gh-pr-opened': 0,
  'gh-pr-merged': 0,
  'gh-pr-closed-unmerged': 0,
  'git-revert': 0,
  'git-reset-hard': 0,
  'git-force-push': 0,
  'affirmation': 0,
};

function makeContext(text: string, matchIndex: number, matchLength: number): string {
  const half = Math.floor(SURROUNDING_CONTEXT_CHARS / 2);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(text.length, matchIndex + matchLength + half);
  return text.slice(start, end);
}

export function extractClaims(
  sessionId: string,
  source: SessionSource,
  messages: readonly AssistantMessage[],
): ExtractClaimsResult {
  const claims: AuditClaim[] = [];
  const totals: Record<ClaimType, number> = { ...EMPTY_TOTALS };

  for (const msg of messages) {
    if (msg.text === '') continue;
    for (const { claimType, regex } of CLAIM_PATTERNS) {
      // We need exec to get the match index; iterate globally without
      // the `g` flag by re-rooting from the last match position.
      let cursor = 0;
      while (cursor < msg.text.length) {
        const slice = msg.text.slice(cursor);
        const m = regex.exec(slice);
        if (m === null) break;
        const absoluteIndex = cursor + (m.index ?? 0);
        const span = m[0] ?? '';
        if (span === '') break;
        claims.push({
          sessionId,
          source,
          lineNumber: msg.lineNumber,
          claimType,
          span,
          surroundingContext: makeContext(msg.text, absoluteIndex, span.length),
        });
        totals[claimType] += 1;
        cursor = absoluteIndex + span.length;
      }
    }
  }

  return { claims, totalsByClaimType: totals };
}
