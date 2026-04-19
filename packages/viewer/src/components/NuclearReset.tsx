import { useEffect, useRef, useState } from 'react';
import { onActivate } from '../util/a11y.js';

/**
 * Nuclear-reset affordance. Renders:
 *   - A tucked-away `⚠ RESET` chip in the bottom-left corner (deliberately
 *     low-prominence — this is the emergency exit, not a primary action).
 *   - A confirmation dialog that requires the user to type `NUKE` and
 *     explicitly click CONFIRM. Double-clicking the chip itself does
 *     nothing; every step is an intentional action.
 *
 * What it wipes when the user confirms:
 *   - Everything under `apps/standalone/public/chat-arch-data/` on disk
 *     except `.gitkeep` — the scanned manifest, transcripts, analysis
 *     JSONs. The dev server wipe is a POST to `/api/clear`.
 *   - Every `chat-arch:*` key in this browser's localStorage — the demo
 *     banner dismissed flag, the boot-seen flag, anything future.
 *   - The currently-uploaded ZIP data (via the `onUnload` prop, if any).
 *
 * After the wipe lands, the page reloads to a pristine state — the dev
 * server will re-seed the demo corpus on its next `pnpm dev` cycle, so
 * the viewer lands on either the demo (if the server auto-seeds on
 * boot) or the empty state otherwise.
 *
 * The chip auto-hides when `available === false` (no `/api/clear`
 * endpoint, i.e. static-build deploys without the Astro backend).
 */

export interface NuclearResetProps {
  /** True when the `/api/clear` endpoint is reachable. Controls chip visibility. */
  available: boolean;
  /** Unloads any uploaded ZIP from in-memory viewer state. Called pre-reload. */
  onUnload?: () => void;
}

const CONFIRM_WORD = 'NUKE';
const LOCAL_STORAGE_PREFIX = 'chat-arch:';

export function NuclearReset({ available, onUnload }: NuclearResetProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus the typed-confirmation input when the dialog opens so the
  // user can hit the keyboard immediately — prevents a "where do I type
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
      // anything that snapshots React state during teardown doesn't
      // persist a now-orphaned upload.
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
      <div
        className="lcars-nuclear-chip"
        role="button"
        tabIndex={0}
        aria-label="open nuclear reset dialog"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => onActivate(e, () => setOpen(true))}
      >
        <span className="lcars-nuclear-chip__icon" aria-hidden="true">
          ⚠
        </span>
        <span className="lcars-nuclear-chip__label">RESET</span>
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
                NUCLEAR RESET
              </h2>
            </header>
            <div id="lcars-nuclear-body" className="lcars-nuclear-dialog__body">
              <p className="lcars-nuclear-dialog__warning">
                <strong>This is a destructive action.</strong> It will:
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
                  onChange={(e) => setTyped(e.target.value)}
                  disabled={status === 'running'}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
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
                {status === 'running' ? 'WIPING…' : 'CONFIRM NUKE'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
