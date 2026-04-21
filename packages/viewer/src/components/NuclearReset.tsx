import { useEffect, useRef, useState } from 'react';
import { clearUploadedData } from '../data/uploadedDataStore.js';
import { clearSemanticLabels } from '../data/semanticLabelsStore.js';
import { clearBenchResults } from '../data/benchResultsStore.js';

/**
 * Selective-delete affordance. The button sits in the TopBar's left
 * cluster (visually distinct peach-destructive pill). Clicking opens
 * an inline dropdown panel listing the four ingestion sources with
 * live session counts — the user picks which to wipe and clicks
 * DELETE SELECTED, which flips the footer into an "Are you sure?"
 * armed state. A second deliberate click confirms.
 *
 * Why a dropdown instead of a modal: the dropdown doubles as the
 * viewer's documentation of its own data sources. A user clicking the
 * button out of curiosity learns *what* chat-arch ingests without
 * having to read the README. Modals feel ceremonial for a "pick what
 * to wipe" decision; dropdowns read as "adjusting settings in place".
 *
 * Confirmation is two clicks (no typed word) because the source
 * checkboxes already force a deliberate decision — adding typed
 * confirmation on top felt bureaucratic for "delete my CLI data only".
 *
 * Always renders. `available` gates the server-side POST, not the
 * surface itself — on a static-build deploy (no Astro backend, so no
 * `/api/clear`) the dropdown still appears and the commit path runs
 * client-only: skip the POST, wipe the three IndexedDB stores that
 * belong to an uploaded ZIP. The other three sources (cli-direct /
 * cli-desktop / cowork) have count=0 on static deploys since there's
 * no exporter to have produced them, so selecting them is a no-op
 * rather than an error.
 */

export interface NuclearResetProps {
  /** True when `/api/clear` is reachable. Gates the server POST only;
   *  the client-IDB wipe path always runs. */
  available: boolean;
  /** Host's in-memory-ZIP unload handler. Called before the post-wipe
   *  reload so a stale upload doesn't survive into the fresh state. */
  onUnload?: () => void;
  /** Per-source session counts — the dropdown shows these next to
   *  each checkbox so the user knows what they'd wipe. */
  counts?: {
    cloud: number;
    cowork: number;
    'cli-direct': number;
    'cli-desktop': number;
  };
}

type SourceId = 'cli-direct' | 'cli-desktop' | 'cowork' | 'cloud';

interface SourceRow {
  id: SourceId;
  label: string;
  subtitle: string;
  explain: string;
}

const SOURCES: readonly SourceRow[] = [
  {
    id: 'cli-direct',
    label: 'Claude Code (CLI)',
    subtitle: 'cli-direct',
    explain: '~/.claude/projects/<project>/<session>.jsonl',
  },
  {
    id: 'cli-desktop',
    label: 'Claude Desktop',
    subtitle: 'cli-desktop',
    explain: '%APPDATA%\\Claude\\local-agent-mode-sessions\\…',
  },
  {
    id: 'cowork',
    label: 'Claude Cowork',
    subtitle: 'cowork',
    explain: '%APPDATA%\\Claude\\local-agent-mode-sessions\\…',
  },
  {
    id: 'cloud',
    label: 'claude.ai (cloud)',
    subtitle: 'cloud + uploaded ZIP',
    explain: 'From claude.ai Privacy Export, or drag-and-dropped ZIP',
  },
] as const;

const LOCAL_STORAGE_PREFIX = 'chat-arch:';

type Phase = 'idle' | 'armed' | 'running' | 'error';

export function NuclearReset({ available, onUnload, counts }: NuclearResetProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<SourceId>>(new Set());
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const firstCheckboxRef = useRef<HTMLInputElement | null>(null);

  // Reset dropdown state every time it opens — stale "armed" or error
  // leftovers shouldn't persist across disclosures.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setPhase('idle');
      setErrorMsg(null);
      const t = window.setTimeout(() => firstCheckboxRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Click-outside to close (while idle). Don't dismiss while a
  // request is in flight — that would look like a cancel.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e: MouseEvent) => {
      if (phase === 'running') return;
      const root = containerRef.current;
      if (!root) return;
      if (e.target instanceof Node && !root.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, phase]);

  // Esc-to-close mirrors the other dialog-ish surfaces in the viewer.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (phase !== 'running') setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, phase]);

  const countOf = (id: SourceId): number => counts?.[id] ?? 0;
  const totalSelectedSessions = Array.from(selected).reduce((a, id) => a + countOf(id), 0);
  const allSelected = selected.size === SOURCES.length;

  const toggleSource = (id: SourceId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (phase === 'armed') setPhase('idle'); // re-arming required after edits
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(SOURCES.map((s) => s.id)));
    if (phase === 'armed') setPhase('idle');
  };

  const primaryClick = async () => {
    if (selected.size === 0 || phase === 'running') return;
    if (phase !== 'armed') {
      setPhase('armed');
      return;
    }
    // armed → commit
    setPhase('running');
    setErrorMsg(null);
    try {
      const sources = Array.from(selected);
      // Skip the POST on static-build deploys — the endpoint doesn't
      // exist. The client-IDB wipe below still runs, which is the only
      // state a static deploy can meaningfully wipe anyway (uploaded
      // ZIP + derived labels/bench). The non-cloud checkboxes have
      // count=0 on static, so selecting them does nothing on either
      // side of this branch.
      if (available) {
        const res = await fetch('/api/clear', {
          method: 'POST',
          headers: {
            'x-requested-with': 'chat-arch-clear',
            'content-type': 'application/json',
          },
          credentials: 'same-origin',
          body: JSON.stringify({ sources }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
        }
      }
      // Wipe ALL cloud-derived IDBs when cloud is among the victims:
      //
      //   - `chat-arch` (uploaded ZIP bytes)              ← clearUploadedData
      //   - `chat-arch-semantic-labels` (per-session      ← clearSemanticLabels
      //      topic assignments, embeddings)
      //   - `chat-arch-bench-results` (classified_pct,    ← clearBenchResults
      //      emergent_pct, n_topics and sibling metrics
      //      computed FROM the cloud corpus)
      //
      // Bench-results are a developer-only surface, but every number
      // they persist is a one-way summary of the user's content. If
      // the cloud upload they were computed from is gone, the stats
      // must go too — orphan metrics pinned alongside a corpus that
      // no longer exists are the exact kind of "at-rest derivative"
      // the security review set out to stop.
      //
      // Two-step cleanup:
      //   1. `onUnload?.()` resets in-memory state (selection, cache,
      //      filters). The host's handler also fires-and-forgets its
      //      own persist effect's clear, which cannot be relied on to
      //      commit before the `window.location.href` navigation below.
      //   2. `await` the explicit `clearUploadedData()` /
      //      `clearSemanticLabels()` / `clearBenchResults()` calls —
      //      these are the authoritative IDB wipes whose commit we
      //      can guarantee pre-reload.
      if (selected.has('cloud')) {
        try {
          onUnload?.();
        } catch {
          /* ignore */
        }
        // Run the three clears in parallel — they target distinct
        // IndexedDB databases (`chat-arch`, `chat-arch-semantic-labels`,
        // `chat-arch-bench-results`) so there's no ordering dependency.
        // `Promise.allSettled` — rather than `Promise.all` — so one
        // failing wipe doesn't short-circuit the other two; the
        // `window.location.href` navigation below must happen even if
        // a single clear throws (best-effort on the destructive path).
        await Promise.allSettled([
          clearUploadedData(),
          clearSemanticLabels(),
          clearBenchResults(),
        ]);
      }
      // Kitchen-sink mode (every source selected) additionally wipes
      // the `chat-arch:*` localStorage keys — onboarding state, UI
      // preferences, etc. A user wiping just CLI shouldn't lose their
      // onboarding state, so this path is gated on all-selected.
      if (allSelected) {
        try {
          const keys: string[] = [];
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k && k.startsWith(LOCAL_STORAGE_PREFIX)) keys.push(k);
          }
          for (const k of keys) window.localStorage.removeItem(k);
        } catch {
          /* ignore */
        }
      }
      // Cache-bust the reload so the browser doesn't hand back a
      // cached manifest that references files we just deleted.
      const url = new URL(window.location.href);
      url.searchParams.set('_reset', String(Date.now()));
      window.location.href = url.toString();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPhase('error');
      setErrorMsg(msg);
    }
  };

  const buttonLabel = (() => {
    if (phase === 'running') return 'DELETING…';
    if (phase === 'armed')
      return allSelected ? 'YES — DELETE EVERYTHING' : `YES — DELETE ${totalSelectedSessions}`;
    if (selected.size === 0) return 'DELETE SELECTED';
    return allSelected ? 'DELETE EVERYTHING' : `DELETE SELECTED (${totalSelectedSessions})`;
  })();

  return (
    <div className="lcars-top-bar__source-group lcars-top-bar__source-group--destructive">
      <div className="lcars-delete-dropdown" ref={containerRef}>
        <button
          type="button"
          className="lcars-top-bar__source-btn lcars-top-bar__source-btn--destructive"
          aria-haspopup="true"
          aria-expanded={open}
          aria-label="Delete data — opens a panel to pick which sources to wipe"
          title="Delete indexed data — pick which source(s) to wipe"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="lcars-top-bar__source-btn-label">DELETE…</span>
        </button>
        {open && (
          <div
            className="lcars-delete-dropdown__panel"
            role="dialog"
            aria-label="Delete data — select sources"
          >
            <header className="lcars-delete-dropdown__header">
              <h3 className="lcars-delete-dropdown__title">Delete indexed data</h3>
              <p className="lcars-delete-dropdown__hint">
                Pick which source(s) to wipe. Nothing in <code>~/.claude/</code> or{' '}
                <code>%APPDATA%\Claude\</code> is touched.
              </p>
            </header>
            <ul className="lcars-delete-dropdown__list" role="none">
              {SOURCES.map((src, ix) => {
                const n = countOf(src.id);
                const checked = selected.has(src.id);
                return (
                  <li key={src.id} className="lcars-delete-dropdown__row">
                    <label className="lcars-delete-dropdown__label">
                      <input
                        ref={ix === 0 ? firstCheckboxRef : undefined}
                        type="checkbox"
                        className="lcars-delete-dropdown__checkbox"
                        checked={checked}
                        onChange={() => toggleSource(src.id)}
                        disabled={phase === 'running'}
                      />
                      <span className="lcars-delete-dropdown__row-main">
                        <span className="lcars-delete-dropdown__row-title">{src.label}</span>
                        <span className="lcars-delete-dropdown__row-sub">{src.subtitle}</span>
                      </span>
                      <span className="lcars-delete-dropdown__row-count">
                        {n.toLocaleString()} {n === 1 ? 'session' : 'sessions'}
                      </span>
                    </label>
                    <p className="lcars-delete-dropdown__row-explain">{src.explain}</p>
                  </li>
                );
              })}
            </ul>
            <div className="lcars-delete-dropdown__selectall">
              <button
                type="button"
                className="lcars-delete-dropdown__selectall-btn"
                onClick={toggleAll}
                disabled={phase === 'running'}
              >
                {allSelected ? 'CLEAR SELECTION' : 'SELECT ALL'}
              </button>
            </div>
            {phase === 'armed' && (
              <p className="lcars-delete-dropdown__armed" role="status">
                <strong>Are you sure?</strong>{' '}
                {allSelected
                  ? 'This wipes every indexed session, uploaded ZIP, derived analysis, and browser preference. It cannot be undone.'
                  : `This wipes ${totalSelectedSessions} session${totalSelectedSessions === 1 ? '' : 's'} and regenerates analysis files on the next scan. It cannot be undone.`}
              </p>
            )}
            {errorMsg && (
              <p className="lcars-delete-dropdown__error" role="alert">
                Delete failed: {errorMsg}
              </p>
            )}
            <footer className="lcars-delete-dropdown__actions">
              <button
                type="button"
                className="lcars-delete-dropdown__cancel"
                onClick={() => setOpen(false)}
                disabled={phase === 'running'}
              >
                CANCEL
              </button>
              <button
                type="button"
                className={
                  'lcars-delete-dropdown__primary' +
                  (phase === 'armed' ? ' lcars-delete-dropdown__primary--armed' : '')
                }
                onClick={primaryClick}
                disabled={selected.size === 0 || phase === 'running'}
              >
                {buttonLabel}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
