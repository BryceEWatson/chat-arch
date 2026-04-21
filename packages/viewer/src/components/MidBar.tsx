export interface MidBarProps {
  color: string;
  label?: string;
  /**
   * Optional right-aligned slot. Used for the SORT dropdown on COMMAND
   * mode; other modes don't surface a sort control here. Rendered
   * inside the bar so its typography inherits the black-on-color
   * aesthetic — treat it as chrome, not a floating overlay.
   */
  rightSlot?: React.ReactNode;
}

/**
 * The 24px-tall horizontal band under the UpperPanel. Its color tracks the
 * active mode so the eye can see which mode is highlighted at a glance.
 *
 * When `rightSlot` is provided the bar flexes into a two-column layout:
 * mode label on the left, slot on the right. Without a slot the bar
 * keeps its original single-label appearance.
 */
export function MidBar({ color, label, rightSlot }: MidBarProps) {
  return (
    <div className="lcars-mid-bar" style={{ background: color }} role="presentation">
      {label && <span className="lcars-mid-bar__label">{label}</span>}
      {rightSlot}
    </div>
  );
}
