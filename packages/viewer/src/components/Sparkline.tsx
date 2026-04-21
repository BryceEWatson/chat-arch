import { useMemo, useState } from 'react';
import type { SessionSource, UnifiedSessionEntry } from '@chat-arch/schema';
import { bucketByWeekBySource, type WeekBucketBySource } from '../data/search.js';
import { formatShortDate } from '../util/time.js';

export interface SparklineProps {
  /** Sessions to bucket. Typically the full manifest (unfiltered baseline). */
  allSessions: readonly UnifiedSessionEntry[];
  /**
   * Sessions currently visible after filters. Bars in this set render at full
   * opacity; bars outside render at 30% opacity.
   */
  visibleSessions: readonly UnifiedSessionEntry[];
  /** Optional width in px. Height is fixed at 60px per LCARS spec. */
  width?: number;
}

/** SVG height. Previously 60px; pushed to 100 so the weekly-volume
 *  rhythm reads as a prominent visual rather than a decorative
 *  bar. Axis labels are styled up to match (larger mono date ticks
 *  via `lcars-sparkline__axis`). */
const HEIGHT = 100;

const WEEK_MS = 7 * 86_400_000;

/** "Apr 5 – Apr 11" — half-open week range for tooltip copy. */
function formatWeekRange(start: number): string {
  const end = start + WEEK_MS - 86_400_000;
  return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

/**
 * Per-source rendering order for the stack. Colors match the LCARS source
 * palette used across the viewer so the legend is consistent.
 *
 * We draw from bottom to top in this order; when a user runs `Update Local`
 * on top of a demo (cloud) load, the new local-source segments appear as
 * distinctly-colored layers *on top of* the existing cloud bars — the merge
 * is unmistakable rather than looking like a silent height rescale.
 */
const SOURCE_ORDER: readonly SessionSource[] = [
  'cloud',
  'cowork',
  'cli-direct',
  'cli-desktop',
];
const SOURCE_COLOR: Record<SessionSource, string> = {
  cloud: 'var(--lcars-violet)',
  cowork: 'var(--lcars-butterscotch)',
  'cli-direct': 'var(--lcars-ice)',
  'cli-desktop': 'var(--lcars-peach)',
};
const SOURCE_LABEL: Record<SessionSource, string> = {
  cloud: 'CLOUD',
  cowork: 'COWORK',
  'cli-direct': 'CLI-DIRECT',
  'cli-desktop': 'CLI-DESKTOP',
};

/**
 * Month-tick positions. Produces one tick per visible month boundary
 * (the first bucket whose month differs from the previous), plus an
 * anchoring tick for the very first bucket so the axis isn't blank
 * before the first month change.
 */
interface MonthTick {
  /** Index of the bucket whose left edge the tick should sit above. */
  bucketIndex: number;
  /** Label (e.g., "APR 2025"). Year suffix added only at year boundaries. */
  label: string;
}
function computeMonthTicks(buckets: readonly WeekBucketBySource[]): readonly MonthTick[] {
  if (buckets.length === 0) return [];
  const ticks: MonthTick[] = [];
  let lastMonth = -1;
  let lastYear = -1;
  for (let i = 0; i < buckets.length; i += 1) {
    const d = new Date(buckets[i]!.start);
    const m = d.getUTCMonth();
    const y = d.getUTCFullYear();
    const monthChanged = m !== lastMonth;
    const yearChanged = y !== lastYear;
    if (monthChanged || yearChanged) {
      const monthLabel = d.toLocaleDateString('en-US', {
        month: 'short',
        timeZone: 'UTC',
      }).toUpperCase();
      // Year suffix only at year boundaries (or on the very first tick)
      // so the axis stays scannable — every tick carrying a year would
      // read as noise at typical corpus density.
      const label = yearChanged ? `${monthLabel} ${y}` : monthLabel;
      ticks.push({ bucketIndex: i, label });
      lastMonth = m;
      lastYear = y;
    }
  }
  return ticks;
}

export function Sparkline({ allSessions, visibleSessions, width = 480 }: SparklineProps) {
  const { buckets, visibleByStart, max, peakIndex, stats, monthTicks, presentSources } = useMemo(() => {
    const b = bucketByWeekBySource(allSessions);
    const v = new Map<number, number>();
    for (const s of bucketByWeekBySource(visibleSessions)) v.set(s.start, s.total);
    let m = 0;
    let peak = -1;
    let total = 0;
    let visibleTotal = 0;
    const srcSeen = new Set<SessionSource>();
    for (let i = 0; i < b.length; i += 1) {
      const bk = b[i]!;
      total += bk.total;
      visibleTotal += v.get(bk.start) ?? 0;
      if (bk.total > m) {
        m = bk.total;
        peak = i;
      }
      for (const src of SOURCE_ORDER) {
        if ((bk.bySource[src] ?? 0) > 0) srcSeen.add(src);
      }
    }
    const weeks = b.length;
    const avg = weeks > 0 ? total / weeks : 0;
    const ticks = computeMonthTicks(b);
    // Keep the legend order stable (SOURCE_ORDER) but only include sources
    // actually present in the data — a legend listing an empty source is noise.
    const presentSourcesArr: SessionSource[] = SOURCE_ORDER.filter((s) => srcSeen.has(s));
    return {
      buckets: b,
      visibleByStart: v,
      max: m,
      peakIndex: peak,
      stats: { total, visibleTotal, peak: m, avgPerWeek: avg, weeks },
      monthTicks: ticks,
      presentSources: presentSourcesArr,
    };
  }, [allSessions, visibleSessions]);

  // Hover state: bucket index under the cursor (or focused by keyboard).
  // Null when nothing is hovered — the tooltip hides entirely.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (buckets.length === 0 || max === 0) {
    return (
      <div className="lcars-sparkline lcars-sparkline--empty" aria-label="no activity">
        NO ACTIVITY
      </div>
    );
  }

  // Bar + slot geometry. The SVG stretches to 100% of its container
  // via `preserveAspectRatio="none"`, so viewBox aspect ratio drives
  // the rendered height (CSS `height: auto` uses the viewBox shape).
  // To keep the chart height reasonable we preserve the original
  // totalW ~ `width` so the viewBox stays wide-and-short (~4.7:1).
  //
  // "Half-thickness" bars: each bucket occupies a SLOT of roughly
  // `width/n` pixels, but the visible bar fills only half the slot —
  // centered — with the other half acting as breathing room on each
  // side. User's request was bars at half the old thickness while
  // keeping the bucket granularity; this is the cleanest way.
  const n = buckets.length;
  const gap = 2;
  const slotW = Math.max(2, Math.floor((width - gap * (n - 1)) / n));
  const barW = Math.max(1, Math.floor(slotW / 2));
  const barOffset = Math.max(0, Math.floor((slotW - barW) / 2));
  const totalW = slotW * n + gap * (n - 1);
  const first = buckets[0]!.start;
  const last = buckets[n - 1]!.start;

  // Whether filters are narrowing the view. When they aren't, the
  // tooltip collapses to a single "TOTAL" line — adding a separate
  // "visible" row that always matches the total reads as redundant.
  const isFiltered = stats.visibleTotal !== stats.total;

  const hoveredBucket = hoverIdx !== null ? buckets[hoverIdx] : null;
  const hoveredVisible = hoveredBucket ? visibleByStart.get(hoveredBucket.start) ?? 0 : 0;
  const isPeakHovered = hoverIdx !== null && hoverIdx === peakIndex;
  // Anchor the tooltip horizontally over the hovered bar's center.
  // Bar center = slot start + barOffset + barW/2. Using a percentage
  // keeps positioning resilient to the SVG's `preserveAspectRatio:
  // none` scaling.
  const tooltipLeftPct =
    hoverIdx !== null
      ? ((hoverIdx * (slotW + gap) + barOffset + barW / 2) / totalW) * 100
      : 0;

  return (
    <div
      className="lcars-sparkline"
      aria-label="weekly session volume"
      // Cap the flex width at the natural bar geometry — the SVG scales
      // down fluidly via viewBox below that, so tablet/mobile viewports
      // don't overflow (R9 F9.2).
      style={{ ['--sparkline-max-w' as string]: `${totalW}px` } as React.CSSProperties}
    >
      <div className="lcars-sparkline__readout" aria-label="timeline summary">
        <span className="lcars-sparkline__readout-item">
          <span className="lcars-sparkline__readout-label">TOTAL</span>
          <span className="lcars-sparkline__readout-value">
            {stats.total.toLocaleString()}
          </span>
        </span>
        {isFiltered && (
          <span className="lcars-sparkline__readout-item">
            <span className="lcars-sparkline__readout-label">VISIBLE</span>
            <span className="lcars-sparkline__readout-value">
              {stats.visibleTotal.toLocaleString()}
            </span>
          </span>
        )}
        <span className="lcars-sparkline__readout-item">
          <span className="lcars-sparkline__readout-label">PEAK</span>
          <span className="lcars-sparkline__readout-value">
            {stats.peak.toLocaleString()}
            {peakIndex >= 0 && (
              <span className="lcars-sparkline__readout-peak-date">
                {' · '}
                {formatShortDate(buckets[peakIndex]!.start)}
              </span>
            )}
          </span>
        </span>
        <span className="lcars-sparkline__readout-item">
          <span className="lcars-sparkline__readout-label">AVG/WK</span>
          <span className="lcars-sparkline__readout-value">
            {stats.avgPerWeek < 10
              ? stats.avgPerWeek.toFixed(1)
              : Math.round(stats.avgPerWeek).toLocaleString()}
          </span>
        </span>
        {presentSources.length > 0 && (
          // Always render the legend — even single-source timelines
          // benefit from seeing the color swatch so users can reason
          // about what the bars represent. Hiding the legend when only
          // one source exists creates a jarring "pop-in" the moment a
          // second source shows up.
          <span className="lcars-sparkline__legend" aria-label="source legend">
            {presentSources.map((src) => (
              <span key={src} className="lcars-sparkline__legend-item">
                <span
                  className="lcars-sparkline__legend-swatch"
                  style={{ background: SOURCE_COLOR[src] }}
                  aria-hidden="true"
                />
                {SOURCE_LABEL[src]}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="lcars-sparkline__chart" onMouseLeave={() => setHoverIdx(null)}>
        <svg
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${totalW} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-hidden="true"
        >
          {/* Dashed baseline at zero — lets the eye calibrate where bars
              would otherwise touch the axis invisibly. */}
          <line
            x1={0}
            y1={HEIGHT - 0.5}
            x2={totalW}
            y2={HEIGHT - 0.5}
            className="lcars-sparkline__baseline"
          />
          {buckets.map((b, i) => {
            const barH = Math.max(1, Math.round((b.total / max) * (HEIGHT - 4)));
            // Slot starts at i * (slotW + gap); the visible bar sits
            // `barOffset` into the slot, leaving gap-worth of breathing
            // room on each side.
            const x = i * (slotW + gap) + barOffset;
            const visibleCount = visibleByStart.get(b.start) ?? 0;
            const dim = visibleCount === 0;
            const isHovered = i === hoverIdx;
            const isPeak = i === peakIndex;
            // Stack per-source segments bottom-to-top. `yCursor` starts
            // at the chart floor and climbs; each source contributes a
            // segment proportional to its count in this bucket.
            let yCursor = HEIGHT;
            const segments: { src: SessionSource; y: number; height: number }[] = [];
            for (const src of SOURCE_ORDER) {
              const srcCount = b.bySource[src] ?? 0;
              if (srcCount === 0) continue;
              // Fractional height for this source; round the top edge so
              // the last segment lands exactly on the bar top.
              const seg = Math.max(1, Math.round((srcCount / b.total) * barH));
              const top = Math.max(yCursor - seg, HEIGHT - barH);
              segments.push({ src, y: top, height: yCursor - top });
              yCursor = top;
              if (yCursor <= HEIGHT - barH) break;
            }
            return (
              <g
                key={b.start}
                className={
                  'lcars-sparkline__bar-group' +
                  (dim ? ' lcars-sparkline__bar-group--dim' : '') +
                  (isHovered ? ' lcars-sparkline__bar-group--hover' : '') +
                  (isPeak ? ' lcars-sparkline__bar-group--peak' : '')
                }
                onMouseEnter={() => setHoverIdx(i)}
              >
                {segments.map((seg) => (
                  <rect
                    key={seg.src}
                    x={x}
                    y={seg.y}
                    width={barW}
                    height={seg.height}
                    className={`lcars-sparkline__bar lcars-sparkline__bar--${seg.src.replace(/[^a-z0-9]/g, '-')}`}
                    style={{ fill: SOURCE_COLOR[seg.src] }}
                  >
                    <title>
                      {`${formatWeekRange(b.start)} · ${b.total} total · ${visibleCount} visible${isPeak ? ' · peak' : ''}`}
                    </title>
                  </rect>
                ))}
                {/* Peak ring — thin sunflower outline on top of the stack
                    so the peak week is obvious pre-hover. */}
                {isPeak && (
                  <rect
                    x={x - 0.5}
                    y={HEIGHT - barH - 0.5}
                    width={barW + 1}
                    height={barH + 1}
                    className="lcars-sparkline__peak-ring"
                    fill="none"
                  />
                )}
              </g>
            );
          })}
          {/* Invisible hit-targets fill the whole slot (bar + its gap
              breathing room) so the hover tooltip tracks smoothly across
              the timeline even when bars themselves are narrow. */}
          {buckets.map((b, i) => {
            const x = i * (slotW + gap);
            return (
              <rect
                key={`hit-${b.start}`}
                x={x}
                y={0}
                width={slotW + gap}
                height={HEIGHT}
                className="lcars-sparkline__hit"
                onMouseEnter={() => setHoverIdx(i)}
              />
            );
          })}
        </svg>
        {hoverIdx !== null && hoveredBucket && (
          <div
            className="lcars-sparkline__tooltip"
            role="status"
            aria-live="polite"
            style={{
              left: `${tooltipLeftPct}%`,
            }}
          >
            <div className="lcars-sparkline__tooltip-head">
              {formatWeekRange(hoveredBucket.start)}
              {isPeakHovered && (
                <span className="lcars-sparkline__tooltip-peak">★ PEAK</span>
              )}
            </div>
            <div className="lcars-sparkline__tooltip-row">
              <span className="lcars-sparkline__tooltip-label">TOTAL</span>
              <span className="lcars-sparkline__tooltip-value">
                {hoveredBucket.total.toLocaleString()}
              </span>
            </div>
            {isFiltered && (
              <div className="lcars-sparkline__tooltip-row">
                <span className="lcars-sparkline__tooltip-label">VISIBLE</span>
                <span className="lcars-sparkline__tooltip-value">
                  {hoveredVisible.toLocaleString()}
                  {hoveredBucket.total > 0 && (
                    <span className="lcars-sparkline__tooltip-dim">
                      {' '}
                      ({Math.round((hoveredVisible / hoveredBucket.total) * 100)}%)
                    </span>
                  )}
                </span>
              </div>
            )}
            {/* Per-source breakdown when the week actually has multiple
                sources. Single-source weeks skip it — the TOTAL row
                already tells the whole story. */}
            {Object.keys(hoveredBucket.bySource).length > 1 && (
              <div className="lcars-sparkline__tooltip-breakdown">
                {SOURCE_ORDER.filter((s) => (hoveredBucket.bySource[s] ?? 0) > 0).map((src) => (
                  <div key={src} className="lcars-sparkline__tooltip-source">
                    <span
                      className="lcars-sparkline__legend-swatch"
                      style={{ background: SOURCE_COLOR[src] }}
                      aria-hidden="true"
                    />
                    <span className="lcars-sparkline__tooltip-source-label">
                      {SOURCE_LABEL[src]}
                    </span>
                    <span className="lcars-sparkline__tooltip-source-count">
                      {hoveredBucket.bySource[src]!.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="lcars-sparkline__axis">
        {monthTicks.length >= 2 ? (
          <div className="lcars-sparkline__axis-months">
            {monthTicks.map((t) => (
              <span
                key={`${t.bucketIndex}-${t.label}`}
                className="lcars-sparkline__axis-month"
                style={{
                  left: `${((t.bucketIndex * (slotW + gap)) / totalW) * 100}%`,
                }}
              >
                {t.label}
              </span>
            ))}
          </div>
        ) : (
          <>
            <span>{formatShortDate(first)}</span>
            <span>{formatShortDate(last)}</span>
          </>
        )}
      </div>
    </div>
  );
}
