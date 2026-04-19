import type { CSSProperties } from 'react';

export interface ElbowProps {
  /**
   * Which corner the elbow fills. LCARS elbows are curved sector fills used
   * to transition between the sidebar and the content header strip.
   */
  corner: 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right';
  color?: string;
  radius?: number;
  width?: number;
  height?: number;
}

/**
 * Purely decorative LCARS corner piece. Renders a block with an asymmetric
 * border-radius so the outer edge looks like a quarter-disk bulge.
 *
 * Kept as a distinct component so the main layout can compose without
 * duplicating the CSS math.
 */
export function Elbow({
  corner,
  color = 'var(--lcars-butterscotch)',
  radius = 40,
  width = 80,
  height = 40,
}: ElbowProps) {
  const radii: Record<ElbowProps['corner'], string> = {
    'top-left': `${radius}px 0 0 0`,
    'bottom-left': `0 0 0 ${radius}px`,
    'top-right': `0 ${radius}px 0 0`,
    'bottom-right': `0 0 ${radius}px 0`,
  };
  const style: CSSProperties = {
    width,
    height,
    background: color,
    borderRadius: radii[corner],
  };
  return <div className="lcars-elbow" style={style} aria-hidden="true" />;
}
