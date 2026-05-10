import { useEffect, useRef, useState } from 'react';
import { onActivate } from '../util/a11y.js';
import { InfoPopover } from './InfoPopover.js';
import { NuclearReset } from './NuclearReset.js';
import type { RescanStatus, UploadStatus } from './TopBar.js';

/**
 * v2 spec §6 / decision D4: data-source actions live in a DATA panel
 * opened from the sidebar, not in the TopBar header. This component
 * is the panel itself — a sheet anchored to the left edge (next to
 * the sidebar trigger) hosting:
 *
 *   - UPLOAD CLOUD / UPDATE CLOUD button (browser-tier safe).
 *   - SCAN LOCAL / UPDATE LOCAL button (local-tier; disabled-with-
 *     explanation when /api/rescan isn't reachable).
 *   - DELETE … dropdown (NuclearReset, gated by source counts).
 *
 * The internal state-aware label logic for the two action buttons was
 * moved here verbatim from TopBar — same prop names, same hidden file
 * input pattern. Keeps the labelled busy / ok / error transitions
 * intact across the move.
 */

const CLOUD_EXPORT_INSTRUCTIONS =
  'Export from claude.ai → Settings → Privacy → "Export data". ' +
  'Download the ZIP that arrives in your email and pick it here. ' +
  'Uploading again merges new conversations without duplicating old ones.';

const SCAN_LOCAL_WEB_ONLY_HINT =
  'Scanning local chat data requires running Chat Archaeologist locally — ' +
  'see the README quickstart to install. The hosted web build has no way ' +
  'to spawn the scanner.';

const SCAN_LOCAL_DEFAULT_HINT =
  'Scan local chat sources: ~/.claude and %APPDATA%\\Claude. ' +
  'Cloud data only refreshes when you upload a new ZIP.';

export interface DataPanelProps {
  isOpen: boolean;
  onClose: () => void;

  // Cloud upload
  onCloudUpload?: (file: File) => void;
  uploadStatus?: UploadStatus;
  uploadHint?: string;
  hasCloudData?: boolean;

  // Local scan
  onRescan?: () => void;
  rescanStatus?: RescanStatus;
  rescanHint?: string;
  rescanProgress?: {
    phase: string | null;
    ix: number;
    total: number;
    latest: string | null;
  };
  scanAvailable?: boolean;
  hasLocalData?: boolean;

  // Delete
  deleteAvailable?: boolean;
  onDeleteUnload?: () => void;
  deleteCounts?: {
    cloud: number;
    cowork: number;
    'cli-direct': number;
    'cli-desktop': number;
  };
}

export function DataPanel({
  isOpen,
  onClose,
  onCloudUpload,
  uploadStatus = 'idle',
  uploadHint,
  hasCloudData = false,
  onRescan,
  rescanStatus = 'idle',
  rescanHint,
  rescanProgress,
  scanAvailable = false,
  hasLocalData = false,
  deleteAvailable = false,
  onDeleteUnload,
  deleteCounts,
}: DataPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [, setForceRerender] = useState(0);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // ---- Scan Local label state (mirrors prior TopBar logic) ----
  const rescanBusy = rescanStatus === 'running';
  const scanDisabled = !scanAvailable;
  const runningPhaseSuffix = (() => {
    if (!rescanBusy) return null;
    const phase = rescanProgress?.phase;
    const ix = rescanProgress?.ix ?? 0;
    const total = rescanProgress?.total ?? 0;
    if (phase && ix > 0 && total > 0) return `${phase.toUpperCase()} ${ix}/${total}`;
    if (phase) return phase.toUpperCase();
    return null;
  })();
  const scanIdleLabel = hasLocalData ? 'UPDATE LOCAL' : 'SCAN LOCAL';
  const scanIdleOkLabel = hasLocalData ? 'UPDATED ✓' : 'SCANNED ✓';
  const scanLabel =
    rescanStatus === 'running'
      ? runningPhaseSuffix
        ? `${hasLocalData ? 'UPDATING' : 'SCANNING'} · ${runningPhaseSuffix}`
        : hasLocalData
          ? 'UPDATING…'
          : 'SCANNING…'
      : rescanStatus === 'ok'
        ? scanIdleOkLabel
        : rescanStatus === 'error'
          ? hasLocalData
            ? 'UPDATE FAILED'
            : 'SCAN FAILED'
          : scanIdleLabel;
  const scanCaption = rescanBusy ? (rescanProgress?.latest ?? null) : null;
  const scanTitle = scanDisabled
    ? SCAN_LOCAL_WEB_ONLY_HINT
    : scanCaption
      ? scanCaption
      : (rescanHint ?? SCAN_LOCAL_DEFAULT_HINT);

  // ---- Upload Cloud label state ----
  const uploadBusy = uploadStatus === 'running';
  const uploadIdleLabel = hasCloudData ? 'UPDATE CLOUD' : 'UPLOAD CLOUD';
  const uploadLabel =
    uploadStatus === 'running'
      ? hasCloudData
        ? 'UPDATING…'
        : 'UPLOADING…'
      : uploadStatus === 'ok'
        ? hasCloudData
          ? 'UPDATED ✓'
          : 'LOADED ✓'
        : uploadStatus === 'error'
          ? 'UPLOAD FAILED'
          : uploadIdleLabel;
  const uploadTitle = uploadHint ?? CLOUD_EXPORT_INSTRUCTIONS;

  const openPicker = () => {
    if (!onCloudUpload || uploadBusy) return;
    fileInputRef.current?.click();
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f && onCloudUpload) onCloudUpload(f);
    setForceRerender((n) => n + 1);
  };

  return (
    <>
      <div className="lcars-data-panel__scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="lcars-data-panel"
        role="dialog"
        aria-modal="true"
        aria-label="data sources panel"
      >
        <header className="lcars-data-panel__header">
          <h2 className="lcars-data-panel__title">DATA</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="lcars-data-panel__close"
            onClick={onClose}
            aria-label="close data panel"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>
        <p className="lcars-data-panel__lead">
          Add chat data, refresh existing sources, or delete what&rsquo;s indexed. Nothing
          here leaves your machine.
        </p>

        {onCloudUpload && (
          <section className="lcars-data-panel__section">
            <h3 className="lcars-data-panel__section-title">CLOUD</h3>
            <div className="lcars-data-panel__row">
              <div className="lcars-top-bar__source-group">
                <div
                  className={`lcars-top-bar__source-btn lcars-top-bar__source-btn--cloud lcars-top-bar__source-btn--${uploadStatus}`}
                  role="button"
                  tabIndex={uploadBusy ? -1 : 0}
                  aria-label={
                    hasCloudData
                      ? 'upload another cloud-export ZIP to merge new conversations'
                      : 'upload a cloud-export ZIP from Claude.ai'
                  }
                  aria-busy={uploadBusy || undefined}
                  aria-disabled={uploadBusy || undefined}
                  title={uploadTitle}
                  onClick={openPicker}
                  onKeyDown={(e) => onActivate(e, openPicker)}
                >
                  <span className="lcars-top-bar__source-btn-label">{uploadLabel}</span>
                </div>
                <InfoPopover
                  ariaLabel="about the Upload Cloud button"
                  className="lcars-top-bar__source-info"
                >
                  <strong>Upload / Update Cloud</strong>
                  <p>Add or refresh conversations from a Claude.ai cloud export.</p>
                  <p>
                    The word &ldquo;upload&rdquo; means loading the file into the viewer, not
                    sending it anywhere. The ZIP is parsed in this tab and kept in IndexedDB so a
                    refresh doesn&rsquo;t lose it.
                  </p>
                  <p>
                    <strong>How to get the ZIP:</strong> open claude.ai →{' '}
                    <em>Settings → Privacy → &ldquo;Export data&rdquo;</em>. Claude emails you a
                    ZIP when it&rsquo;s ready; download it and pick it here.
                  </p>
                </InfoPopover>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                onChange={onFileChange}
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
              />
            </div>
          </section>
        )}

        {onRescan && (
          <section className="lcars-data-panel__section">
            <h3 className="lcars-data-panel__section-title">LOCAL</h3>
            <div className="lcars-data-panel__row">
              <div className="lcars-top-bar__source-group">
                <div
                  className={
                    `lcars-top-bar__source-btn lcars-top-bar__source-btn--scan ` +
                    `lcars-top-bar__source-btn--${rescanStatus}` +
                    (scanDisabled ? ' lcars-top-bar__source-btn--unavailable' : '')
                  }
                  role="button"
                  tabIndex={scanDisabled || rescanBusy ? -1 : 0}
                  aria-label={
                    scanDisabled
                      ? 'scan local chat sources (unavailable — run locally to enable)'
                      : hasLocalData
                        ? 'update local chat data by rescanning ~/.claude and %APPDATA%\\Claude'
                        : 'scan local chat sources: ~/.claude and %APPDATA%\\Claude'
                  }
                  aria-busy={rescanBusy || undefined}
                  aria-disabled={scanDisabled || rescanBusy || undefined}
                  title={scanTitle}
                  onClick={() => {
                    if (!scanDisabled && !rescanBusy) onRescan();
                  }}
                  onKeyDown={(e) =>
                    onActivate(e, () => {
                      if (!scanDisabled && !rescanBusy) onRescan();
                    })
                  }
                >
                  <span className="lcars-top-bar__source-btn-label">{scanLabel}</span>
                  {scanCaption && (
                    <span className="lcars-top-bar__source-btn-caption" aria-hidden="true">
                      {scanCaption}
                    </span>
                  )}
                </div>
                <InfoPopover
                  ariaLabel="about the Scan Local button"
                  className="lcars-top-bar__source-info"
                >
                  <strong>Scan / Update Local</strong>
                  {scanDisabled ? (
                    <>
                      <p>
                        <strong>SCAN LOCAL works only when chat-arch is running on your
                        machine.</strong> The hosted web build has no way to read your local
                        Claude Code transcripts.
                      </p>
                      <p>
                        Visit the{' '}
                        <a
                          href="https://github.com/BryceEWatson/chat-arch#quickstart"
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          README quickstart
                        </a>{' '}
                        to install it locally, then reload this page.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>Walks the two local chat-data directories:</p>
                      <ul>
                        <li>
                          <code>~/.claude/projects/</code> — Claude Code CLI transcripts
                        </li>
                        <li>
                          <code>%APPDATA%\Claude\</code> — Cowork + Desktop-CLI sessions
                        </li>
                      </ul>
                      <p>
                        The Astro dev server on <code>localhost</code> reads those files, writes
                        the refreshed manifest to a local directory, and serves it back to this
                        tab. Nothing leaves your machine.
                      </p>
                    </>
                  )}
                </InfoPopover>
              </div>
            </div>
          </section>
        )}

        <section className="lcars-data-panel__section">
          <h3 className="lcars-data-panel__section-title">DELETE</h3>
          <div className="lcars-data-panel__row">
            <NuclearReset
              available={deleteAvailable ?? false}
              {...(onDeleteUnload ? { onUnload: onDeleteUnload } : {})}
              {...(deleteCounts ? { counts: deleteCounts } : {})}
            />
          </div>
        </section>
      </aside>
    </>
  );
}
