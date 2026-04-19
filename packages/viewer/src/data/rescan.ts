import { useCallback, useEffect, useState } from 'react';

/**
 * Hook that encapsulates the `/api/rescan` dance.
 *
 * On mount, GETs `/api/rescan` to see whether the endpoint is live.
 * The endpoint only exists when the user is running the Astro dev
 * server (per-route SSR). Production static builds don't ship it, so
 * the fetch fails → `available === false` → the caller hides the
 * RESCAN button.
 *
 * `rescan()` POSTs the same URL. The response is a streamed NDJSON
 * feed (`{type: 'start'|'stdout'|'stderr'|'phase'|'done', …}` events,
 * one per line) so the UI can show real-time progress instead of just
 * a spinner. State fields:
 *
 *   - `progress.phase` — e.g. 'cowork' | 'cli' | 'cloud' | 'analysis'
 *     (derived from the exporter's `[N/3] phase:` log lines).
 *   - `progress.ix`/`.total` — so the caller can render "2 / 3".
 *   - `progress.latest` — the most recent stdout or stderr line,
 *     useful as a live caption.
 *   - `last` — the final `{type: 'done'}` payload when the run settles.
 */

export interface RescanProgress {
  phase: string | null;
  ix: number;
  total: number;
  /** Most recent log line — used as a live caption inside the button. */
  latest: string | null;
}

export interface RescanResponse {
  ok: boolean;
  exitCode?: number | null;
  durationMs?: number;
  stdoutTail?: string;
  stderrTail?: string;
  command?: string;
  error?: string;
}

export type RescanStatus = 'idle' | 'running' | 'error' | 'ok';

export interface UseRescanResult {
  /** True when the `/api/rescan` endpoint was reachable on mount. */
  available: boolean;
  status: RescanStatus;
  progress: RescanProgress;
  /** Response payload from the most recent attempt; cleared on next run. */
  last: RescanResponse | null;
  /**
   * Trigger a rescan. Resolves to the response payload when the stream
   * finishes. A visible banner in the caller typically reads from
   * {@link UseRescanResult.last}.
   */
  rescan: () => Promise<RescanResponse | null>;
}

const RESCAN_PATH = '/api/rescan';

/** Server-side event shapes. Keep in sync with `apps/standalone/src/pages/api/rescan.ts`. */
type RescanEvent =
  | { type: 'start'; command: string; startedAt: number }
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'phase'; phase: string; ix: number; total: number }
  | ({ type: 'done' } & RescanResponse);

const INITIAL_PROGRESS: RescanProgress = {
  phase: null,
  ix: 0,
  total: 0,
  latest: null,
};

/**
 * Strip the `[chat-arch]` logger prefix off a line so progress captions
 * don't waste display real estate on boilerplate. Also drops leading
 * whitespace the logger uses for indented sub-steps.
 */
function prettyLine(raw: string): string {
  return raw.replace(/^\[chat-arch\]\s*/i, '').trim();
}

export function useRescan(): UseRescanResult {
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<RescanStatus>('idle');
  const [progress, setProgress] = useState<RescanProgress>(INITIAL_PROGRESS);
  const [last, setLast] = useState<RescanResponse | null>(null);

  // Probe once on mount. Network + 404 + HTML fallbacks all mean "not
  // available" so we keep the button hidden rather than showing it in
  // a broken state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(RESCAN_PATH, { method: 'GET' });
        if (cancelled) return;
        const ct = res.headers.get('content-type') ?? '';
        if (!res.ok || !ct.includes('application/json')) {
          setAvailable(false);
          return;
        }
        const body = (await res.json()) as { available?: boolean };
        setAvailable(body.available === true);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rescan = useCallback(async (): Promise<RescanResponse | null> => {
    if (status === 'running') return null;
    setStatus('running');
    setProgress(INITIAL_PROGRESS);
    setLast(null);

    const fail = (error: string): RescanResponse => {
      const payload: RescanResponse = { ok: false, error };
      setLast(payload);
      setStatus('error');
      return payload;
    };

    try {
      // X-Requested-With is a CSRF gate on the server side: a hostile
      // cross-origin page cannot set custom headers on a simple form
      // POST, so requiring this header rejects classic CSRF attacks.
      // Keep in sync with `apps/standalone/src/pages/api/rescan.ts`.
      const res = await fetch(RESCAN_PATH, {
        method: 'POST',
        headers: { 'X-Requested-With': 'chat-arch-rescan' },
      });
      const ct = res.headers.get('content-type') ?? '';

      // 409 (already running) + other JSON error shapes — handled before
      // we try to parse as a stream.
      if (ct.includes('application/json')) {
        const body = (await res.json()) as RescanResponse;
        setLast(body);
        setStatus(body.ok ? 'ok' : 'error');
        return body;
      }
      if (!ct.includes('application/x-ndjson')) {
        const text = await res.text();
        return fail(`Unexpected response (status ${res.status}): ${text.slice(0, 200)}`);
      }
      if (!res.body) {
        return fail('The rescan response had no body (stream not supported?).');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let terminal: RescanResponse | null = null;

      // Parse NDJSON line-by-line. Partial lines are carried in `buffer`
      // until the next chunk completes them.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const raw of parts) {
          const line = raw.trim();
          if (line.length === 0) continue;
          let event: RescanEvent;
          try {
            event = JSON.parse(line) as RescanEvent;
          } catch {
            continue; // malformed partial line — skip
          }
          if (event.type === 'stdout' || event.type === 'stderr') {
            const pretty = prettyLine(event.line);
            if (pretty.length === 0) continue;
            // Skip schema-drift WARNs from the caption — they're noise
            // that masks useful progress. ERROR lines still come
            // through so the user sees failures as they happen.
            if (/^WARN:\s+(Cowork|Desktop-CLI|CLI transcript) /i.test(pretty)) {
              continue;
            }
            setProgress((p) => ({ ...p, latest: pretty }));
          } else if (event.type === 'phase') {
            setProgress((p) => ({
              ...p,
              phase: event.phase,
              ix: event.ix,
              total: event.total,
            }));
          } else if (event.type === 'done') {
            terminal = {
              ok: event.ok,
              ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              ...(event.stdoutTail !== undefined ? { stdoutTail: event.stdoutTail } : {}),
              ...(event.stderrTail !== undefined ? { stderrTail: event.stderrTail } : {}),
              ...(event.command !== undefined ? { command: event.command } : {}),
            };
          }
        }
      }

      if (!terminal) {
        return fail('Rescan stream ended without a terminal event.');
      }
      setLast(terminal);
      setStatus(terminal.ok ? 'ok' : 'error');
      return terminal;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }, [status]);

  // After a terminal state, reset to idle so the button re-enables for
  // a second run. Longer on error (8s) than on success (3s) so the
  // failure copy stays visible long enough to read.
  useEffect(() => {
    if (status !== 'ok' && status !== 'error') return;
    const delay = status === 'error' ? 8000 : 3000;
    const id = window.setTimeout(() => setStatus('idle'), delay);
    return () => window.clearTimeout(id);
  }, [status]);

  return { available, status, progress, last, rescan };
}
