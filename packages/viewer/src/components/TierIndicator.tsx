import { useState } from 'react';
import { onActivate } from '../util/a11y.js';
import { TierSheet } from './TierSheet.js';
import type { TierFileState } from '../data/analysisFetch.js';

/**
 * TopBar tier indicator pill (Decision 17, `[R-D17]`, AC14, AC15).
 *
 * Two states, both at full opacity (dim is the palette, never the state):
 *   - `BROWSER ANALYSIS` — `#665544` (dim brown)
 *   - `BROWSER + LOCAL ANALYSIS (N/6)` — `#CC99CC` (violet)
 *
 * The word `ANALYSIS` is load-bearing per `[R-D17]` and §4.4.1 of the
 * review: without it, a cold user parses bare `BROWSER` as "I'm in a
 * browser, of course" (chrome label), not as "there's another tier I
 * could unlock" (state label). Do NOT shorten to `BROWSER` or pivot
 * to an icon.
 *
 * The `N/6` count renders ONLY when any tier-2 file is present. In the
 * BROWSER-only state the pill is deliberately clean — no `(0/6)`,
 * because the review's §4.4.1 warning includes making sure the pill
 * reads as an invitation, not as a progress meter.
 *
 * Clicking opens `TierSheet` — one source of truth for per-file
 * present/absent state.
 */

export interface TierIndicatorProps {
  tierStatus: 'browser' | 'browser+local';
  tierPresentCount: number;
  tierFiles: Record<string, TierFileState>;
}

export function TierIndicator({ tierStatus, tierPresentCount, tierFiles }: TierIndicatorProps) {
  const [open, setOpen] = useState(false);

  const label =
    tierStatus === 'browser'
      ? 'BROWSER ANALYSIS'
      : `BROWSER + LOCAL ANALYSIS (${tierPresentCount}/6)`;

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
      {tierStatus === 'browser' && (
        // Sibling chip advertising the not-yet-shipped local-analyzer tier.
        // Rendered as a button for discoverability (click opens the same
        // TierSheet that explains what the 6 reserved files will do), but
        // aria-disabled so assistive tech announces it as inactive.
        <div
          className="lcars-tier-indicator lcars-tier-indicator--pending"
          role="button"
          tabIndex={0}
          aria-haspopup="dialog"
          aria-disabled="true"
          aria-label="Extended analysis — coming soon. Click to see what's planned."
          onClick={() => setOpen(true)}
          onKeyDown={(e) => onActivate(e, () => setOpen(true))}
        >
          EXTENDED · COMING SOON
        </div>
      )}
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
