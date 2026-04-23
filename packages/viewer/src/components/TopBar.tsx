import { useRef, useState } from 'react';
import type { ViewportTier } from '../util/viewport.js';
import { onActivate } from '../util/a11y.js';
import { InfoPopover } from './InfoPopover.js';
import { NuclearReset } from './NuclearReset.js';

export type RescanStatus = 'idle' | 'running' | 'error' | 'ok';
export type UploadStatus = 'idle' | 'running' | 'error' | 'ok';

/**
 * TopBar hosts two data-source buttons on the left — one for the local
 * rescan (Scan Local / Update Local), one for the cloud upload
 * (Upload Cloud / Update Cloud). Both buttons are state-aware:
 *
 *   - Label flips "Scan" → "Update" (or "Upload" → "Update") once the
 *     effective manifest has any entries from that source, so a
 *     first-time user sees a CTA and a returning user sees a refresh
 *     action.
 *   - Running / ok / error states are reflected inline.
 *   - Scan Local renders *disabled* when no dev-server backend is
 *     available (web-only static deploys have no way to spawn the
 *     exporter). The hover tooltip explains how to install locally.
 *
 * Right cluster is the search input only.
 */
export interface TopBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  rightSlot?: React.ReactNode;
  /** Viewport tier; changes placeholder + label density on narrower screens. */
  tier?: ViewportTier;
  /**
   * When true the search input is disabled and shows muted styling. Used
   * while the detail overlay is open so typing can't silently mutate the
   * underlying list the user returns to (R11 F11.2).
   */
  disabled?: boolean;

  // ---- Scan Local button (left cluster) ----

  /**
   * Click handler for the Scan Local / Update Local button. When
   * `scanAvailable === false`, the button still renders but is
   * disabled and clicks are ignored — wiring the handler anyway keeps
   * the TopBar pure-stateless with no conditional prop shapes.
   */
  onRescan?: () => void;
  rescanStatus?: RescanStatus;
  rescanHint?: string;
  rescanProgress?: {
    phase: string | null;
    ix: number;
    total: number;
    latest: string | null;
  };
  /** True when the `/api/rescan` endpoint was reachable — i.e. dev
   *  server is running. False means web-only deploy: button disabled. */
  scanAvailable?: boolean;
  /** True when the effective manifest has any local entries
   *  (cowork / cli-direct / cli-desktop). Flips the label to
   *  "Update Local". */
  hasLocalData?: boolean;

  // ---- Upload Cloud button (left cluster) ----

  /**
   * Click handler fired with the selected ZIP file. The host is
   * responsible for parsing + merging + any post-state updates.
   * Absence hides the upload button (kept for tests that pass no
   * upload handler).
   */
  onCloudUpload?: (file: File) => void;
  uploadStatus?: UploadStatus;
  uploadHint?: string;
  /** True when the effective manifest has any cloud entries. Flips
   *  the label to "Update Cloud". */
  hasCloudData?: boolean;

  // ---- Delete All button (left cluster, trailing) ----

  /**
   * When true, render the `DELETE ALL` chip after the source buttons.
   * Mirrors `scanAvailable` — a static-build deploy without an Astro
   * backend has no `/api/clear` endpoint to call, so the button
   * auto-hides. Calls `onDeleteUnload` (memory-only ZIP unload) as a
   * pre-reload hook; the destructive confirm itself lives inside the
   * NuclearReset component.
   */
  deleteAvailable?: boolean;
  /** Host's upload-unload handler. Called by NuclearReset before the
   *  post-wipe reload so state snapshots don't persist an orphaned
   *  ZIP. Passed through from the outer viewer. */
  onDeleteUnload?: () => void;
  /** Per-source session counts — feeds the selective-delete dropdown
   *  so each source row can show how many sessions it would wipe. */
  deleteCounts?: {
    cloud: number;
    cowork: number;
    'cli-direct': number;
    'cli-desktop': number;
  };
}

// How-to copy shown in the Upload Cloud hover tooltip. Lives up here
// so it's easy to keep in sync with platform changes.
const CLOUD_EXPORT_INSTRUCTIONS =
  'Export from claude.ai → Settings → Privacy → "Export data". ' +
  'Download the ZIP that arrives in your email and pick it here. ' +
  'Uploading again merges new conversations without duplicating old ones.';

// Web-only / no-backend hint for the Scan Local button.
const SCAN_LOCAL_WEB_ONLY_HINT =
  'Scanning local chat data requires running Chat Archaeologist locally ' +
  '(pnpm --filter @chat-arch/standalone dev). The hosted web build has ' +
  'no way to spawn the scanner.';

const SCAN_LOCAL_DEFAULT_HINT =
  'Scan local chat sources: ~/.claude and %APPDATA%\\Claude. ' +
  'Cloud data only refreshes when you upload a new ZIP.';

export function TopBar({
  query,
  onQueryChange,
  rightSlot,
  tier = 'desktop',
  disabled = false,
  onRescan,
  rescanStatus = 'idle',
  rescanHint,
  rescanProgress,
  scanAvailable = false,
  hasLocalData = false,
  onCloudUpload,
  uploadStatus = 'idle',
  uploadHint,
  hasCloudData = false,
  deleteAvailable = false,
  onDeleteUnload,
  deleteCounts,
}: TopBarProps) {
  const placeholder = disabled
    ? 'exit detail view to search'
    : tier === 'desktop'
      ? 'search title / summary / preview'
      : tier === 'tablet'
        ? 'SEARCH…'
        : 'SEARCH SESSIONS…';

  // ---- Scan Local / Update Local label + state ----
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

  // ---- Upload Cloud / Update Cloud label + state ----
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

  // Hidden file input owned by the TopBar so the upload button can
  // open the native picker without relying on the legacy UploadPanel.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [, setForceRerender] = useState(0);
  const openPicker = () => {
    if (!onCloudUpload || uploadBusy) return;
    fileInputRef.current?.click();
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow selecting the same filename twice
    if (f && onCloudUpload) onCloudUpload(f);
    // Force a re-render in case the host's state doesn't feed back through.
    setForceRerender((n) => n + 1);
  };

  return (
    <header className="lcars-top-bar" role="banner">
      <div className="lcars-top-bar__left">
        <span className="lcars-top-bar__dot" aria-hidden="true" />
        <h1 className="lcars-top-bar__title">CHAT ARCHAEOLOGIST</h1>
        {/*
          Design-system colophon. A small ⓘ anchored to the title that
          opens a sentence-length credit and a link to
          /design-system/. Reuses the existing InfoPopover pattern so
          it reads as a natural help chip rather than new chrome —
          the goal was a subtle discovery affordance, not another CTA.
          The link navigates same-origin to the walkthrough page
          served by the standalone app (apps/standalone/src/pages/
          design-system/index.astro).
        */}
        <InfoPopover
          ariaLabel="about the Supergraphic Panel design system"
          className="lcars-top-bar__title-info"
        >
          <strong>Supergraphic Panel</strong>
          <p>
            This UI uses the Supergraphic Panel design system — published with
            its source, DTCG tokens, and an LLM-consumable specification.
          </p>
          <p>
            <a href="/design-system/">View the walkthrough →</a>
          </p>
        </InfoPopover>
        {onCloudUpload && (
          <>
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
              {/* Info popover lives OUTSIDE the button so clicking it
                  opens help instead of firing the upload action. */}
              <InfoPopover
                ariaLabel="about the Upload Cloud button"
                className="lcars-top-bar__source-info"
              >
                <strong>Upload / Update Cloud</strong>
                <p>Add or refresh conversations from a Claude.ai cloud export.</p>
                <p>
                  <strong>Local-only:</strong> the ZIP is parsed in your browser and kept in this
                  tab&rsquo;s IndexedDB — it&rsquo;s never sent to a server. The word
                  &ldquo;upload&rdquo; here means you&rsquo;re loading the file into the viewer,
                  not pushing it anywhere.
                </p>
                <p>
                  <strong>How to get the ZIP:</strong> open claude.ai →{' '}
                  <em>Settings → Privacy → &ldquo;Export data&rdquo;</em>. Claude emails you a ZIP
                  when it&rsquo;s ready; download it and pick it here.
                </p>
                <p>
                  Uploading the same ZIP twice is harmless — duplicates are merged by conversation
                  id, and a second ZIP that&rsquo;s newer just adds the new conversations on top of
                  what&rsquo;s already loaded.
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
          </>
        )}
        {onRescan && (
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
                    <strong>Available when running locally.</strong> The hosted web build has no way
                    to spawn the scanner.
                  </p>
                  <p>
                    To enable, clone the repo and run{' '}
                    <code>pnpm --filter @chat-arch/standalone dev</code>, then reload this page.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Walks the two local chat-data directories and rebuilds the viewer&rsquo;s
                    manifest:
                  </p>
                  <ul>
                    <li>
                      <code>~/.claude/projects/</code> — Claude Code CLI transcripts
                    </li>
                    <li>
                      <code>%APPDATA%\Claude\</code> — Cowork + Desktop-CLI sessions
                    </li>
                  </ul>
                  <p>
                    <strong>Local-only:</strong> the scan reads JSONL files off your own disk and
                    writes the manifest to a local directory served by the Astro dev server on{' '}
                    <code>localhost</code>. Nothing leaves your machine.
                  </p>
                  <p>
                    Cloud data is <em>not</em> touched — it only refreshes when you upload a fresh
                    ZIP via the Cloud button.
                  </p>
                  <p>
                    The scan is incremental: unchanged transcripts are reused from the previous run
                    via cached file mtimes, so repeated runs are sub-second when nothing&rsquo;s
                    new.
                  </p>
                </>
              )}
            </InfoPopover>
          </div>
        )}
        <NuclearReset
          available={deleteAvailable}
          {...(onDeleteUnload ? { onUnload: onDeleteUnload } : {})}
          {...(deleteCounts ? { counts: deleteCounts } : {})}
        />
      </div>
      <div className="lcars-top-bar__right">
        {rightSlot}
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
