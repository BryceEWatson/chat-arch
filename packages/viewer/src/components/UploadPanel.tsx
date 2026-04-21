import { useRef, useState } from 'react';
import { parseCloudZip } from '../data/zipUpload.js';
import { maskedUploadLabel } from '../data/uploadLabel.js';
import type { UploadedCloudData } from '../types.js';

export interface UploadPanelProps {
  onLoaded: (data: UploadedCloudData) => void;
  /** Optional compact variant — omits the headline copy. */
  variant?: 'prominent' | 'compact';
}

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
export function UploadPanel({ onLoaded, variant = 'prominent' }: UploadPanelProps) {
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
      {variant === 'prominent' && (
        <>
          <h3 className="lcars-upload-panel__title">LOAD CLOUD EXPORT</h3>
          <p className="lcars-upload-panel__hint">
            Drop a Settings → Privacy → Export data ZIP from claude.ai to browse your conversations
            without running the CLI.
          </p>
        </>
      )}

      <button
        type="button"
        className="lcars-upload-panel__button"
        onClick={openPicker}
        disabled={state.status === 'parsing'}
        aria-label="choose cloud export zip"
      >
        {state.status === 'parsing' ? 'PARSING…' : 'CHOOSE ZIP'}
      </button>

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
