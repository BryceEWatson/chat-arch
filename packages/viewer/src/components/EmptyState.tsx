import type { UploadedCloudData } from '../types.js';
import { UploadPanel } from './UploadPanel.js';

export interface EmptyStateProps {
  title?: string;
  message?: string;
  /**
   * When provided, a prominent upload CTA is rendered alongside the
   * "run the exporter" hint. Used at the top-level empty manifest state.
   */
  onUpload?: (data: UploadedCloudData) => void;
  /**
   * When provided, the UploadPanel also renders a "Load Demo Data"
   * secondary button that populates the viewer with an in-browser
   * fixture. Only wired in the top-level empty states — drill-in
   * empties (e.g., "NO SELECTION") don't need it.
   */
  onLoadDemo?: () => void;
  /**
   * Hosted-build affordance — when `true`, the UploadPanel surfaces an
   * INSTALL LOCALLY link as the primary action and demotes CHOOSE ZIP
   * to a secondary outlined button. Defaults to `false` (CHOOSE ZIP
   * primary, no install link). The host passes `!rescanLikelyLocal`.
   */
  showInstallLocally?: boolean;
}

export function EmptyState({
  title = 'NO SESSIONS',
  message = 'No sessions to display yet. Run SCAN LOCAL to ingest local transcripts, or upload an export ZIP below.',
  onUpload,
  onLoadDemo,
  showInstallLocally = false,
}: EmptyStateProps) {
  return (
    // Dropped role="status" + aria-live="polite": this section wraps a
    // <h2> + UploadPanel (which has its own live region) + button group —
    // far larger than a "status message". Polite live re-announcement on
    // every mount forced SR to re-read the whole interactive panel. The
    // <h2> already serves as a heading-nav landmark; no live broadcast
    // needed.
    <section className="lcars-empty-state">
      <h2 className="lcars-empty-state__title">{title}</h2>
      <p className="lcars-empty-state__message">{message}</p>
      {onUpload && (
        <>
          <p className="lcars-empty-state__message lcars-empty-state__or">— OR —</p>
          <UploadPanel
            onLoaded={onUpload}
            variant="prominent"
            showInstallLocally={showInstallLocally}
            {...(onLoadDemo ? { onLoadDemo } : {})}
          />
        </>
      )}
    </section>
  );
}
