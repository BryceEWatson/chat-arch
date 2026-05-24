// Phase Rev3-F F8 — meta-validation rolling-window kernel.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §
// "Intelligence layer" + Phase Rev3-F F8:
//
//   "Meta-validation of the falsifier itself ... periodic spot-check
//    — sample 10 falsifier verdicts per week, have either the user
//    or a different model role re-judge them, log to
//    `analysis/falsifier-accuracy.json`. If accuracy drifts below
//    0.8 (THRESHOLDS-resident), surface a banner."
//
// Stat-rigor iter-1 finding #003 on the original plan elevated this
// from "n=10/week point estimate" to "rolling 4-week n=40 window with
// Wilson lower bound" — see THRESHOLDS.curator.falsifierAccuracy*
// (window=4 weeks, N=40, floor=0.8). A point estimate on n=10 fires
// the drift banner ~26% of weeks at true accuracy 0.9 (false-alarm
// rate too high). The Wilson LB tames that.
//
// This module owns the pure decision: given a rolling stream of
// `{originalVerdict, reJudgedVerdict}` pairs from the last
// `falsifierAccuracyWindowWeeks` weeks, compute the Wilson lower
// bound on accuracy and emit `{inDrift, n, accuracy, lowerBound}`.
// The /curate skill (Rev3-F F8 stage) is responsible for sampling +
// invoking the re-judge call + writing the analysis sidecar.

import { THRESHOLDS } from './thresholds.js';
import { wilsonCI } from './stats.js';

const MS_PER_DAY = 86_400_000;

/**
 * One sampled verdict pair: what the falsifier originally said vs
 * what the meta-judge (a different model role or the user) said
 * about the same finding's evidenceChain.
 *
 * `agree: true` when both verdicts match exactly; the kernel treats
 * agreement as a "correct" call by the original falsifier, the
 * standard meta-validation operational definition.
 */
export interface VerdictPair {
  /** ms since epoch of when the meta-judge re-judged. */
  readonly judgedAt: number;
  /** Original falsifier verdict on this finding. */
  readonly originalVerdict: 'verified' | 'not-verified';
  /** Meta-judge re-judgment. Same value-space. */
  readonly reJudgedVerdict: 'verified' | 'not-verified';
}

export interface MetaAccuracyResult {
  /**
   * `true` when the Wilson 95% lower bound on accuracy falls below
   * `THRESHOLDS.curator.falsifierAccuracyFloor`. Triggers the
   * banner-state "falsifier accuracy drift detected."
   *
   * Critically: `false` when sample size is below
   * `THRESHOLDS.curator.falsifierAccuracyWindowN` — we don't fire
   * the banner on small-n noise. The `n` field tells the consumer
   * when to wait.
   */
  readonly inDrift: boolean;
  /** Total VerdictPairs in the rolling window. */
  readonly n: number;
  /**
   * Agreement count (originalVerdict === reJudgedVerdict). Exposed
   * so the banner can show "32/40 agreements (80%)" instead of just
   * a single ratio.
   */
  readonly agreementCount: number;
  /** `agreementCount / n`, or 0 when n=0. */
  readonly accuracy: number;
  /**
   * Wilson 95% lower bound on accuracy. The value compared against
   * the floor. Returns 0 when n=0 (matches `wilsonCI(0,0)` which
   * returns `[0, 1]`).
   */
  readonly lowerBound: number;
  /** The threshold the verdict was decided against. */
  readonly floor: number;
  /** The minimum-N threshold below which `inDrift` is forced false. */
  readonly minN: number;
}

export interface MetaAccuracyOptions {
  /**
   * Now in ms since epoch. The kernel filters the input stream to
   * pairs whose `judgedAt > now - windowWeeks * 7 * MS_PER_DAY`.
   */
  readonly now: number;
  /**
   * Override the window length (weeks) for tests. Defaults to
   * `THRESHOLDS.curator.falsifierAccuracyWindowWeeks` (4).
   */
  readonly windowWeeksOverride?: number;
  /**
   * Override the minimum-N for the drift trigger. Defaults to
   * `THRESHOLDS.curator.falsifierAccuracyWindowN` (40).
   */
  readonly minNOverride?: number;
  /**
   * Override the accuracy floor for tests. Defaults to
   * `THRESHOLDS.curator.falsifierAccuracyFloor` (0.8).
   */
  readonly floorOverride?: number;
}

/**
 * Compute the rolling-window meta-accuracy verdict.
 *
 * Filters `pairs` to those judged within `windowWeeks` of `now`,
 * counts agreements, computes Wilson 95% lower bound on the
 * agreement rate, and emits `inDrift` when the LB falls below
 * `floor` AND the sample size meets `minN`.
 *
 * Pure function. Tests can override window / minN / floor to
 * exercise the boundary cases without touching THRESHOLDS.
 */
export function evaluateFalsifierMetaAccuracy(
  pairs: readonly VerdictPair[],
  options: MetaAccuracyOptions,
): MetaAccuracyResult {
  const windowWeeks =
    options.windowWeeksOverride ??
    THRESHOLDS.curator.falsifierAccuracyWindowWeeks;
  const minN =
    options.minNOverride ?? THRESHOLDS.curator.falsifierAccuracyWindowN;
  const floor =
    options.floorOverride ?? THRESHOLDS.curator.falsifierAccuracyFloor;

  const windowMs = windowWeeks * 7 * MS_PER_DAY;
  const cutoffMs = options.now - windowMs;

  let n = 0;
  let agreementCount = 0;
  for (const p of pairs) {
    if (!Number.isFinite(p.judgedAt)) continue;
    if (p.judgedAt <= cutoffMs) continue;
    n += 1;
    if (p.originalVerdict === p.reJudgedVerdict) {
      agreementCount += 1;
    }
  }

  const accuracy = n === 0 ? 0 : agreementCount / n;
  // wilsonCI(0, 0) → {low: 0, high: 1} per the helper's contract.
  const wilson = wilsonCI(accuracy, n);
  const lowerBound = wilson.low;

  // Sample-size guard: don't fire the banner on small-n noise. The
  // plan's "rolling 4-week n=40" requirement is the minN by default.
  // Below that, drift is undetermined (banner stays off; the
  // consumer can render "accumulating verdicts — n/N" instead).
  const inDrift = n >= minN && lowerBound < floor;

  return {
    inDrift,
    n,
    agreementCount,
    accuracy,
    lowerBound,
    floor,
    minN,
  };
}
