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
  message = 'Run pnpm --filter @chat-arch/exporter start to produce a manifest.',
  onUpload,
  onLoadDemo,
  showInstallLocally = false,
}: EmptyStateProps) {
  return (
    <section className="lcars-empty-state" role="status" aria-live="polite">
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
