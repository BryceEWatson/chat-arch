import { useMemo, useState } from 'react';
import { formatShortDate } from '../util/time.js';

/**
 * Trajectory chart primitive — line + EWMA overlay + Wilson-CI ribbon.
 *
 * Sister of `Sparkline.tsx`. The base Sparkline draws stacked source bars
 * for weekly *volume*; this one draws a continuous trajectory of a
 * weekly *rate* (mean composite score, binarized-good share, etc.) plus
 * an EWMA smoother and the Wilson 95% CI as a translucent ribbon.
 *
 * Pure presentational — caller pre-computes the series (raw weekly
 * value + EWMA + low/high CI bounds). The component just renders.
 *
 * No causal framing. Copy is strictly trajectory-oriented.
 */

export interface OutcomeWeek {
  /** Unix ms of the week start. Drives the axis labels. */
  start: number;
  /** Raw weekly rate in [0, 1]. */
  value: number;
  /** EWMA-smoothed value at this week, in [0, 1]. */
  ewma: number;
  /** Wilson CI lower bound for the rate at this week, in [0, 1]. */
  ciLow: number;
  /** Wilson CI upper bound for the rate at this week, in [0, 1]. */
  ciHigh: number;
  /** Sample size that produced this week's rate. Drives the tooltip. */
  n: number;
}

export interface OutcomeSparklineProps {
  /** Per-week trajectory series. Empty → renders the empty state. */
  series: readonly OutcomeWeek[];
  /** Optional width in px (SVG viewBox width). Height is fixed at 100px. */
  width?: number;
  /** Visible-area label — e.g. "WEEKLY MEAN COMPOSITE". */
  label?: string;
  /** Tooltip prefix for the raw value — e.g. "MEAN" or "GOOD %". */
  valueLabel?: string;
  /** Whether to show the Wilson-CI ribbon. Defaults to true. */
  showRibbon?: boolean;
}

const HEIGHT = 100;
const PAD_TOP = 6;
const PAD_BOTTOM = 6;

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function buildPath(
  points: ReadonlyArray<{ x: number; y: number }>,
): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]!;
    d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  return d;
}

function buildRibbonPath(
  lo: ReadonlyArray<{ x: number; y: number }>,
  hi: ReadonlyArray<{ x: number; y: number }>,
): string {
  if (lo.length === 0 || hi.length === 0) return '';
  let d = `M ${lo[0]!.x.toFixed(2)} ${lo[0]!.y.toFixed(2)}`;
  for (let i = 1; i < lo.length; i += 1) {
    d += ` L ${lo[i]!.x.toFixed(2)} ${lo[i]!.y.toFixed(2)}`;
  }
  // Walk back along the high bound to close the ribbon.
  for (let i = hi.length - 1; i >= 0; i -= 1) {
    d += ` L ${hi[i]!.x.toFixed(2)} ${hi[i]!.y.toFixed(2)}`;
  }
  d += ' Z';
  return d;
}

export function OutcomeSparkline({
  series,
  width = 480,
  label,
  valueLabel = 'VALUE',
  showRibbon = true,
}: OutcomeSparklineProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const layout = useMemo(() => {
    if (series.length === 0) return null;
    const n = series.length;
    const innerW = width;
    const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const xStep = n > 1 ? innerW / (n - 1) : innerW;
    const toY = (v: number): number => {
      const clamped = Math.max(0, Math.min(1, v));
      return PAD_TOP + (1 - clamped) * innerH;
    };
    const rawPts = series.map((w, i) => ({
      x: n > 1 ? i * xStep : innerW / 2,
      y: toY(w.value),
    }));
    const ewmaPts = series.map((w, i) => ({
      x: n > 1 ? i * xStep : innerW / 2,
      y: toY(w.ewma),
    }));
    const loPts = series.map((w, i) => ({
      x: n > 1 ? i * xStep : innerW / 2,
      y: toY(w.ciLow),
    }));
    const hiPts = series.map((w, i) => ({
      x: n > 1 ? i * xStep : innerW / 2,
      y: toY(w.ciHigh),
    }));
    return { n, innerW, rawPts, ewmaPts, loPts, hiPts };
  }, [series, width]);

  if (series.length === 0 || layout === null) {
    return (
      <div
        className="lcars-outcome-sparkline lcars-outcome-sparkline--empty"
        aria-label="no trajectory data"
      >
        NO TRAJECTORY DATA
      </div>
    );
  }

  const first = series[0]!.start;
  const last = series[series.length - 1]!.start;
  const hovered: OutcomeWeek | null =
    hoverIdx !== null && hoverIdx >= 0 && hoverIdx < series.length
      ? (series[hoverIdx] as OutcomeWeek)
      : null;

  return (
    <div
      className="lcars-outcome-sparkline"
      aria-label={label ?? 'weekly trajectory'}
    >
      {label !== undefined && (
        <div className="lcars-outcome-sparkline__label">{label}</div>
      )}
      <div
        className="lcars-outcome-sparkline__chart"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <svg
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${layout.innerW} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-hidden="true"
        >
          {/* Baseline at the midpoint (binary-good threshold = 0.5). */}
          <line
            x1={0}
            y1={PAD_TOP + (HEIGHT - PAD_TOP - PAD_BOTTOM) / 2}
            x2={layout.innerW}
            y2={PAD_TOP + (HEIGHT - PAD_TOP - PAD_BOTTOM) / 2}
            className="lcars-outcome-sparkline__baseline"
          />
          {showRibbon && (
            <path
              d={buildRibbonPath(layout.loPts, layout.hiPts)}
              className="lcars-outcome-sparkline__ribbon"
              aria-hidden="true"
            />
          )}
          <path
            d={buildPath(layout.rawPts)}
            className="lcars-outcome-sparkline__raw"
            fill="none"
            aria-hidden="true"
          />
          <path
            d={buildPath(layout.ewmaPts)}
            className="lcars-outcome-sparkline__ewma"
            fill="none"
            aria-hidden="true"
          />
          {/* Hit-targets — one per week, full-height. */}
          {series.map((w, i) => {
            const xLeft =
              layout.n > 1
                ? (i - 0.5) * (layout.innerW / (layout.n - 1))
                : 0;
            const slotW =
              layout.n > 1 ? layout.innerW / (layout.n - 1) : layout.innerW;
            return (
              <rect
                key={`hit-${w.start}`}
                x={Math.max(0, xLeft)}
                y={0}
                width={Math.min(slotW, layout.innerW)}
                height={HEIGHT}
                className="lcars-outcome-sparkline__hit"
                onMouseEnter={() => setHoverIdx(i)}
              />
            );
          })}
        </svg>
        {hovered !== null && (
          <div
            className="lcars-outcome-sparkline__tooltip"
            role="status"
            aria-live="polite"
          >
            <div className="lcars-outcome-sparkline__tooltip-head">
              {formatShortDate(hovered.start)} · n={hovered.n}
            </div>
            <div className="lcars-outcome-sparkline__tooltip-row">
              <span className="lcars-outcome-sparkline__tooltip-label">
                {valueLabel}
              </span>
              <span className="lcars-outcome-sparkline__tooltip-value">
                {fmtPct(hovered.value)}
              </span>
            </div>
            <div className="lcars-outcome-sparkline__tooltip-row">
              <span className="lcars-outcome-sparkline__tooltip-label">
                EWMA
              </span>
              <span className="lcars-outcome-sparkline__tooltip-value">
                {fmtPct(hovered.ewma)}
              </span>
            </div>
            {showRibbon && (
              <div className="lcars-outcome-sparkline__tooltip-row">
                <span className="lcars-outcome-sparkline__tooltip-label">
                  95% CI
                </span>
                <span className="lcars-outcome-sparkline__tooltip-value">
                  {fmtPct(hovered.ciLow)} – {fmtPct(hovered.ciHigh)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="lcars-outcome-sparkline__axis">
        <span>{formatShortDate(first)}</span>
        <span>{formatShortDate(last)}</span>
      </div>
    </div>
  );
}
