import { useEffect, useRef } from 'react';
import type { LogEntry, LogSeverity } from '../data/activityLog.js';

/**
 * Slide-in panel on the right edge of the viewport that shows a live
 * log of what the system is doing: uploads, embed-worker milestones,
 * per-phase progress, per-label classifications, errors. The user can
 * close it (hide) or reopen it via the toggle button in the TopBar.
 *
 * Rendering strategy: a plain scrollable list. For the typical run
 * (< 500 entries, capped by the ring buffer) there's no need to
 * virtualize. The list auto-scrolls to the newest entry when the
 * caller is at the bottom of the scroll position; if the user has
 * scrolled up to read older entries, we leave the scroll alone so
 * the panel doesn't steal their place.
 *
 * Accessibility: the panel is a `dialog` with `aria-label`; the list
 * is a `log` landmark with `aria-live="polite"` so screen readers
 * can pick up new entries without interrupting the user's flow. The
 * close button is keyboard-focusable; pressing Escape also closes.
 */

export interface ActivityLogPanelProps {
  entries: readonly LogEntry[];
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function severityGlyph(s: LogSeverity): string {
  switch (s) {
    case 'error':
      return '!';
    case 'warn':
      return '⚠';
    case 'info':
      return '•';
    case 'debug':
      return '·';
  }
}

export function ActivityLogPanel({
  entries,
  isOpen,
  onOpen,
  onClose,
  onClear,
}: ActivityLogPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);

  // Auto-scroll on new entries, but only when the user is already
  // at/near the bottom. If they've scrolled up to read history, don't
  // yank their position out from under them.
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries, isOpen]);

  // Escape closes the panel when it has focus or any descendant does.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    // 12px slack so a hair's-breadth scroll-up doesn't unstick us.
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 12;
    stickToBottomRef.current = atBottom;
  };

  // Closed state: render a slim always-visible edge tab on the right of
  // the viewport so the user can re-open the panel without hunting for
  // the TopBar LOG button. Standard slide-out drawer pattern — the tab
  // is small enough to ignore but unmistakable when sought. Shows the
  // entry count when there are entries the user hasn't necessarily seen
  // (since the panel is closed), so a busy run that completed in the
  // background still telegraphs "there's something to look at here".
  if (!isOpen) {
    return (
      <button
        type="button"
        className="lcars-activity-log-tab"
        onClick={onOpen}
        aria-label={
          entries.length > 0
            ? `open activity log (${entries.length} entries)`
            : 'open activity log'
        }
        title="Open activity log"
      >
        <span className="lcars-activity-log-tab__label">ACTIVITY&nbsp;LOG</span>
        {entries.length > 0 && (
          <span className="lcars-activity-log-tab__count">{entries.length}</span>
        )}
      </button>
    );
  }

  return (
    <aside
      className="lcars-activity-log"
      role="dialog"
      aria-label="system activity log"
    >
      <header className="lcars-activity-log__header">
        <h2 className="lcars-activity-log__title">ACTIVITY LOG</h2>
        <div className="lcars-activity-log__actions">
          <button
            type="button"
            className="lcars-activity-log__action"
            onClick={onClear}
            aria-label="clear activity log"
            title="Clear all log entries"
            disabled={entries.length === 0}
          >
            CLEAR
          </button>
          <button
            type="button"
            className="lcars-activity-log__close"
            onClick={onClose}
            aria-label="close activity log"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </header>
      <div
        ref={listRef}
        className="lcars-activity-log__list"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={handleScroll}
      >
        {entries.length === 0 ? (
          <p className="lcars-activity-log__empty">
            No activity yet. Upload a ZIP, scan local, or click
            <br />
            ANALYZE TOPICS to start generating log events.
          </p>
        ) : (
          entries.map((e) => (
            <div
              key={e.id}
              className={`lcars-activity-log__entry lcars-activity-log__entry--${e.severity}`}
            >
              <span
                className="lcars-activity-log__time"
                title={new Date(e.timestamp).toISOString()}
              >
                {formatTime(e.timestamp)}
              </span>
              <span
                className="lcars-activity-log__glyph"
                aria-hidden="true"
              >
                {severityGlyph(e.severity)}
              </span>
              <span className="lcars-activity-log__source">{e.source.toUpperCase()}</span>
              <span className="lcars-activity-log__message">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
