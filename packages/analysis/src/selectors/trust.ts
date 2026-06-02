/**
 * TRUST selector — the `data → view-model` derivation behind the TRUST
 * 2×2 surface, extracted VERBATIM from `TrustMode.tsx` (Phase 1 of the
 * "Centralize data processing" refactor).
 *
 * Rows    = "accepted Claude" / "overrode Claude"
 * Columns = "landed" / "didn't land"
 *
 * Each row carries a Wilson 95% CI on its landed-rate. Cells with
 * n < `THRESHOLDS.trustCell.minN` are flagged (rendered grey by the
 * component). The "mis-calibration" flag (`isTrustMisCalibrated`) fires
 * only when BOTH rows meet per-cell minN AND the two landed-rate CIs are
 * disjoint.
 *
 * Pure / deterministic / React-free. Stats come from `wilsonCI` —
 * never reimplemented here.
 */

import type { Decision } from '@chat-arch/schema';
import { THRESHOLDS } from '../thresholds.js';
import { wilsonCI } from '../stats.js';

export type CellKey =
  | 'accept-land'
  | 'accept-noland'
  | 'override-land'
  | 'override-noland';

export interface CellTally {
  accepted: boolean;
  landed: boolean;
  n: number;
}

export interface RowSummary {
  accepted: boolean;
  /** Total decisions in this row (n_accepted or n_overrode). */
  total: number;
  /** Landed count. */
  landed: number;
  pHat: number;
  ci: { low: number; high: number };
  meetsCellN: boolean;
}

export interface TrustTally {
  cells: Record<CellKey, CellTally>;
  acceptRow: RowSummary;
  overrideRow: RowSummary;
  /** Total joined+actionable decisions used. */
  totalUsable: number;
}

/**
 * Pull (accepted, landed) signal out of a Decision. Prefers the explicit
 * `trustCalibration` field (populated by the `/mine-decisions` skill's
 * trust-calibration stage), then falls back to deriving from the
 * classification + outcomeRef when the field is absent (older
 * decisions.json files predating the skill). Returns null when neither
 * path resolves — the row is excluded from the 2x2 entirely.
 */
export function deriveTrustSignal(
  d: Decision,
): { accepted: boolean; landed: boolean } | null {
  const tc = d.trustCalibration;
  if (tc !== null && tc !== undefined) {
    return { accepted: tc.acceptedAssistant, landed: tc.landed };
  }
  // Fallback derivation: requires both classification AND outcomeRef.
  // Without the trustCalibration field we can only make a coarse guess
  // — treat `alternative-block` kind as "accepted assistant" (user
  // picked from the LLM's enumerated alternatives) and everything else
  // as ambiguous. Conservative: skip ambiguous rows so the 2x2 doesn't
  // mix derivations with explicit signals.
  if (d.classification === null || d.outcomeRef === null) return null;
  if (d.outcomeRef.binaryClass === 'neutral') return null;
  const accepted = d.classification.kind === 'alternative-block';
  // Skip non-alternative-block rows in the fallback path so the 2x2
  // doesn't surface guesses as data.
  if (!accepted && d.classification.kind !== 'imperative-choice') return null;
  return {
    accepted,
    landed: d.outcomeRef.binaryClass === 'good',
  };
}

/**
 * Explicit-only signal: use the `trustCalibration` field if present, else
 * null — NO classification/outcomeRef fallback. This is the derivation the
 * ActionItemsBanner's mis-calibration flag used before centralization
 * (`ChatArchViewer.trustMisCalibrationFired`), kept separate from
 * {@link deriveTrustSignal} so the banner's behavior is preserved exactly:
 * the banner counts only decisions with an explicit accept/override signal,
 * whereas the TRUST surface's full 2×2 also folds in the coarse fallback.
 */
export function deriveTrustSignalExplicitOnly(
  d: Decision,
): { accepted: boolean; landed: boolean } | null {
  const tc = d.trustCalibration;
  if (tc !== null && tc !== undefined) {
    return { accepted: tc.acceptedAssistant, landed: tc.landed };
  }
  return null;
}

/**
 * Build the 2×2 trust tally. `derive` defaults to {@link deriveTrustSignal}
 * (the fallback-inclusive signal the TRUST surface uses); pass
 * {@link deriveTrustSignalExplicitOnly} for the explicit-only count the
 * ActionItemsBanner flag uses.
 */
export function build2x2(
  decisions: readonly Decision[],
  derive: (d: Decision) => { accepted: boolean; landed: boolean } | null = deriveTrustSignal,
): TrustTally {
  const cells: Record<CellKey, CellTally> = {
    'accept-land': { accepted: true, landed: true, n: 0 },
    'accept-noland': { accepted: true, landed: false, n: 0 },
    'override-land': { accepted: false, landed: true, n: 0 },
    'override-noland': { accepted: false, landed: false, n: 0 },
  };
  let totalUsable = 0;
  for (const d of decisions) {
    const sig = derive(d);
    if (sig === null) continue;
    totalUsable += 1;
    const key: CellKey = sig.accepted
      ? sig.landed
        ? 'accept-land'
        : 'accept-noland'
      : sig.landed
        ? 'override-land'
        : 'override-noland';
    cells[key]!.n += 1;
  }
  const minN = THRESHOLDS.trustCell.minN;
  const acceptTotal = cells['accept-land'].n + cells['accept-noland'].n;
  const acceptLanded = cells['accept-land'].n;
  const overrideTotal = cells['override-land'].n + cells['override-noland'].n;
  const overrideLanded = cells['override-land'].n;

  const acceptPHat = acceptTotal > 0 ? acceptLanded / acceptTotal : 0;
  const overridePHat = overrideTotal > 0 ? overrideLanded / overrideTotal : 0;

  return {
    cells,
    acceptRow: {
      accepted: true,
      total: acceptTotal,
      landed: acceptLanded,
      pHat: acceptPHat,
      ci: wilsonCI(acceptPHat, acceptTotal),
      meetsCellN:
        cells['accept-land'].n >= minN && cells['accept-noland'].n >= minN,
    },
    overrideRow: {
      accepted: false,
      total: overrideTotal,
      landed: overrideLanded,
      pHat: overridePHat,
      ci: wilsonCI(overridePHat, overrideTotal),
      meetsCellN:
        cells['override-land'].n >= minN && cells['override-noland'].n >= minN,
    },
    totalUsable,
  };
}

/** CIs do not overlap iff one's upper < the other's lower. */
export function cisDisjoint(
  a: { low: number; high: number },
  b: { low: number; high: number },
): boolean {
  return a.high < b.low || b.high < a.low;
}

/**
 * Mis-calibration flag: BOTH rows must meet per-cell minN AND the
 * landed-rate CIs must be disjoint. Anything weaker is "looks
 * suggestive, not statistically distinguishable".
 *
 * Identical to the inline `bothRowsQualified && cisDisjoint(...)` that
 * TrustMode computed at render time. ChatArchViewer's banner flag reaches
 * the same boolean by calling `build2x2(decisions, deriveTrustSignalExplicitOnly)`
 * then this — matching its pre-centralization explicit-only count (the
 * minN check over all four cells + Wilson disjointness are unchanged; only
 * the now-shared `wilsonCI` clamps to [0,1], which cannot flip the test).
 */
export function isTrustMisCalibrated(tally: TrustTally): boolean {
  return (
    tally.acceptRow.meetsCellN &&
    tally.overrideRow.meetsCellN &&
    cisDisjoint(tally.acceptRow.ci, tally.overrideRow.ci)
  );
}
