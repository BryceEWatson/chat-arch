import { useState } from 'react';
import { onActivate } from '../util/a11y.js';
import { TierSheet } from './TierSheet.js';
import type { TierFileState } from '../data/analysisFetch.js';

/**
 * TopBar tier indicator pill.
 *
 * Two states, both at full opacity (dim is the palette, never the state):
 *   - `CORE ANALYSIS` — `#665544` (dim brown). First tier. Runs entirely
 *     in the browser against the manifest: search, filters, sparklines,
 *     exact-duplicate clusters, zombie heuristics.
 *   - `CORE + EXTENDED ANALYSIS (N/6)` — `#CC99CC` (violet). Second tier
 *     is populated by a local analyzer pass (Phase 7, not yet shipped);
 *     `N/6` is how many of the reserved outputs exist on disk.
 *
 * The word `ANALYSIS` is load-bearing: without it, a bare `CORE` reads
 * as a header label, not as a tier indicator. Keep it.
 *
 * The `N/6` count renders ONLY when any tier-2 file is present. In the
 * CORE-only state the pill is deliberately clean — no `(0/6)` — so it
 * reads as "state" not as a progress meter.
 *
 * Clicking opens `TierSheet` — one source of truth for per-file
 * present/absent state.
 *
 * v2-visual-polish: the `EXTENDED · COMING SOON` sibling chip was
 * dropped — at desktop widths the redundant pair pushed the TopBar
 * onto two rows, and the TierSheet (opened from the CORE chip)
 * already explains the not-yet-shipped tier-2 outputs.
 */

export interface TierIndicatorProps {
  tierStatus: 'browser' | 'browser+local';
  tierPresentCount: number;
  tierFiles: Record<string, TierFileState>;
}

export function TierIndicator({ tierStatus, tierPresentCount, tierFiles }: TierIndicatorProps) {
  const [open, setOpen] = useState(false);

  const label =
    tierStatus === 'browser' ? 'CORE ANALYSIS' : `CORE + EXTENDED ANALYSIS (${tierPresentCount}/6)`;

  const className =
    'lcars-tier-indicator ' +
    (tierStatus === 'browser' ? 'lcars-tier-indicator--browser' : 'lcars-tier-indicator--local');

  return (
    <>
      <div
        className={className}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`analysis tier: ${label}. Click to open details.`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => onActivate(e, () => setOpen(true))}
      >
        {label}
      </div>
      {open ? (
        <TierSheet
          tierStatus={tierStatus}
          tierPresentCount={tierPresentCount}
          tierFiles={tierFiles}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
