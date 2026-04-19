export interface MidBarProps {
  color: string;
  label?: string;
}

/**
 * The 24px-tall horizontal band under the UpperPanel. Its color tracks the
 * active mode so the eye can see which mode is highlighted at a glance.
 */
export function MidBar({ color, label }: MidBarProps) {
  return (
    <div
      className="lcars-mid-bar"
      style={{ background: color }}
      role="presentation"
      aria-hidden="true"
    >
      {label && <span className="lcars-mid-bar__label">{label}</span>}
    </div>
  );
}
