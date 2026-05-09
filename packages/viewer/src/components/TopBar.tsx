import type { ViewportTier } from '../util/viewport.js';
import { InfoPopover } from './InfoPopover.js';
import { LastIndexedChip } from './LastIndexedChip.js';

export type RescanStatus = 'idle' | 'running' | 'error' | 'ok';
export type UploadStatus = 'idle' | 'running' | 'error' | 'ok';

/**
 * v2 spec §6 / decision D4: TopBar is informational chrome only.
 * Hosts (in order, left → right):
 *
 *   - Sunflower title chip (CHAT ARCHAEOLOGIST + design-system InfoPopover)
 *   - Tier indicator slot (TierIndicator — single chip; an earlier
 *     EXTENDED-COMING-SOON sibling was dropped in v2-visual-polish)
 *   - Location chip (current surface label, e.g. PROJECTS / SESSIONS)
 *   - EARTHDATE chip (today's date, value-only — the prefix label
 *     was dropped in v2-visual-polish to keep the row from wrapping
 *     at ~1280px desktop)
 *   - Search input (right-aligned)
 *
 * NO action buttons. UPLOAD CLOUD / SCAN LOCAL / DELETE actions live in
 * the DATA sidebar panel (see DataPanel.tsx). Status types are still
 * exported here because the host viewer wires the same status state
 * through the panel.
 */
export interface TopBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  /** Tier indicator chip (and any siblings) — rendered between title and location. */
  tierIndicator?: React.ReactNode;
  /** Current surface label for the location chip (e.g. "PROJECTS", "SESSIONS"). */
  locationLabel?: string;
  /** Override for the EARTHDATE chip text — defaults to today in YYYY.MM.DD form. */
  earthdate?: string;
  /** Viewport tier; changes placeholder + label density on narrower screens. */
  tier?: ViewportTier;
  /**
   * When true the search input is disabled and shows muted styling. Used
   * while the detail overlay is open so typing can't silently mutate the
   * underlying list the user returns to.
   */
  disabled?: boolean;
  /**
   * Rescan-delta breakdown chip. Persists between rescans (no auto-
   * dismiss timer) so a user who walks away can see how many new
   * sessions the latest scan picked up. Omit to hide the chip.
   */
  rescanDelta?: {
    totalLocal: number;
    cowork: number;
    cli: number;
    desktop: number;
  };
  /** Click handler for the chip's ✕ dismiss button. */
  onDismissRescanDelta?: () => void;
  /**
   * Phase 2a: ms-since-epoch from `manifest.generatedAt`. Drives the
   * INDEXED chip — null hides it. Optional so embeddings without a
   * manifest still render the bar.
   */
  lastIndexed?: number | null;
}

function defaultEarthdate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}

function formatDelta(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return '0';
}

export function TopBar({
  query,
  onQueryChange,
  tierIndicator,
  locationLabel,
  earthdate,
  tier = 'desktop',
  disabled = false,
  rescanDelta,
  onDismissRescanDelta,
  lastIndexed,
}: TopBarProps) {
  const placeholder = disabled
    ? 'exit detail view to search'
    : tier === 'desktop'
      ? 'search title / summary / preview'
      : tier === 'tablet'
        ? 'SEARCH…'
        : 'SEARCH SESSIONS…';

  const dateText = earthdate ?? defaultEarthdate();

  return (
    <header className="lcars-top-bar" role="banner">
      <div className="lcars-top-bar__left">
        <span className="lcars-top-bar__dot" aria-hidden="true" />
        <h1 className="lcars-top-bar__title">CHAT ARCHAEOLOGIST</h1>
        <InfoPopover
          ariaLabel="about the Supergraphic Panel design system"
          className="lcars-top-bar__title-info"
        >
          <strong>Supergraphic Panel</strong>
          <p>
            This UI uses the Supergraphic Panel design system — published with its source, DTCG
            tokens, and an LLM-consumable specification.
          </p>
          <p>
            <a href="/design-system/">View the walkthrough →</a>
          </p>
        </InfoPopover>
        {tierIndicator && <div className="lcars-top-bar__tier-slot">{tierIndicator}</div>}
        {locationLabel && (
          <div
            className="lcars-top-bar__location"
            aria-label={`current surface: ${locationLabel}`}
          >
            <span className="lcars-top-bar__location-prefix" aria-hidden="true">
              ▸
            </span>
            <span className="lcars-top-bar__location-label">{locationLabel}</span>
          </div>
        )}
        <div className="lcars-top-bar__earthdate" aria-label={`earthdate ${dateText}`}>
          <span className="lcars-top-bar__earthdate-value">{dateText}</span>
        </div>
        <LastIndexedChip generatedAt={lastIndexed ?? null} />
        {rescanDelta && (
          <div
            className="lcars-top-bar__rescan-chip"
            aria-label={`last rescan added ${formatDelta(rescanDelta.totalLocal)} local sessions`}
            title={`+${rescanDelta.cowork} cowork · +${rescanDelta.cli} CLI · +${rescanDelta.desktop} desktop`}
          >
            <span className="lcars-top-bar__rescan-chip-label">RESCAN</span>
            <span className="lcars-top-bar__rescan-chip-value">
              {formatDelta(rescanDelta.totalLocal)}
            </span>
            {onDismissRescanDelta && (
              <button
                type="button"
                className="lcars-top-bar__rescan-chip-dismiss"
                aria-label="dismiss rescan delta"
                onClick={onDismissRescanDelta}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>
      <div className="lcars-top-bar__right">
        <label
          className={`lcars-top-bar__search${disabled ? ' lcars-top-bar__search--disabled' : ''}`}
        >
          <span className="lcars-top-bar__search-label" aria-hidden="true">
            SEARCH
          </span>
          <input
            className="lcars-top-bar__search-input"
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            aria-label="search sessions"
            aria-disabled={disabled || undefined}
          />
        </label>
      </div>
    </header>
  );
}
