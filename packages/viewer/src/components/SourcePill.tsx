import type { SessionSource } from '@chat-arch/schema';
import { SOURCE_BADGE, SOURCE_COLOR, SOURCE_LABEL } from '../types.js';
import { onActivate } from '../util/a11y.js';

export interface SourcePillProps {
  source: SessionSource;
  count?: number;
  active: boolean;
  onToggle?: () => void;
  /** Read-only variant (e.g. on a SessionCard) — no click handler, no aria-pressed. */
  readonly?: boolean;
}

export function SourcePill({ source, count, active, onToggle, readonly }: SourcePillProps) {
  const color = SOURCE_COLOR[source];
  const label = SOURCE_LABEL[source];
  const badge = SOURCE_BADGE[source];
  const className = [
    'lcars-source-pill',
    active ? 'lcars-source-pill--active' : '',
    readonly ? 'lcars-source-pill--readonly' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style = {
    // The active state fills with the source color; inactive = outline.
    // Both variants keep the single-letter badge visible for color-independence.
    ['--source-color' as string]: color,
  } as React.CSSProperties;

  if (readonly) {
    return (
      <span className={className} style={style} aria-label={`source ${label}`}>
        <span className="lcars-source-pill__badge" aria-hidden="true">
          {badge}
        </span>
        <span className="lcars-source-pill__label">{label}</span>
      </span>
    );
  }

  return (
    <div
      className={className}
      style={style}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`toggle source ${label}`}
      onClick={onToggle}
      onKeyDown={(e) => onActivate(e, () => onToggle?.())}
    >
      <span className="lcars-source-pill__badge" aria-hidden="true">
        {badge}
      </span>
      <span className="lcars-source-pill__label">{label}</span>
      {typeof count === 'number' && <span className="lcars-source-pill__count">{count}</span>}
    </div>
  );
}
