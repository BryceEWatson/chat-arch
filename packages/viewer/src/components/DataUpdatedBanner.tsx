/**
 * Stream J #9 — composite v2 live-reload safety banner.
 *
 * Dormant in this PR: there's no composite-outcomes.json v2 file on
 * disk yet (Phase 2 #13 ships later), so the host won't pass non-null
 * change signals. The banner is wired up so the surface is ready the
 * moment the v2 file lands — at that point the outcomesLoader
 * (Stream I) compares `compositeVersion` / `weightsVersion` /
 * mtime+ETag against the snapshot captured at mount and surfaces a
 * change here.
 *
 * Rendering rules:
 *   - When `change === null`, render nothing (dormant default).
 *   - When `change !== null`, render the banner with a refresh CTA.
 *
 * No causal copy — the banner says "data updated since you opened
 * this view", not "Claude refined the outcome model".
 */

export interface DataUpdatedChange {
  /** Reason the banner fired. Used in copy and `data-reason`. */
  reason:
    | 'composite-version-bump'
    | 'weights-version-bump'
    | 'mtime-changed'
    | 'etag-changed';
  /** Optional human-readable detail (e.g. "v1 → v2"). */
  detail?: string;
}

export interface DataUpdatedBannerProps {
  change: DataUpdatedChange | null;
  /** Click handler for the REFRESH button. Optional — when omitted,
   *  the banner still renders but the CTA is a no-op (callers can
   *  surface a manual-reload hint via copy instead). */
  onRefresh?: () => void;
  /** Click handler for the dismiss button. Hides the banner without
   *  refreshing. */
  onDismiss?: () => void;
}

const REASON_COPY: Record<DataUpdatedChange['reason'], string> = {
  'composite-version-bump':
    'The composite-outcome schema version changed since you opened this view.',
  'weights-version-bump':
    'The composite weights changed since you opened this view (a fresh calibration ran).',
  'mtime-changed':
    'composite-outcomes.json was rewritten on disk since you opened this view.',
  'etag-changed':
    'composite-outcomes.json ETag changed since you opened this view.',
};

export function DataUpdatedBanner({
  change,
  onRefresh,
  onDismiss,
}: DataUpdatedBannerProps) {
  if (change === null) return null;
  return (
    <div
      className="lcars-data-updated-banner"
      role="status"
      aria-live="polite"
      data-reason={change.reason}
    >
      <span className="lcars-data-updated-banner__tag">DATA UPDATED</span>
      <span className="lcars-data-updated-banner__message">
        {REASON_COPY[change.reason]}
        {change.detail !== undefined && (
          <>
            {' '}
            {/*
              Previously wrapped in <code>, which made SR users hear
              "code v1 right-arrow v2 end code". The detail is short
              status copy, not source code. Render as a plain span;
              also replace the arrow glyph with a sr-only " to " so
              the affordance still reads visually as "v1 → v2" while
              SR users hear "v1 to v2".
            */}
            <span className="lcars-data-updated-banner__detail">
              <span aria-hidden="true">{change.detail}</span>
              <span className="sr-only">{change.detail.replace(/→/g, ' to ')}</span>
            </span>
          </>
        )}{' '}
        Refresh to see the new values.
      </span>
      {onRefresh && (
        <button
          type="button"
          className="lcars-data-updated-banner__btn"
          onClick={onRefresh}
        >
          REFRESH
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="lcars-data-updated-banner__btn lcars-data-updated-banner__btn--ghost"
          onClick={onDismiss}
          aria-label="dismiss data-updated banner"
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </div>
  );
}
