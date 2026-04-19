import { useMemo } from 'react';
import type { UnifiedSessionEntry, SessionSource } from '@chat-arch/schema';
import { SOURCE_COLOR, SOURCE_LABEL } from '../../types.js';
import { TimelineDot } from '../TimelineDot.js';
import { EmptyState } from '../EmptyState.js';
import { formatShortDate, minTimestamp, maxTimestamp } from '../../util/time.js';

export interface TimelineModeProps {
  sessions: readonly UnifiedSessionEntry[];
  onSelect: (id: string) => void;
}

const LANES: readonly SessionSource[] = ['cloud', 'cowork', 'cli-direct', 'cli-desktop'];
const LANE_HEIGHT = 80;
const LANE_GAP = 8;
const DOT_SIZE = 10;

export function TimelineMode({ sessions, onSelect }: TimelineModeProps) {
  const { minTs, maxTs, rangeMs, lanes } = useMemo(() => {
    const mn = minTimestamp(sessions.map((s) => s.updatedAt)) ?? 0;
    const mx = maxTimestamp(sessions.map((s) => s.updatedAt)) ?? 0;
    const r = Math.max(1, mx - mn);
    const bySource = new Map<SessionSource, UnifiedSessionEntry[]>();
    for (const l of LANES) bySource.set(l, []);
    for (const s of sessions) bySource.get(s.source)!.push(s);
    return { minTs: mn, maxTs: mx, rangeMs: r, lanes: bySource };
  }, [sessions]);

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="NO EVENTS"
        message="Nothing to plot on the timeline. Clear filters to see all activity."
      />
    );
  }

  return (
    <div className="lcars-timeline-mode">
      <div className="lcars-timeline-mode__axis">
        <span>{formatShortDate(minTs)}</span>
        <span>{formatShortDate(maxTs)}</span>
      </div>
      <div
        className="lcars-timeline-mode__lanes"
        style={{ height: `${LANES.length * (LANE_HEIGHT + LANE_GAP)}px` }}
      >
        {LANES.map((src, i) => {
          const laneTop = i * (LANE_HEIGHT + LANE_GAP);
          const laneBand = LANE_HEIGHT;
          const entries = lanes.get(src) ?? [];
          const color = SOURCE_COLOR[src];
          return (
            <div
              key={src}
              className="lcars-timeline-mode__lane"
              style={
                {
                  top: `${laneTop}px`,
                  height: `${laneBand}px`,
                  ['--source-color' as string]: color,
                } as React.CSSProperties
              }
            >
              <div className="lcars-timeline-mode__lane-label" aria-label={SOURCE_LABEL[src]}>
                {SOURCE_LABEL[src]}
              </div>
              <div className="lcars-timeline-mode__lane-track">
                {entries.map((s) => {
                  const xPct = ((s.updatedAt - minTs) / rangeMs) * 100;
                  const y = laneBand / 2 - DOT_SIZE / 2;
                  return (
                    <TimelineDot
                      key={`${s.source}:${s.id}`}
                      session={s}
                      xPercent={xPct}
                      yPx={y}
                      onSelect={onSelect}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
