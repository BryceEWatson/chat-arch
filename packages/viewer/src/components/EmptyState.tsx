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
}

export function EmptyState({
  title = 'NO SESSIONS',
  message = 'Run pnpm --filter @chat-arch/exporter start to produce a manifest.',
  onUpload,
  onLoadDemo,
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
            {...(onLoadDemo ? { onLoadDemo } : {})}
          />
        </>
      )}
    </section>
  );
}
