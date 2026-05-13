/**
 * Streaming client for `POST /api/mine-corrections`. The server emits
 * NDJSON events (one JSON object per line); this generator yields each
 * parsed event as it arrives so the caller can paint progress in real
 * time without polling.
 *
 * Mirrors the `useRescan` NDJSON parser but as a plain async generator
 * so callers can compose it however they like (state machine, hook,
 * direct-await for tests).
 */

const MINE_CORRECTIONS_PATH = '/api/mine-corrections';
const CLEAR_CORRECTIONS_PATH = '/api/clear-corrections';
const REQUIRED_HEADER_VALUE = 'chat-arch-mine-corrections';
const CLEAR_HEADER_VALUE = 'chat-arch-clear-corrections';

export interface BackfillInfo {
  count: number;
  suggestedTarget: number;
  suggestedWindowDays: number;
  oldestDate: string;
}

export interface AutoWindowResult {
  windowDays: number;
  candidateCount: number;
  reasoning: string;
  mode: 'first-run' | 'incremental' | 'idle' | 'unavailable' | 'backfill' | 'all';
  patternYield: { patterns: number; classified: number; ratio: number } | null;
  backfillAvailable: BackfillInfo | null;
}

export interface MineProbe {
  ok: boolean;
  available: boolean;
  busy: boolean;
  /**
   * When `busy === true`, this is the requestId of the in-flight run
   * so the viewer can attach to its status file (`correction-status-
   * ${requestId}.json`) instead of POSTing again and getting a 409.
   * Null on legacy server versions that don't expose this yet.
   */
  busyRequestId: string | null;
  autoWindow: AutoWindowResult | null;
}

/**
 * Shape of `${dataDir}/analysis/correction-status-${requestId}.json` —
 * written by the mine-corrections skill on every stage transition (see
 * `.claude/skills/mine-corrections/SKILL.md`). The viewer polls this
 * during a run to surface mid-flight detail (phase, current/total,
 * recent log messages) that headless `claude -p` stdout doesn't expose.
 */
export interface CorrectionRunStatus {
  requestId: string;
  status:
    | 'starting'
    | 'classifying'
    | 'ingesting-configs'
    | 'embedding'
    | 'clustering'
    | 'proposing'
    | 'tagging-topics'
    | 'writing'
    | 'complete'
    | 'error';
  progress?: { phase?: string; current?: number; total?: number };
  startedAt?: number;
  updatedAt?: number;
  log?: readonly string[];
  error?: string;
}

export type MineEvent =
  | {
      type: 'start';
      command: string;
      requestId: string;
      startedAt: number;
      windowDays?: number;
      autoWindow?: AutoWindowResult | null;
    }
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'phase'; phase: string; ix?: number; total?: number }
  | {
      type: 'done';
      ok: boolean;
      exitCode: number | null;
      durationMs: number;
      stdoutTail: string;
      stderrTail: string;
      autoWindow?: AutoWindowResult | null;
    };

export interface MineCorrectionsOptions {
  /** Omit to use server-side auto-window selection. */
  windowDays?: number;
  dataDir?: string;
  /** 'recent' (default), 'backfill', or 'all' — 'all' bypasses the
   *  cost cap and processes every unprocessed candidate in one pass. */
  selection?: 'recent' | 'backfill' | 'all';
}

/**
 * Probe the endpoint for readiness AND the auto-selected window.
 * Returns null on network failure (e.g. production static build with
 * no backend) so callers can hide the MINE button gracefully.
 */
export async function probeMineCorrections(
  dataDir?: string,
  selection?: 'recent' | 'backfill' | 'all',
): Promise<MineProbe | null> {
  const params = new URLSearchParams();
  if (dataDir !== undefined && dataDir.length > 0) params.set('dataDir', dataDir);
  if (selection === 'backfill' || selection === 'all') {
    params.set('selection', selection);
  }
  const qs = params.toString();
  const url = qs.length > 0 ? `${MINE_CORRECTIONS_PATH}?${qs}` : MINE_CORRECTIONS_PATH;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    return (await res.json()) as MineProbe;
  } catch {
    return null;
  }
}

/**
 * POST `/api/clear-corrections`. Wipes the mining pipeline's output
 * (corrections.json + correction-status-*.json + orphan target-id
 * files); leaves correction-candidates.json intact so the next mine
 * has input. Returns the list of deleted filenames for display.
 *
 * Accepts an AbortSignal so the caller can enforce a timeout — the
 * server's deletion is small and bounded, but a hung connection or
 * a stalled disk would otherwise leave the UI in "Clearing…" forever.
 */
export async function clearCorrections(
  signal?: AbortSignal,
): Promise<{ removed: string[] }> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'X-Requested-With': CLEAR_HEADER_VALUE },
  };
  if (signal !== undefined) init.signal = signal;
  const res = await fetch(CLEAR_CORRECTIONS_PATH, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`clear-corrections failed (status ${res.status}): ${text}`);
  }
  const body = (await res.json()) as { ok: boolean; removed?: string[] };
  return { removed: body.removed ?? [] };
}

/**
 * GET `/api/clear-corrections` — readiness probe. Returns null when
 * the endpoint is absent (static build); the panel hides the clear
 * button in that case.
 */
export async function probeClearCorrections(): Promise<boolean> {
  try {
    const res = await fetch(CLEAR_CORRECTIONS_PATH, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch `analysis/correction-status-${requestId}.json` once. Returns
 * null on 404 / network failure / parse failure — callers poll this
 * on an interval and treat absence as "skill hasn't written it yet,"
 * which matches the bootstrap window between `start` and the first
 * status flush.
 */
export async function fetchCorrectionRunStatus(
  dataDirBaseUrl: string,
  requestId: string,
): Promise<CorrectionRunStatus | null> {
  const root = dataDirBaseUrl.endsWith('/')
    ? dataDirBaseUrl.slice(0, -1)
    : dataDirBaseUrl;
  const url = `${root}/analysis/correction-status-${requestId}.json`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return (await res.json()) as CorrectionRunStatus;
  } catch {
    return null;
  }
}

/**
 * POST `/api/mine-corrections` and yield each NDJSON event in order.
 *
 *   - Throws when the server replies with a non-2xx status (the message
 *     contains the response body so the caller can surface it).
 *   - Throws when the response has no body (e.g. environments where
 *     ReadableStream isn't available).
 *   - Silently skips malformed lines (mid-stream framing fragments).
 */
export async function* startMineCorrections(
  opts: MineCorrectionsOptions = {},
): AsyncGenerator<MineEvent> {
  const res = await fetch(MINE_CORRECTIONS_PATH, {
    method: 'POST',
    headers: {
      'X-Requested-With': REQUIRED_HEADER_VALUE,
      'content-type': 'application/json',
    },
    body: JSON.stringify(opts),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`mine-corrections failed (status ${res.status}): ${text}`);
  }
  if (!res.body) {
    throw new Error('mine-corrections response had no body (stream not supported?).');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trim();
        if (line.length === 0) continue;
        let event: MineEvent;
        try {
          event = JSON.parse(line) as MineEvent;
        } catch {
          continue;
        }
        yield event;
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      try {
        yield JSON.parse(tail) as MineEvent;
      } catch {
        // Trailing fragment without a final newline — drop it. Server
        // is expected to flush a newline after the `done` event, so a
        // dangling tail here is a pathological case, not a normal one.
      }
    }
  } finally {
    reader.releaseLock();
  }
}
