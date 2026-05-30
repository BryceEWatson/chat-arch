/**
 * Wave 6 #3a — minimal client for `POST /api/mine-decisions`.
 *
 * Server emits NDJSON over a streamed Response — we drain it to the
 * `done` event and surface the final outcome to the caller. (We don't
 * need progress streaming for the v1 stub skill; a `MINING…` button
 * label is enough.) Mirrors `mineCorrectionsClient.ts`'s simpler
 * helpers without dragging in the full auto-window machinery.
 */

const MINE_DECISIONS_PATH = '/api/mine-decisions';
const REQUIRED_HEADER_VALUE = 'chat-arch-mine-decisions';
const CLEAR_DECISIONS_PATH = '/api/clear-decisions';
const CLEAR_HEADER_VALUE = 'chat-arch-clear-decisions';

/**
 * Shape of `analysis/decision-status-${requestId}.json` — written by the
 * `/mine-decisions` skill on every stage transition. Mirrors
 * `CorrectionRunStatus`. The viewer polls this for live progress while a
 * run is in flight.
 */
export interface DecisionRunStatus {
  requestId: string;
  status: 'starting' | 'classifying' | 'clustering' | 'writing' | 'complete' | 'error';
  progress?: { phase?: string; current?: number; total?: number };
  startedAt?: number;
  updatedAt?: number;
  log?: readonly string[];
  error?: string;
}

/**
 * Wave 7 P2 #7 — selectable mining batch size. `5` / `20` cap the run
 * at N candidates; `'all'` removes the cap (the server still applies
 * its per-run budget guard). Default is `5` — keeps the LLM cost
 * predictable on first click.
 */
export type MineDecisionsBatch = 5 | 20 | 'all';

export interface MineDecisionsResult {
  ok: boolean;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
  /** Network / parse error surfaced as a string. */
  error?: string;
}

export interface MineDecisionsStartOpts {
  dataDir?: string;
  /** Per-candidate cap. Defaults to 5. */
  batch?: MineDecisionsBatch;
  /**
   * Called whenever the server emits a `decision-done` (or generic
   * `progress`) NDJSON event so the UI can render row-by-row progress.
   * The argument is the cumulative count of classified candidates.
   */
  onProgress?: (cumulativeCount: number) => void;
  /**
   * Called once with the run's `requestId` when the server emits its
   * `start` event — lets the caller poll
   * `analysis/decision-status-${requestId}.json` for live progress.
   */
  onStart?: (requestId: string) => void;
}

interface DoneEvent {
  type: 'done';
  ok: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

interface ProgressEvent {
  type: 'progress' | 'decision-done';
  count?: number;
}

interface StartEvent {
  type: 'start';
  requestId?: string;
}

function isStart(obj: unknown): obj is StartEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as { type?: unknown }).type === 'start'
  );
}

function isDone(obj: unknown): obj is DoneEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as { type?: unknown }).type === 'done'
  );
}

function isProgress(obj: unknown): obj is ProgressEvent {
  if (typeof obj !== 'object' || obj === null) return false;
  const t = (obj as { type?: unknown }).type;
  return t === 'progress' || t === 'decision-done';
}

/**
 * Probe the endpoint. Returns true when present (dev server), false
 * for the hosted static build.
 */
export async function probeMineDecisions(): Promise<boolean> {
  try {
    const res = await fetch(MINE_DECISIONS_PATH, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Kick off the mine-decisions skill and drain the NDJSON stream to the
 * final `done` event. Returns a small summary the caller can render.
 *
 * Note: the v1 mine-decisions skill is a stub that exits non-zero with
 * a "not yet implemented" message — that message comes back in the
 * stderrTail so the UI can show it verbatim.
 */
export async function startMineDecisions(
  opts: MineDecisionsStartOpts = {},
): Promise<MineDecisionsResult> {
  const { onProgress, batch, dataDir } = opts;
  const body: Record<string, unknown> = {};
  if (dataDir !== undefined) body.dataDir = dataDir;
  if (batch !== undefined) body.batch = batch;
  let res: Response;
  try {
    res = await fetch(MINE_DECISIONS_PATH, {
      method: 'POST',
      headers: {
        'X-Requested-With': REQUIRED_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 409) {
    return { ok: false, error: 'mine-decisions is already running' };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `mine-decisions endpoint returned ${res.status}: ${text}`,
    };
  }
  if (res.body === null) {
    return { ok: false, error: 'mine-decisions returned empty body' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final: DoneEvent | null = null;
  let progressCount = 0;
  // Drain until the server closes; collect the last `done` event and
  // forward incremental progress events to the caller (#7 streams the
  // table row-by-row).
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const obj = JSON.parse(line) as unknown;
          if (isDone(obj)) {
            final = obj;
          } else if (isStart(obj)) {
            if (typeof obj.requestId === 'string') opts.onStart?.(obj.requestId);
          } else if (isProgress(obj)) {
            progressCount =
              typeof obj.count === 'number' && Number.isFinite(obj.count)
                ? obj.count
                : progressCount + 1;
            onProgress?.(progressCount);
          }
        } catch {
          // ignore parse errors on partial lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (final === null) {
    return { ok: false, error: 'mine-decisions stream closed without a done event' };
  }
  return {
    ok: final.ok,
    exitCode: final.exitCode,
    stdoutTail: final.stdoutTail,
    stderrTail: final.stderrTail,
  };
}

/**
 * Fetch `analysis/decision-status-${requestId}.json` once. Returns null
 * on 404 / network / parse failure — callers poll on an interval and
 * treat absence as "skill hasn't flushed status yet". Mirrors
 * `fetchCorrectionRunStatus`.
 */
export async function fetchDecisionRunStatus(
  dataDirBaseUrl: string,
  requestId: string,
): Promise<DecisionRunStatus | null> {
  const root = dataDirBaseUrl.endsWith('/') ? dataDirBaseUrl.slice(0, -1) : dataDirBaseUrl;
  const url = `${root}/analysis/decision-status-${requestId}.json`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return (await res.json()) as DecisionRunStatus;
  } catch {
    return null;
  }
}

/**
 * POST `/api/clear-decisions`. Resets `classification` +
 * `trustCalibration` in decisions.json (preserving candidates) and
 * deletes the cluster/status sidecars, so the user can re-mine without
 * re-running the exporter. Returns the deleted filenames + how many rows
 * were reset.
 */
export async function clearDecisions(
  signal?: AbortSignal,
): Promise<{ removed: string[]; reset: number }> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'X-Requested-With': CLEAR_HEADER_VALUE },
  };
  if (signal !== undefined) init.signal = signal;
  const res = await fetch(CLEAR_DECISIONS_PATH, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`clear-decisions failed (status ${res.status}): ${text}`);
  }
  const body = (await res.json()) as { ok: boolean; removed?: string[]; reset?: number };
  return { removed: body.removed ?? [], reset: body.reset ?? 0 };
}

/**
 * GET `/api/clear-decisions` — readiness probe. False when the endpoint
 * is absent (static build).
 */
export async function probeClearDecisions(): Promise<boolean> {
  try {
    const res = await fetch(CLEAR_DECISIONS_PATH, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
