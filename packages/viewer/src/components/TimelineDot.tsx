import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { SOURCE_COLOR } from '../types.js';
import { onActivate } from '../util/a11y.js';
import { formatShortDate } from '../util/time.js';

export interface TimelineDotProps {
  session: UnifiedSessionEntry;
  /** Left position (%), 0..100 */
  xPercent: number;
  /** Top (px) within the lane band */
  yPx: number;
  onSelect: (id: string) => void;
}

export function TimelineDot({ session, xPercent, yPx, onSelect }: TimelineDotProps) {
  const color = SOURCE_COLOR[session.source];
  const label = `${session.title} · ${formatShortDate(session.updatedAt)}`;
  return (
    <div
      className="lcars-timeline-dot"
      style={
        {
          left: `${xPercent}%`,
          top: `${yPx}px`,
          ['--source-color' as string]: color,
        } as React.CSSProperties
      }
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => onActivate(e, () => onSelect(session.id))}
    />
  );
}
