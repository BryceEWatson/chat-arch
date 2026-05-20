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

export interface MineDecisionsResult {
  ok: boolean;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
  /** Network / parse error surfaced as a string. */
  error?: string;
}

interface DoneEvent {
  type: 'done';
  ok: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

function isDone(obj: unknown): obj is DoneEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as { type?: unknown }).type === 'done'
  );
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
  opts: { dataDir?: string } = {},
): Promise<MineDecisionsResult> {
  let res: Response;
  try {
    res = await fetch(MINE_DECISIONS_PATH, {
      method: 'POST',
      headers: {
        'X-Requested-With': REQUIRED_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts),
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
  // Drain until the server closes; collect the last `done` event.
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
          if (isDone(obj)) final = obj;
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
