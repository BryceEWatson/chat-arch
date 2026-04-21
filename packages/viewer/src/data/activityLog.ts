import { useCallback, useRef, useState } from 'react';

/**
 * In-app activity log for the viewer. Captures user-visible actions
 * and background-process milestones so the user can see what the
 * system is doing without opening DevTools. Lives entirely in memory
 * (no IDB) — it's a session-scoped diagnostic, not an audit trail.
 *
 * Design choices:
 *
 *   - Ring buffer capped at 500 entries to keep React re-renders
 *     bounded on long semantic-analysis runs (~3000 chunks + their
 *     label emissions would otherwise fill memory linearly).
 *
 *   - Severity + source are separate axes so a future filter UI can
 *     say "show me only errors from the worker" or "only user actions"
 *     without re-parsing the free-text message.
 *
 *   - IDs are monotonic integers assigned at log time, used as React
 *     keys for the list — avoids using array index (which would
 *     cause re-render glitches as the ring buffer rotates).
 */

export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';

/** Where this entry came from. Used for display grouping + filtering. */
export type LogSource =
  | 'system'
  | 'user'
  | 'upload'
  | 'worker'
  | 'classify'
  | 'discover'
  // Manifest fetch / merge composition. Populated by ChatArchViewer as
  // it resolves which sessions end up in the active view.
  | 'manifest';

export interface LogEntry {
  /** Monotonic id assigned at log time; stable across the entry's lifetime in the ring. */
  id: number;
  /** ms-since-epoch, captured when the entry was appended. */
  timestamp: number;
  severity: LogSeverity;
  source: LogSource;
  message: string;
}

export interface LogFn {
  (severity: LogSeverity, source: LogSource, message: string): void;
}

export interface ActivityLogHandle {
  entries: readonly LogEntry[];
  log: LogFn;
  clear: () => void;
}

const MAX_ENTRIES = 500;

/**
 * React hook wrapping the in-memory ring buffer. `log` is stable
 * across renders (useCallback with empty deps) so consumers can thread
 * it through event handlers / classification options without busting
 * memoization downstream.
 */
export function useActivityLog(): ActivityLogHandle {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  // ID counter lives on a ref so log() doesn't re-render the world
  // just to increment it.
  const nextIdRef = useRef<number>(0);

  const log = useCallback<LogFn>((severity, source, message) => {
    setEntries((prev) => {
      const id = nextIdRef.current++;
      const entry: LogEntry = {
        id,
        timestamp: Date.now(),
        severity,
        source,
        message,
      };
      if (prev.length >= MAX_ENTRIES) {
        // Drop oldest. Using slice+push keeps React's referential
        // identity logic happy (new array, new reference).
        return [...prev.slice(1), entry];
      }
      return [...prev, entry];
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    // Keep nextIdRef ticking — resetting it would let a future ring
    // rotation reuse ids of no-longer-present entries, confusing any
    // external watcher that keyed on id.
  }, []);

  return { entries, log, clear };
}
