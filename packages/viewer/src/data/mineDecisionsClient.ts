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
