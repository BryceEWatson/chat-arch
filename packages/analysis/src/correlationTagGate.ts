// Phase Rev3-G G2 — outcome-correlation tag visibility gate.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase
// Rev3-G G2:
//
//   "Outcome-correlation tag visibility gated on `|Δ|/SE` exceeding
//    `curator.outcomeCorrelationSignificance` AND
//    `evidence.length ≥ outcomeCorrelationEvidenceMinLength`."
//
// This module owns the pure decision: given an Outcome-correlation
// effect-size estimate (from a Welch's t-test or permutation test)
// + the candidate's evidence count, return a tagged-union verdict
// the renderer can switch on.

import { THRESHOLDS } from './thresholds.js';

/**
 * The visibility decision for the correlation tag. Tagged union so
 * the renderer can show distinct copy for each non-shown reason
 * (small evidence set vs significance gate vs invalid stat).
 */
export type CorrelationTagVisibility =
  | {
      readonly visible: true;
      readonly absoluteTStat: number;
      readonly significanceThreshold: number;
    }
  | {
      readonly visible: false;
      readonly reason: 'insufficient-evidence';
      readonly evidenceLength: number;
      readonly evidenceMinLength: number;
    }
  | {
      readonly visible: false;
      readonly reason: 'below-significance';
      readonly absoluteTStat: number;
      readonly significanceThreshold: number;
    }
  | {
      readonly visible: false;
      readonly reason: 'invalid-stat';
    };

export interface CorrelationTagInput {
  /**
   * The Welch (or permutation) test result. `valid: false` means
   * the test couldn't be computed (degenerate inputs) — gate
   * returns `'invalid-stat'`.
   */
  readonly stat: {
    readonly t: number;
    readonly valid: boolean;
  };
  /**
   * Number of evidence rows the candidate cites. Must clear
   * `THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength`
   * (default 5).
   */
  readonly evidenceLength: number;
}

/**
 * Apply the two-rail gate: evidence floor AND significance
 * threshold. Both must pass for the tag to be visible.
 *
 * Order of checks matters for the reason code:
 *   1. invalid-stat (test couldn't be computed)
 *   2. insufficient-evidence (small sample)
 *   3. below-significance (test ran, but effect too small)
 *
 * The renderer can use the discriminated reason to show different
 * copy ("not enough evidence yet" vs "effect not significant" vs
 * silence on invalid).
 */
export function evaluateCorrelationTagVisibility(
  input: CorrelationTagInput,
): CorrelationTagVisibility {
  const significanceThreshold =
    THRESHOLDS.curator.outcomeCorrelationSignificance;
  const evidenceMinLength =
    THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength;

  if (!input.stat.valid) {
    return { visible: false, reason: 'invalid-stat' };
  }
  if (input.evidenceLength < evidenceMinLength) {
    return {
      visible: false,
      reason: 'insufficient-evidence',
      evidenceLength: input.evidenceLength,
      evidenceMinLength,
    };
  }
  const absoluteTStat = Math.abs(input.stat.t);
  if (absoluteTStat < significanceThreshold) {
    return {
      visible: false,
      reason: 'below-significance',
      absoluteTStat,
      significanceThreshold,
    };
  }
  return { visible: true, absoluteTStat, significanceThreshold };
}
