import { useEffect, useRef, useState } from 'react';

/**
 * Destructive "wipe all local data" affordance. Renders inline in the
 * TopBar's left cluster as a native `<button>`, visually distinct
 * from the butterscotch SCAN LOCAL / UPLOAD CLOUD chips via the
 * peach destructive palette. Sits *adjacent* to the two data-source
 * buttons (intentionally — this is what undoes what they did) but is
 * strongly color-coded so a user reaching for UPDATE CLOUD cannot
 * confuse the two at a glance.
 *
 * What confirmation does when the user commits:
 *   - POST `/api/clear` → wipe everything under
 *     `apps/standalone/public/chat-arch-data/` on disk (preserves
 *     `.gitkeep`).
 *   - Remove every `chat-arch:*` key in this browser's localStorage.
 *   - Call `onUnload` (host's existing handler) to drop any in-memory
 *     uploaded ZIP before reload.
 *   - Reload the page with a cache-buster.
 *
 * The gates: typed-`DELETE` confirmation (matches the button verb, not
 * a theatrical "NUKE"); the CONFIRM button stays disabled until the
 * word matches. Esc and backdrop-click dismiss (disabled while the
 * request is in flight so a mid-wipe click doesn't misread as cancel).
 *
 * Auto-hides when `available === false` — static-build deploys
 * without the `/api/clear` endpoint get no surface for an endpoint
 * that isn't there.
 */

export interface NuclearResetProps {
  /** True when `/api/clear` is reachable. Controls button visibility. */
  available: boolean;
  /** Host's unload handler — drops the in-memory uploaded ZIP before reload. */
  onUnload?: () => void;
}

const CONFIRM_WORD = 'DELETE';
const LOCAL_STORAGE_PREFIX = 'chat-arch:';

export function NuclearReset({ available, onUnload }: NuclearResetProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the typed-confirmation input when the dialog opens so the
  // user can start typing immediately — prevents a "where do I type
  // this?" moment.
  useEffect(() => {
    if (open) {
      setTyped('');
      setErrorMsg(null);
      setStatus('idle');
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Esc-to-close matches the other dialog surfaces in the viewer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (status !== 'running') setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, status]);

  if (!available) return null;

  const canConfirm = typed === CONFIRM_WORD && status !== 'running';

  const confirm = async () => {
    if (!canConfirm) return;
    setStatus('running');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/clear', {
        method: 'POST',
        headers: { 'x-requested-with': 'chat-arch-clear' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
      }
      // Drop every `chat-arch:*` key before the reload. LocalStorage
      // keys unrelated to this app stay untouched.
      try {
        const keys: string[] = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(LOCAL_STORAGE_PREFIX)) keys.push(k);
        }
        for (const k of keys) window.localStorage.removeItem(k);
      } catch {
        // LocalStorage may be unavailable (private mode, disabled). The
        // disk wipe already happened, so a reload still lands the user
        // on a fresh state — localStorage cleanup is best-effort.
      }
      // Unload the in-memory uploaded ZIP, if any, before reload so
      // nothing that snapshots React state during teardown persists a
      // now-orphaned upload.
      try {
        onUnload?.();
      } catch {
        // Host's unload handler shouldn't throw, but if it does we
        // still want the reload to happen.
      }
      // Cache-bust the reload so the browser doesn't hand back a
      // cached manifest that references files we just deleted.
      const url = new URL(window.location.href);
      url.searchParams.set('_reset', String(Date.now()));
      window.location.href = url.toString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setErrorMsg(msg);
    }
  };

  return (
    <>
      <div className="lcars-top-bar__source-group lcars-top-bar__source-group--destructive">
        <button
          type="button"
          className="lcars-top-bar__source-btn lcars-top-bar__source-btn--destructive"
          aria-haspopup="dialog"
          aria-label="Delete all local data — opens a confirmation dialog"
          title="Delete all chat-arch local data (indexed manifest, transcripts, uploaded ZIP, saved preferences). Does not touch ~/.claude/ or %APPDATA%\Claude\."
          onClick={() => setOpen(true)}
        >
          <span className="lcars-top-bar__source-btn-label">DELETE ALL</span>
        </button>
      </div>
      {open && (
        <div
          className="lcars-nuclear-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && status !== 'running') setOpen(false);
          }}
        >
          <div
            className="lcars-nuclear-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="lcars-nuclear-title"
            aria-describedby="lcars-nuclear-body"
          >
            <header className="lcars-nuclear-dialog__header">
              <h2 id="lcars-nuclear-title" className="lcars-nuclear-dialog__title">
                Delete all local data
              </h2>
            </header>
            <div id="lcars-nuclear-body" className="lcars-nuclear-dialog__body">
              <p className="lcars-nuclear-dialog__warning">
                <strong>This cannot be undone.</strong> Confirming will:
              </p>
              <ul className="lcars-nuclear-dialog__list">
                <li>
                  Delete everything under <code>apps/standalone/public/chat-arch-data/</code> on
                  disk — the indexed manifest, local transcripts, cloud conversations, and analysis
                  files. The dev server will re-seed the demo corpus on the next{' '}
                  <code>pnpm dev</code>.
                </li>
                <li>
                  Clear every <code>chat-arch:*</code> key in this browser&apos;s localStorage — the
                  demo banner dismissed flag, the first-run boot-seen flag, any future preferences.
                </li>
                <li>Unload the currently-uploaded ZIP from memory, if any.</li>
                <li>Reload the page.</li>
              </ul>
              <p className="lcars-nuclear-dialog__warning">
                Your actual Claude transcripts on disk (<code>~/.claude/</code>,{' '}
                <code>%APPDATA%\Claude\</code>) are <strong>not</strong> touched. You can always
                re-scan them with <strong>SCAN LOCAL</strong>.
              </p>
              <label className="lcars-nuclear-dialog__confirm-label">
                Type <code>{CONFIRM_WORD}</code> to enable the confirm button:
                <input
                  ref={inputRef}
                  type="text"
                  className="lcars-nuclear-dialog__confirm-input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value.toUpperCase())}
                  disabled={status === 'running'}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  aria-describedby="lcars-nuclear-title"
                />
              </label>
              {errorMsg && (
                <p className="lcars-nuclear-dialog__error" role="alert">
                  Reset failed: {errorMsg}
                </p>
              )}
            </div>
            <footer className="lcars-nuclear-dialog__actions">
              <button
                type="button"
                className="lcars-nuclear-dialog__cancel"
                onClick={() => setOpen(false)}
                disabled={status === 'running'}
              >
                CANCEL
              </button>
              <button
                type="button"
                className="lcars-nuclear-dialog__confirm"
                onClick={confirm}
                disabled={!canConfirm}
                aria-disabled={!canConfirm}
              >
                {status === 'running' ? 'DELETING…' : 'DELETE EVERYTHING'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
