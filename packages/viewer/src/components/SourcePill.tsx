import type { SessionSource } from '@chat-arch/schema';
import { SOURCE_BADGE, SOURCE_COLOR, SOURCE_LABEL, SOURCE_TOOLTIP } from '../types.js';
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
  const tooltip = SOURCE_TOOLTIP[source];
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
    // Drop the aria-label from the readonly span — the inner __label text
    // already renders SOURCE_LABEL[source] visibly, so AT users get it via
    // the regular text-content path. aria-label on a bare span without
    // role is widely dropped by AT anyway.
    return (
      <span className={className} style={style} title={tooltip}>
        <span className="lcars-source-pill__badge" aria-hidden="true">
          {badge}
        </span>
        <span className="lcars-source-pill__label">{label}</span>
      </span>
    );
  }

  return (
    // aria-label is just `source ${label}` (no "toggle" verb) — aria-pressed
    // already encodes the toggle state, and SR readers commonly stutter
    // "toggle source CLOUD toggle button" when the verb collides with the
    // pressed-state semantic. Matches the readonly name shape too.
    <div
      className={className}
      style={style}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={`source ${label} — ${tooltip}`}
      title={tooltip}
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
