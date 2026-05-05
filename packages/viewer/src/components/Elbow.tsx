/**
 * LCARS chrome — v2 single-L geometry.
 *
 * Spec §10 / decision: the v1 chrome was two rectangles butted at a square
 * inner corner (top elbow + bottom elbow as separate elements). v2 replaces
 * that with a single L-shape rendered as one SVG element with a quarter-
 * circle CONCAVE inner radius. Only the left edge of the layout carries
 * frame chrome — no top arm spanning the whole header, no four-sided box.
 *
 * The L sits along the left edge of the sidebar:
 *   - short horizontal stub at the top
 *   - vertical bar dropping down the left, full sidebar height
 *   - the inner corner where they meet rounds inward via SVG quarter-arc
 *
 * Rendered as a single inline SVG. The vertical bar's path uses a large
 * fixed coordinate (DEFAULT_FILL_HEIGHT) and the SVG's intrinsic clipping
 * handles overflow against the parent's `height: 100%`, so the L visually
 * extends to the bottom of the sidebar without re-measuring on resize.
 */

import type { CSSProperties } from 'react';

export interface ElbowProps {
  /** Override fill color. Defaults to the palette's butterscotch accent. */
  color?: string;
  /** Quarter-arc radius in px. Default 36. */
  radius?: number;
  /** Total chrome width in px (vertical bar + stub). Default 56. */
  width?: number;
  /**
   * Path height in px — the y-coordinate the vertical leg extends to.
   * Defaults to a tall fixed value so the leg appears full-height when
   * the SVG is sized via CSS to fill its parent. Override only when
   * explicit dimensions are needed (e.g. snapshot tests).
   */
  height?: number;
  /** Width of the vertical bar, must be < `width`. Default 24. */
  barWidth?: number;
  /** Height of the top horizontal stub, must be < `height`. Default 36. */
  stubHeight?: number;
  /** Optional className override (defaults to `lcars-l-frame`). */
  className?: string;
  /** Optional inline style passthrough. */
  style?: CSSProperties;
}

const DEFAULT_FILL_HEIGHT = 4000;

export function Elbow({
  color = 'var(--lcars-butterscotch)',
  radius = 36,
  width = 56,
  height = DEFAULT_FILL_HEIGHT,
  barWidth = 24,
  stubHeight = 36,
  className = 'lcars-l-frame',
  style,
}: ElbowProps) {
  // Clamp the radius so the arc fits inside the L's inner cavity.
  const r = Math.max(0, Math.min(radius, width - barWidth - 1, height - stubHeight - 1));

  // Single closed path describing the L with a concave quarter-arc on the
  // inner corner. Walks clockwise from the top-left.
  //
  //   (0,0) ───────── (W,0)
  //     │                │
  //     │              (W, S)
  //     │             /
  //     │     ╭──────╯  (arc: from (B+R, S) down-and-left to (B, S+R))
  //     │     │           sweep flag 1 = CW = bulges INWARD (concave)
  //     │   (B, H)
  //     │     │
  //   (0,H) ──┘
  //
  // W = width, H = height, B = barWidth, S = stubHeight, R = arc radius.
  const W = width;
  const H = height;
  const B = barWidth;
  const S = stubHeight;
  const d =
    `M 0 0 ` +
    `L ${W} 0 ` +
    `L ${W} ${S} ` +
    `L ${B + r} ${S} ` +
    `A ${r} ${r} 0 0 1 ${B} ${S + r} ` +
    `L ${B} ${H} ` +
    `L 0 ${H} ` +
    `Z`;

  // Intentionally NO viewBox — the SVG uses raw pixel coordinates so the
  // path draws 1:1 regardless of the rendered SVG box. CSS sizes the
  // outer SVG (width: 56px, height: 100%); the SVG's intrinsic clipping
  // handles overflow. This avoids viewBox-induced scaling/distortion of
  // the corner arc that would otherwise appear when the parent height
  // doesn't match the path height.
  return (
    <svg
      className={className}
      width={W}
      height={H}
      role="presentation"
      aria-hidden="true"
      style={style}
    >
      <path d={d} fill={color} />
    </svg>
  );
}
