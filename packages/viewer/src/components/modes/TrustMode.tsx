import { useMemo } from 'react';
import type { Decision, DecisionsFile } from '@chat-arch/schema';
import { THRESHOLDS, wilsonCI } from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';

/**
 * Stream J #10 — TRUST surface.
 *
 * 2×2 grid:
 *   rows    = "accepted Claude" / "overrode Claude"
 *   columns = "landed" / "didn't land"
 *
 * Each cell carries a Wilson 95% CI on its share of the row total
 * (landed-given-accepted / landed-given-overrode). Cells with
 * n < `THRESHOLDS.trustCell.minN` are rendered grey ("insufficient n").
 *
 * The "mis-calibration" flag fires ONLY when the CIs for the
 * landed-rate in the two rows do not overlap — meaning the user's
 * accept-vs-override behavior maps onto a statistically distinguishable
 * landed-rate gap.
 *
 * "Calibration" here is about USER behavior (accept vs override),
 * not a causal claim about Claude's outputs — the surface copy never
 * says "Claude predicts X". It says "your override-rate correlates
 * with…", which is descriptive.
 */

export interface TrustModeProps {
  file: DecisionsFile | null;
}

type CellKey = 'accept-land' | 'accept-noland' | 'override-land' | 'override-noland';

interface CellTally {
  accepted: boolean;
  landed: boolean;
  n: number;
}

interface RowSummary {
  accepted: boolean;
  /** Total decisions in this row (n_accepted or n_overrode). */
  total: number;
  /** Landed count. */
  landed: number;
  pHat: number;
  ci: { low: number; high: number };
  meetsCellN: boolean;
}

interface TrustTally {
  cells: Record<CellKey, CellTally>;
  acceptRow: RowSummary;
  overrideRow: RowSummary;
  /** Total joined+actionable decisions used. */
  totalUsable: number;
}

/**
 * Pull (accepted, landed) signal out of a Decision. Prefers the explicit
 * `trustCalibration` field (set by the future Phase 2 #1 builder), then
 * falls back to deriving from the classification + outcomeRef when the
 * field is absent. Returns null when neither path resolves — the row
 * is excluded from the 2x2 entirely.
 */
function derive(d: Decision): { accepted: boolean; landed: boolean } | null {
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

function build2x2(decisions: readonly Decision[]): TrustTally {
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
function cisDisjoint(
  a: { low: number; high: number },
  b: { low: number; high: number },
): boolean {
  return a.high < b.low || b.high < a.low;
}

function formatRate(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${Math.round(p * 100)}%`;
}

export function TrustMode({ file }: TrustModeProps) {
  const tally = useMemo(
    () => (file === null ? null : build2x2(file.decisions)),
    [file],
  );

  if (file === null) {
    return (
      <EmptyState
        title="NO TRUST DATA"
        message="TRUST reads analysis/decisions.json — run the exporter (and the upstream Phase 2 #1 LLM-classification pass) to populate it."
      />
    );
  }

  if (tally === null || tally.totalUsable === 0) {
    return (
      <EmptyState
        title="NO USABLE DECISIONS"
        message="No decisions have both an accept/override signal AND a joined composite outcome yet. Run the LLM-classification pass."
      />
    );
  }

  const minN = THRESHOLDS.trustCell.minN;
  const { cells, acceptRow, overrideRow } = tally;

  // Mis-calibration flag: BOTH rows must meet per-cell minN AND the
  // landed-rate CIs must be disjoint. Anything weaker is "looks
  // suggestive, not statistically distinguishable".
  const bothRowsQualified = acceptRow.meetsCellN && overrideRow.meetsCellN;
  const misCalibrated =
    bothRowsQualified && cisDisjoint(acceptRow.ci, overrideRow.ci);

  return (
    <div className="lcars-trust" aria-label="trust calibration">
      <header className="lcars-trust__header">
        <h2 className="lcars-trust__title">TRUST</h2>
        <p className="lcars-trust__lead">
          Your accept-vs-override behavior on detected decisions, joined to the
          composite-outcome &lsquo;landed&rsquo; signal. Cells with n &lt; {minN} are
          greyed — the per-cell counts are too low to read a rate off. Calibration
          here refers to your decision behavior, not a causal claim about model output.
        </p>
      </header>
      <div
        className="lcars-trust__grid"
        role="table"
        aria-label="accept/override × landed/didn't land"
      >
        <div className="lcars-trust__row lcars-trust__row--head" role="row">
          <span role="columnheader" aria-label="row label" />
          <span role="columnheader">LANDED</span>
          <span role="columnheader">DIDN&rsquo;T LAND</span>
          <span role="columnheader">LANDED-RATE (95% CI)</span>
        </div>
        <div className="lcars-trust__row" role="row" data-row="accept">
          <span role="rowheader">ACCEPTED CLAUDE</span>
          <Cell label="accept-land" n={cells['accept-land'].n} minN={minN} />
          <Cell label="accept-noland" n={cells['accept-noland'].n} minN={minN} />
          <RateCell row={acceptRow} qualified={acceptRow.meetsCellN} />
        </div>
        <div className="lcars-trust__row" role="row" data-row="override">
          <span role="rowheader">OVERRODE CLAUDE</span>
          <Cell label="override-land" n={cells['override-land'].n} minN={minN} />
          <Cell label="override-noland" n={cells['override-noland'].n} minN={minN} />
          <RateCell row={overrideRow} qualified={overrideRow.meetsCellN} />
        </div>
      </div>
      <div
        className={
          'lcars-trust__flag' +
          (misCalibrated ? ' lcars-trust__flag--fired' : ' lcars-trust__flag--quiet')
        }
        role="status"
        aria-live="polite"
        data-testid="miscalibration-flag"
        data-fired={misCalibrated ? 'true' : 'false'}
      >
        {misCalibrated ? (
          <>
            <strong>Mis-calibration:</strong> the landed-rate CIs for ACCEPTED and
            OVERRODE are disjoint ({formatRate(acceptRow.pHat)} vs{' '}
            {formatRate(overrideRow.pHat)}). Your override behavior correlates with a
            measurably different landed-rate.
          </>
        ) : (
          <>
            No mis-calibration flag.{' '}
            {bothRowsQualified
              ? 'Landed-rate CIs overlap — accept-vs-override is not statistically distinguishable on this sample.'
              : `At least one cell has n < ${minN}, so the rate gap can't be tested yet.`}
          </>
        )}
      </div>
    </div>
  );
}

interface CellProps {
  label: CellKey;
  n: number;
  minN: number;
}

function Cell({ label, n, minN }: CellProps) {
  const insufficient = n < minN;
  return (
    <span
      role="cell"
      className={
        'lcars-trust__cell' +
        (insufficient ? ' lcars-trust__cell--insufficient' : '')
      }
      data-cell={label}
      data-testid={`trust-cell-${label}`}
      data-insufficient={insufficient ? 'true' : 'false'}
      title={insufficient ? `n=${n} < ${minN}` : `n=${n}`}
    >
      {n}
    </span>
  );
}

interface RateCellProps {
  row: RowSummary;
  qualified: boolean;
}

function RateCell({ row, qualified }: RateCellProps) {
  if (!qualified) {
    return (
      <span
        role="cell"
        className="lcars-trust__rate lcars-trust__rate--hidden"
        data-testid={`rate-${row.accepted ? 'accept' : 'override'}-hidden`}
      >
        rate hidden — cell n &lt; threshold
      </span>
    );
  }
  return (
    <span
      role="cell"
      className="lcars-trust__rate"
      data-testid={`rate-${row.accepted ? 'accept' : 'override'}`}
    >
      {formatRate(row.pHat)}{' '}
      <span className="lcars-trust__ci">
        [{formatRate(row.ci.low)}–{formatRate(row.ci.high)}]
      </span>
    </span>
  );
}
