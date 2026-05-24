/**
 * Reflexive-lens matched-pair primitive — Phase 1 expansion #14.
 *
 * **This is a descriptive contrast, not a causal estimate.** The viewer
 * copy must say so explicitly. We compute a 1-NN matched pair on
 * pre-treatment-only covariates between sessions that "touched
 * chat-arch" (treated) and those that didn't (control), surface the
 * mean delta of the binarized "good" share with a Wilson-style CI, and
 * a VanderWeele & Ding (2017) E-value on the CI lower bound nearest
 * the null. Unobserved-confounder sensitivity is the E-value's main
 * job here: if the CI-bound E-value is small, a modestly-strong
 * confounder could explain the contrast.
 *
 * Pure. Browser-safe. The "touched" classification is the builder's
 * job — this kernel just consumes the set.
 */

import type { CompositeOutcome } from '@chat-arch/schema';
import { matchedPair1NN, wilsonCI } from './stats.js';

export interface ReflexiveEntry {
  sessionId: string;
  /** Unix ms. */
  updatedAt: number;
  composite: CompositeOutcome;
}

export interface ReflexivePair {
  treatedSessionId: string;
  controlSessionId: string;
  treatedGood: 0 | 1;
  controlGood: 0 | 1;
  /** Euclidean distance in covariate space. */
  distance: number;
}

export type EValueStatus = 'computed' | 'ci-straddles-null' | 'p-control-zero';

export interface ReflexiveResult {
  /** Per-pair good/good comparisons. */
  pairs: readonly ReflexivePair[];
  /** Treated good-share. */
  pTreated: number;
  /** Control good-share (after matching). */
  pControl: number;
  /** pTreated - pControl. */
  meanDelta: number;
  /** Wilson-style CI on the difference of two binarized proportions
   *  (normal-approximation on the difference; matches the ITS kernel
   *  approach for consistency). */
  ci: { low: number; high: number };
  /** VanderWeele & Ding (2017) E-value on the CI bound nearest null.
   *  `null` when the CI straddles the null RR=1. */
  eValueCIBound: number | null;
  /** Why the E-value is what it is — drives the viewer's status copy. */
  eValueStatus: EValueStatus;
  /** Number of treated sessions matched (= number of pairs). */
  nTreated: number;
  /** Number of control sessions in the pool (pre-matching). */
  nControl: number;
}

export type CovariateFn<T> = (entry: T) => readonly number[];

const Z_95 = 1.96;

function deltaProportionCI(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): { low: number; high: number } {
  if (n1 <= 0 || n2 <= 0) return { low: -1, high: 1 };
  const v1 = (p1 * (1 - p1)) / n1;
  const v2 = (p2 * (1 - p2)) / n2;
  const se = Math.sqrt(v1 + v2);
  const delta = p1 - p2;
  return { low: delta - Z_95 * se, high: delta + Z_95 * se };
}

/**
 * VanderWeele & Ding (2017) E-value for a risk-ratio point estimate.
 *
 *   E = RR + sqrt(RR * (RR - 1))
 *
 * For RR < 1 the formula is applied to 1/RR (the "protective" direction
 * has the same E-value as its inverse "harmful" direction).
 *
 * Reference: VanderWeele TJ, Ding P. "Sensitivity Analysis in
 * Observational Research: Introducing the E-Value." Annals of Internal
 * Medicine 167(4), 2017.
 */
function eValueFromRR(rr: number): number {
  if (!Number.isFinite(rr) || rr <= 0) return 1;
  const r = rr < 1 ? 1 / rr : rr;
  return r + Math.sqrt(r * (r - 1));
}

/**
 * Compute the reflexive contrast.
 *
 *   - `entries` is the pool of all candidate sessions.
 *   - `touchedSet` is the set of session ids classified as "touched
 *     chat-arch" — treated. Everyone else in `entries` is control.
 *   - `covariateFn` returns the pre-treatment-only covariate vector.
 *     The kernel does not enforce which fields are or aren't included;
 *     the builder is responsible for using `THRESHOLDS.matching.covariates`
 *     and excluding `filesEdited` / `toolCallDepth` (collider bias).
 *     Documenting that here makes review easier.
 */
export function computeReflexive(
  entries: ReadonlyArray<ReflexiveEntry>,
  touchedSet: ReadonlySet<string>,
  covariateFn: CovariateFn<ReflexiveEntry>,
): ReflexiveResult {
  const treated: ReflexiveEntry[] = [];
  const control: ReflexiveEntry[] = [];
  for (const e of entries) {
    if (touchedSet.has(e.sessionId)) treated.push(e);
    else control.push(e);
  }

  const matched = matchedPair1NN(treated, control, covariateFn);
  const pairs: ReflexivePair[] = matched.map((p) => ({
    treatedSessionId: p.treated.sessionId,
    controlSessionId: p.control.sessionId,
    treatedGood: p.treated.composite.binary === 'good' ? 1 : 0,
    controlGood: p.control.composite.binary === 'good' ? 1 : 0,
    distance: p.distance,
  }));

  const nTreated = pairs.length;
  const nControl = control.length;

  if (nTreated === 0) {
    return {
      pairs,
      pTreated: 0,
      pControl: 0,
      meanDelta: 0,
      ci: { low: -1, high: 1 },
      eValueCIBound: null,
      eValueStatus: 'ci-straddles-null',
      nTreated,
      nControl,
    };
  }

  let goodT = 0;
  let goodC = 0;
  for (const p of pairs) {
    goodT += p.treatedGood;
    goodC += p.controlGood;
  }
  const pTreated = goodT / nTreated;
  const pControl = goodC / nTreated;
  const meanDelta = pTreated - pControl;
  const ci = deltaProportionCI(pTreated, nTreated, pControl, nTreated);

  // E-value on the CI bound NEAREST the null (RR=1). This is the
  // conservative number — the more useful one to display because the
  // point-estimate version overstates robustness when the CI is wide.
  //
  // Risk-ratio scale: RR = pTreated / pControl. When pControl == 0 the
  // RR is undefined; we substitute the Wilson upper bound on pControl
  // as a denominator floor (per the plan's zero-event guard) and
  // flag the status so the viewer can disclose it.
  let eValueCIBound: number | null;
  let eValueStatus: EValueStatus;

  if (ci.low <= 0 && ci.high >= 0) {
    // CI straddles delta=0, which means it straddles RR=1 too.
    eValueCIBound = null;
    eValueStatus = 'ci-straddles-null';
  } else {
    // Convert the CI bound nearest RR=1 in delta-space back to a RR-scale
    // by reconstructing the implied (pTreated*, pControl*) at that bound.
    // We use the symmetric construction: hold pControl fixed at the
    // observed value (with the zero-control substitution) and shift
    // pTreated by the delta bound.
    let pControlForRR = pControl;
    if (pControl === 0) {
      const wilson = wilsonCI(0, nTreated);
      pControlForRR = wilson.high;
      eValueStatus = 'p-control-zero';
    } else {
      eValueStatus = 'computed';
    }

    // Pick the delta-bound nearest zero (i.e. nearest the null).
    const deltaBound = Math.abs(ci.low) < Math.abs(ci.high) ? ci.low : ci.high;
    const pTreatedAtBound = Math.max(0, Math.min(1, pControl + deltaBound));
    const rrAtBound = pControlForRR > 0 ? pTreatedAtBound / pControlForRR : Number.NaN;
    eValueCIBound = Number.isFinite(rrAtBound) ? eValueFromRR(rrAtBound) : null;
    if (eValueCIBound === null && eValueStatus === 'computed') {
      // Degenerate fallback — shouldn't happen given the zero-control
      // guard, but be explicit about why we'd suppress the number.
      eValueStatus = 'p-control-zero';
    }
  }

  return {
    pairs,
    pTreated,
    pControl,
    meanDelta,
    ci,
    eValueCIBound,
    eValueStatus,
    nTreated,
    nControl,
  };
}
