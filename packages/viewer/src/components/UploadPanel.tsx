import { useRef, useState } from 'react';
import { parseCloudZip } from '../data/zipUpload.js';
import { maskedUploadLabel } from '../data/uploadLabel.js';
import type { RescanProgress, RescanStatus } from '../data/rescan.js';
import type { UploadedCloudData } from '../types.js';

export interface UploadPanelProps {
  onLoaded: (data: UploadedCloudData) => void;
  /** Optional compact variant — omits the headline copy. */
  variant?: 'prominent' | 'compact';
  /**
   * Optional "Load Demo Data" affordance. When provided, renders a
   * secondary button that populates the viewer with a generated
   * fixture so users can explore the UI without needing their own
   * export. The host wires this up to `generateDemoUpload()` +
   * `onUpload`.
   */
  onLoadDemo?: () => void;
  /**
   * Optional SCAN LOCAL affordance for the empty-state landing. The
   * canonical home for SCAN LOCAL is DataPanel, but DataPanel is only
   * reachable from the populated view (via the sidebar's DATA pill).
   * On the empty-state landing the sidebar isn't rendered, so a user
   * with only local Claude data would otherwise be stuck. Wiring this
   * prop surfaces the same `useRescan()` action inline. The hosted web
   * build can't spawn the scanner, so the host gates with `scanAvailable`.
   */
  onScanLocal?: () => void;
  scanAvailable?: boolean;
  scanStatus?: RescanStatus;
  scanProgress?: RescanProgress;
  /**
   * Hosted-build affordance — when `true`, render an INSTALL LOCALLY
   * link as the primary action and demote CHOOSE ZIP to a secondary
   * outlined button. Cloud-only visitors can still load their ZIP
   * (it's a fully in-browser parse), but the headline pitch is the
   * workshop loop which requires a local install.
   *
   * Defaults to `false`: in local-dev `pnpm dev` the workshop is
   * already reachable via SCAN LOCAL, so the install link is noise.
   */
  showInstallLocally?: boolean;
  /**
   * Optional override for the INSTALL LOCALLY link target. Defaults to
   * the README quickstart anchor on GitHub. Tests may pin this to a
   * fixture URL.
   */
  installLocallyHref?: string;
}

const DEFAULT_INSTALL_LOCALLY_HREF =
  'https://github.com/BryceEWatson/chat-arch#quickstart';

/**
 * `label` is the MASKED filename (see `maskedUploadLabel`) — never the
 * raw `file.name`. claude.ai Privacy Exports embed the user's email in
 * the default filename, and this panel renders the `parsing` and
 * `success` states into the DOM where they're visible + screenshot-able.
 * Storing the mask — rather than re-deriving it on every render — also
 * guarantees a regression from the mask helper is reflected at the
 * single point of persistence.
 */
type UploadState =
  | { status: 'idle' }
  | { status: 'parsing'; label: string }
  | { status: 'error'; message: string }
  | { status: 'success'; count: number; label: string };

/**
 * CTA panel shown inside EmptyState. Accepts a .zip file via native file input,
 * parses it in the browser via `parseCloudZip`, and calls `onLoaded` with the
 * resulting in-memory manifest. LCARS-styled, mobile-responsive.
 */
export function UploadPanel({
  onLoaded,
  variant = 'prominent',
  onLoadDemo,
  onScanLocal,
  scanAvailable,
  scanStatus = 'idle',
  scanProgress,
  showInstallLocally = false,
  installLocallyHref = DEFAULT_INSTALL_LOCALLY_HREF,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UploadState>({ status: 'idle' });

  const scanRunning = scanStatus === 'running';
  const scanShown = !!onScanLocal && scanAvailable === true;
  const scanLabel = (() => {
    if (scanStatus === 'running') {
      const phase = scanProgress?.phase;
      const ix = scanProgress?.ix ?? 0;
      const total = scanProgress?.total ?? 0;
      if (phase && ix > 0 && total > 0) return `SCANNING · ${phase.toUpperCase()} ${ix}/${total}`;
      if (phase) return `SCANNING · ${phase.toUpperCase()}`;
      return 'SCANNING…';
    }
    if (scanStatus === 'error') return 'SCAN FAILED';
    if (scanStatus === 'ok') return 'SCANNED ✓';
    return 'SCAN LOCAL';
  })();
  const scanCaption = scanRunning ? (scanProgress?.latest ?? null) : null;

  const openPicker = () => {
    if (state.status === 'parsing') return;
    inputRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Always reset the input so selecting the same file twice re-fires.
    e.target.value = '';
    if (!file) return;

    // Capture the masked label ONCE at the entry point — after this,
    // the raw `file.name` does not enter React state or the DOM.
    const label = maskedUploadLabel(file);
    setState({ status: 'parsing', label });
    try {
      const data = await parseCloudZip(file);
      setState({
        status: 'success',
        count: data.manifest.sessions.length,
        label,
      });
      onLoaded(data);
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <section
      className={`lcars-upload-panel lcars-upload-panel--${variant}`}
      aria-label="upload cloud export"
    >
      {variant === 'prominent' && !showInstallLocally && (
        <>
          <h3 className="lcars-upload-panel__title">LOAD CLOUD EXPORT</h3>
          <p className="lcars-upload-panel__hint">
            Drop a Settings → Privacy → Export data ZIP from claude.ai to browse your conversations
            without running the CLI.
          </p>
        </>
      )}
      {variant === 'prominent' && showInstallLocally && (
        <>
          {/*
            Hosted-build framing: chat-arch.dev demonstrates the UI on
            sample data; the workshop loop (mine → patch CLAUDE.md →
            re-mine) runs locally because it touches your CLAUDE.md
            files. CHOOSE ZIP remains as a secondary path so cloud-only
            users can still browse their archive without installing.
          */}
          <h3 className="lcars-upload-panel__title">INSTALL CHAT-ARCH LOCALLY</h3>
          <p className="lcars-upload-panel__hint">
            The workshop loop runs against your local Claude Code transcripts. Install chat-arch on
            your machine to audit your own corpus and patch your CLAUDE.md — or use CHOOSE ZIP
            below to browse a claude.ai export in your browser.
          </p>
        </>
      )}

      <div className="lcars-upload-panel__buttons">
        {/*
          Primary-action priority:
            1. INSTALL LOCALLY when host signals hosted build
            2. SCAN LOCAL when /api/rescan is reachable (local dev)
            3. CHOOSE ZIP as the only-data-path fallback
          The non-primary buttons render in the demoted (outlined)
          form so the eye lands on the single recommended action.
        */}
        {showInstallLocally && (
          <a
            className="lcars-upload-panel__button"
            href={installLocallyHref}
            target="_blank"
            rel="noreferrer noopener"
            role="button"
            aria-label="install chat-arch locally — opens the README quickstart on GitHub"
          >
            INSTALL LOCALLY
          </a>
        )}
        {!showInstallLocally && scanShown && (
          <button
            type="button"
            className="lcars-upload-panel__button"
            onClick={onScanLocal}
            disabled={scanRunning}
            aria-label="scan local chat sources: ~/.claude and %APPDATA%\Claude"
            aria-busy={scanRunning || undefined}
            title="Scan local chat sources: ~/.claude and %APPDATA%\Claude. Cloud data only refreshes when you upload a new ZIP."
          >
            {scanLabel}
          </button>
        )}
        <button
          type="button"
          className={
            showInstallLocally || scanShown
              ? 'lcars-upload-panel__button lcars-upload-panel__button--cloud-secondary'
              : 'lcars-upload-panel__button'
          }
          onClick={openPicker}
          disabled={state.status === 'parsing'}
          aria-label="choose cloud export zip"
        >
          {state.status === 'parsing' ? 'PARSING…' : 'CHOOSE ZIP'}
        </button>
        {onLoadDemo && (
          <button
            type="button"
            className="lcars-upload-panel__button lcars-upload-panel__button--secondary"
            onClick={onLoadDemo}
            disabled={state.status === 'parsing'}
            aria-label="load demo data — populate the viewer with generated fake conversations"
            title="Populate the viewer with generated fake conversations so you can explore the UI."
          >
            LOAD DEMO DATA
          </button>
        )}
      </div>
      {!showInstallLocally && scanShown && scanCaption && (
        <div className="lcars-upload-panel__status" role="status" aria-live="polite">
          {scanCaption}
        </div>
      )}
      {onLoadDemo && variant === 'prominent' && (
        <p className="lcars-upload-panel__hint lcars-upload-panel__hint--demo">
          No export handy? Load the bundled fixture — about 100 hand-written fake conversations
          — so you can try the filters, sparkline, and analysis tab. Nothing is stored server-side.
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        onChange={onFileChange}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />

      {state.status === 'parsing' && (
        <div className="lcars-upload-panel__status" role="status" aria-live="polite">
          PARSING {state.label}…
        </div>
      )}
      {state.status === 'error' && (
        <div className="lcars-upload-panel__status lcars-upload-panel__status--error" role="alert">
          {state.message}
        </div>
      )}
      {state.status === 'success' && (
        <div
          className="lcars-upload-panel__status lcars-upload-panel__status--ok"
          role="status"
          aria-live="polite"
        >
          LOADED {state.count} CONVERSATIONS FROM {state.label}
        </div>
      )}
    </section>
  );
}
