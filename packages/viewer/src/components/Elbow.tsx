/**
 * LCARS chrome — v2 corner-chip geometry.
 *
 * Spec §10, AMENDED 2026-05-06 (see _planning/v2-decisions-amend.md):
 * the L renders as a TOP-CORNER CHIP only — horizontal stub + concave
 * quarter-arc inner radius + a short vertical tail terminating at the
 * chip's bottom edge. It does NOT continue down the sidebar's left
 * edge as a frame rail. Pills sit in a transparent sidebar column
 * anchored visually only by the chip at top.
 *
 * The single-SVG-element + concave-quarter-arc constraints from the
 * original §10 are preserved; only the path's previously-fixed-height
 * vertical extension is dropped.
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
   * Path height in px — the y-coordinate the chip's bottom edge sits
   * at. Default `120` makes the chip a self-contained corner: stub
   * (36) + arc transition (31) + a 53px tail = 120px tall. Override
   * for explicit dimensions (e.g. snapshot tests).
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

const DEFAULT_FILL_HEIGHT = 120;

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
  // path draws 1:1. The SVG element sizes itself to (W × H) — a finite
  // 56×120 default — and renders inline at the top of the sidebar; the
  // amended spec §10 no longer asks for a full-height vertical leg.
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
