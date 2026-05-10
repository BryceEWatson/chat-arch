import { useRef, useState } from 'react';
import { parseCloudZip } from '../data/zipUpload.js';
import { maskedUploadLabel } from '../data/uploadLabel.js';
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
   * Phase 4 — hosted refocus. When `false`, the CHOOSE ZIP cloud-upload
   * affordance is omitted and replaced by a primary "INSTALL LOCALLY"
   * link button. The cloud-export hint copy is also suppressed in that
   * mode. Defaults to `true` so existing local-dev callers and tests
   * keep the previous behavior. The host should pass
   * `rescanCtl.available` here: hosted static builds (no `/api/rescan`)
   * become the install-locally storefront; local Astro dev keeps the
   * cloud-zip upload path.
   */
  showCloudUpload?: boolean;
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
  showCloudUpload = true,
  installLocallyHref = DEFAULT_INSTALL_LOCALLY_HREF,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UploadState>({ status: 'idle' });

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
      {variant === 'prominent' && showCloudUpload && (
        <>
          <h3 className="lcars-upload-panel__title">LOAD CLOUD EXPORT</h3>
          <p className="lcars-upload-panel__hint">
            Drop a Settings → Privacy → Export data ZIP from claude.ai to browse your conversations
            without running the CLI.
          </p>
        </>
      )}
      {variant === 'prominent' && !showCloudUpload && (
        <>
          {/*
            Phase 4 hosted refocus: chat-arch.dev becomes a sales /
            demo storefront. The workshop loop (mine → patch CLAUDE.md
            → re-mine) requires a local Claude Code install, so a
            cloud-only visitor can't actually finish the loop. Replace
            the CHOOSE ZIP affordance with a clear pointer to the
            README quickstart. LOAD DEMO DATA stays as the secondary
            "see the UI without installing" path.
          */}
          <h3 className="lcars-upload-panel__title">INSTALL CHAT-ARCH LOCALLY</h3>
          <p className="lcars-upload-panel__hint">
            Chat-arch is open source. To audit your own corpus and patch your CLAUDE.md, install it
            on your machine — the workshop loop runs against your local Claude Code transcripts.
          </p>
        </>
      )}

      <div className="lcars-upload-panel__buttons">
        {showCloudUpload ? (
          <button
            type="button"
            className="lcars-upload-panel__button"
            onClick={openPicker}
            disabled={state.status === 'parsing'}
            aria-label="choose cloud export zip"
          >
            {state.status === 'parsing' ? 'PARSING…' : 'CHOOSE ZIP'}
          </button>
        ) : (
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
      {onLoadDemo && variant === 'prominent' && (
        <p className="lcars-upload-panel__hint lcars-upload-panel__hint--demo">
          No export handy? Load the bundled fixture — about 100 hand-written fake conversations
          — so you can try the filters, sparkline, and analysis tab. Nothing is stored server-side.
        </p>
      )}

      {showCloudUpload && (
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={onFileChange}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />
      )}

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
