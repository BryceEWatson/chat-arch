import { useEffect, useState } from 'react';

/**
 * Viewport tier — three LCARS layout modes.
 *
 * - `desktop` (≥ 900px): full double-elbow chrome, 160px sidebar.
 * - `tablet`  (600–899px): collapsed 56px icon-strip sidebar, double-elbow kept.
 * - `mobile`  (< 600px): stacked layout, horizontal pill bar, no double elbow.
 *
 * Below 320px the consumer may show a graceful fallback banner, but Tier C
 * is expected to hold up on any reasonable modern browser viewport.
 */
export type ViewportTier = 'mobile' | 'tablet' | 'desktop';

export const VIEWPORT_BREAKPOINTS = {
  tablet: 600,
  desktop: 900,
} as const;

export function tierForWidth(width: number): ViewportTier {
  if (width >= VIEWPORT_BREAKPOINTS.desktop) return 'desktop';
  if (width >= VIEWPORT_BREAKPOINTS.tablet) return 'tablet';
  return 'mobile';
}

/**
 * Returns the current viewport tier, updating on `resize`. SSR-safe:
 * returns `'desktop'` when `window` is undefined so the server HTML matches
 * what most visitors see. Consumers that need SSR-client parity can pass
 * `initialTier` to override the default.
 */
export function useViewportTier(initialTier: ViewportTier = 'desktop'): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(() => {
    if (typeof window === 'undefined') return initialTier;
    return tierForWidth(window.innerWidth);
  });

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setTier(tierForWidth(window.innerWidth));
    window.addEventListener('resize', onResize);
    // Run once in case the initial state was stale (e.g. SSR → hydration).
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return tier;
}
