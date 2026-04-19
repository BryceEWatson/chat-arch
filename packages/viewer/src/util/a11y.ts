import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Uniform keyboard activation handler for `<div role="button" tabIndex={0}>`.
 *
 * Why this pattern (called out in plan decision 4): native `<button>` user-agent
 * styles override LCARS background colors in some browsers and a bug in the
 * v7 LCARS iteration forced us off `<button>`. So every interactive panel is
 * a `<div>` with `role="button"` + this helper on `onKeyDown` so Enter / Space
 * still activate.
 */
export function onActivate<T extends Element>(e: ReactKeyboardEvent<T>, cb: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    cb();
  }
}
