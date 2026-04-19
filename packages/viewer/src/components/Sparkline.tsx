import { useMemo } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { bucketByWeek } from '../data/search.js';
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

export function Sparkline({ allSessions, visibleSessions, width = 480 }: SparklineProps) {
  const { buckets, visibleByStart, max } = useMemo(() => {
    const b = bucketByWeek(allSessions);
    const v = new Map<number, number>();
    for (const s of bucketByWeek(visibleSessions)) v.set(s.start, s.count);
    let m = 0;
    for (const bk of b) if (bk.count > m) m = bk.count;
    return { buckets: b, visibleByStart: v, max: m };
  }, [allSessions, visibleSessions]);

  if (buckets.length === 0 || max === 0) {
    return (
      <div className="lcars-sparkline lcars-sparkline--empty" aria-label="no activity">
        NO ACTIVITY
      </div>
    );
  }

  // Bar width + gap. Keep integer math for crispness.
  const n = buckets.length;
  const gap = 2;
  const barW = Math.max(2, Math.floor((width - gap * (n - 1)) / n));
  const totalW = barW * n + gap * (n - 1);
  const first = buckets[0]!.start;
  const last = buckets[n - 1]!.start;

  return (
    <div
      className="lcars-sparkline"
      aria-label="weekly session volume"
      // Cap the flex width at the natural bar geometry — the SVG scales
      // down fluidly via viewBox below that, so tablet/mobile viewports
      // don't overflow (R9 F9.2).
      style={{ ['--sparkline-max-w' as string]: `${totalW}px` } as React.CSSProperties}
    >
      <svg
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${totalW} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-hidden="true"
      >
        {buckets.map((b, i) => {
          const h = Math.max(1, Math.round((b.count / max) * (HEIGHT - 4)));
          const x = i * (barW + gap);
          const y = HEIGHT - h;
          const visibleCount = visibleByStart.get(b.start) ?? 0;
          const dim = visibleCount === 0;
          return (
            <rect
              key={b.start}
              x={x}
              y={y}
              width={barW}
              height={h}
              className={`lcars-sparkline__bar${dim ? ' lcars-sparkline__bar--dim' : ''}`}
            >
              <title>{`${formatShortDate(b.start)} · ${b.count} total · ${visibleCount} visible`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="lcars-sparkline__axis">
        <span>{formatShortDate(first)}</span>
        <span>{formatShortDate(last)}</span>
      </div>
    </div>
  );
}
