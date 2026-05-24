// Phase Rev3-F F4 — falsifier verifier kernel.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §
// "Intelligence layer (generator / falsifier discipline)":
//
//   "Falsifier is structurally separate: different agent type,
//    different system prompt, different prompt template. It
//    verifies each generator finding's `evidenceChain` cites real
//    session turns whose content supports the claim. Findings whose
//    citations fail the falsifier are dropped before any user-
//    visible surface."
//
// This module owns the *aggregation*: given a finding + the per-
// turn verdicts (one of `'supports' | 'neutral' | 'contradicts' |
// 'unavailable'`), classify the overall finding as `'verified' |
// 'not-verified'`.
//
// The per-turn judgment itself (LLM read of "does this turn say
// what's claimed?") is the /falsify skill's job — see
// `.claude/skills/falsify/SKILL.md`. This kernel is the
// deterministic substrate the skill calls into; the kernel can be
// tested without spawning a subprocess.

import { THRESHOLDS } from './thresholds.js';

/**
 * The four possible per-turn verdicts the /falsify skill returns
 * for each cited turn in a finding's evidenceChain.
 *
 *   - `'supports'`     — turn content does support the claim
 *   - `'neutral'`      — turn doesn't speak to the claim either way
 *   - `'contradicts'`  — turn content actively undermines the claim
 *   - `'unavailable'`  — citation couldn't be resolved (turn missing
 *                       or empty); citation hygiene failure
 */
export type TurnVerdict =
  | 'supports'
  | 'neutral'
  | 'contradicts'
  | 'unavailable';

export interface TurnJudgment {
  /** Stable key — typically `${sessionSource}:${sessionId}:${turnIndex}`. */
  readonly cite: string;
  readonly verdict: TurnVerdict;
  /** One-line rationale from the per-turn LLM call. Optional. */
  readonly reasoning?: string;
}

export interface FalsifierResult {
  readonly verdict: 'verified' | 'not-verified';
  readonly supportingCount: number;
  readonly contradictingCount: number;
  readonly neutralCount: number;
  readonly unavailableCount: number;
  /** Total cited turns considered (sum of the four counts). */
  readonly totalCited: number;
  /**
   * `supportingCount / totalCited` — the value compared against
   * `THRESHOLDS.curator.falsifierMinSupportRatio`. Exposed so the
   * caller can render "supported in 3/5 cited turns" without
   * recomputing.
   */
  readonly supportRatio: number;
  /**
   * The threshold this verdict was decided against. Pinned so a
   * downstream re-render after a THRESHOLDS bump can show "previously
   * verified at 0.6; would now require 0.7 — re-falsify."
   */
  readonly thresholdApplied: number;
  /**
   * True iff zero citations failed to resolve. When false, the UI
   * should NOT render "supported in N/M cited turns" without also
   * disclosing the unresolved-citation count — the citation-hygiene
   * claim in the plan §"Intelligence layer" depends on the user
   * seeing that subset distinction. Surfaced as a derived flag so
   * renderers don't need to re-check `unavailableCount === 0`.
   */
  readonly citationHygieneOk: boolean;
}

/**
 * Aggregate per-turn verdicts into a finding-level outcome.
 *
 * Rule (per plan §"Intelligence layer" + F4 sub-task):
 *
 *   supportRatio = supportingCount / totalCited
 *   verdict = supportRatio >= falsifierMinSupportRatio
 *             ? 'verified'
 *             : 'not-verified'
 *
 * The `unavailable` bucket counts as a FAILURE in the denominator —
 * citation hygiene matters. A finding with `evidenceChain` of N
 * entries where M didn't resolve gets `totalCited = N` and
 * `supportRatio = supports / N`, NOT `supports / (N - M)`.
 *
 * Edge cases:
 *   - Empty `judgments` array → `verdict: 'not-verified'`,
 *     `supportRatio: 0`. A finding with no citations can't be
 *     verified; the LLM never had material to check against.
 *   - `THRESHOLDS.curator.falsifierMinSupportRatio` of `0` (lenient
 *     test override) → empty array still returns `'not-verified'`
 *     because the strict-greater-than-zero contract guards the
 *     "no evidence at all" degenerate case.
 *
 * Pure function. No DB access; the caller resolves cited turns and
 * runs the per-turn LLM before invoking this aggregator.
 *
 * **Persistence contract for /falsify (design-coherence iter-1
 * finding on PR #85):** the F8 meta-validation rolling window
 * re-judges N=40 verdicts and computes Wilson lower bound vs
 * `THRESHOLDS.curator.falsifierAccuracyFloor`. To enable that, the
 * /falsify skill MUST persist the input `TurnJudgment[]` array
 * alongside each `FalsifierResult` — F8 reads the per-turn
 * judgments to re-judge, NOT the aggregate. Aggregate-only
 * persistence would silently break F8.
 */
export function aggregateFalsifierVerdicts(
  judgments: readonly TurnJudgment[],
): FalsifierResult {
  const threshold = THRESHOLDS.curator.falsifierMinSupportRatio;
  let supportingCount = 0;
  let contradictingCount = 0;
  let neutralCount = 0;
  let unavailableCount = 0;
  for (const j of judgments) {
    switch (j.verdict) {
      case 'supports':
        supportingCount += 1;
        break;
      case 'contradicts':
        contradictingCount += 1;
        break;
      case 'neutral':
        neutralCount += 1;
        break;
      case 'unavailable':
        unavailableCount += 1;
        break;
    }
  }
  const totalCited = judgments.length;
  const supportRatio = totalCited === 0 ? 0 : supportingCount / totalCited;
  // The "no citations at all" degenerate case is always not-verified
  // regardless of threshold — there's no evidence to verify against.
  const verdict: FalsifierResult['verdict'] =
    totalCited > 0 && supportRatio >= threshold ? 'verified' : 'not-verified';
  return {
    verdict,
    supportingCount,
    contradictingCount,
    neutralCount,
    unavailableCount,
    totalCited,
    supportRatio,
    thresholdApplied: threshold,
    citationHygieneOk: unavailableCount === 0,
  };
}
