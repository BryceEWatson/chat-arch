/**
 * Client for `POST /api/mine-narratives` (narrative-mining V1, SCAN
 * chain step 6). Surface mirrors `mineDecisionsClient.ts` — the same
 * NDJSON-drain + 409-busy + structured-error shape so UI surfaces can
 * render a consistent `MINING` / `BUSY` / error state across the four
 * mining endpoints (corrections / decisions / persona / narratives).
 *
 * Per-project REGEN: the PROJECTS detail surface fires this on click
 * of the per-project REGEN NARRATIVES button. The endpoint enforces
 * a tighter `projectId` regex than the persona endpoint AND a
 * manifest-membership check against `analysis/projects.json` — both
 * 400 paths surface here as an error string.
 */

const MINE_NARRATIVES_PATH = '/api/mine-narratives';
const REQUIRED_HEADER_VALUE = 'chat-arch-mine-narratives';

export interface MineNarrativesResult {
  ok: boolean;
  exitCode?: number | null;
  stdoutTail?: string;
  stderrTail?: string;
  /** Network / parse error surfaced as a string. */
  error?: string;
}

export interface MineNarrativesStartOpts {
  /** When set, mine only this project (per-project REGEN). */
  projectId?: string;
  dataDir?: string;
  /**
   * Called whenever the server emits a `phase` NDJSON event so the UI
   * can advance an in-flight indicator. The argument is the phase name
   * the server reported (e.g. `'bucketing'`, `'synthesizing'`,
   * `'writing'`).
   */
  onPhase?: (phase: string) => void;
}

interface DoneEvent {
  type: 'done';
  ok: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
}

interface PhaseEvent {
  type: 'phase';
  phase?: string;
}

function isDone(obj: unknown): obj is DoneEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as { type?: unknown }).type === 'done'
  );
}

function isPhase(obj: unknown): obj is PhaseEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as { type?: unknown }).type === 'phase'
  );
}

/**
 * Probe the endpoint. Returns true when present (dev server), false
 * for the hosted static build.
 */
export async function probeMineNarratives(): Promise<boolean> {
  try {
    const res = await fetch(MINE_NARRATIVES_PATH, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Kick off the mine-narratives skill and drain the NDJSON stream to
 * the final `done` event. Returns a small summary the caller can
 * render (or surface an error string for the 409 / 400 / network
 * paths).
 */
export async function startMineNarratives(
  opts: MineNarrativesStartOpts = {},
): Promise<MineNarrativesResult> {
  const { onPhase, projectId, dataDir } = opts;
  const body: Record<string, unknown> = {};
  if (projectId !== undefined) body.projectId = projectId;
  if (dataDir !== undefined) body.dataDir = dataDir;
  let res: Response;
  try {
    res = await fetch(MINE_NARRATIVES_PATH, {
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
    return { ok: false, error: 'mine-narratives is already running' };
  }
  if (res.status === 400) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `mine-narratives rejected request: ${text || 'projectId failed sanitization or membership check'}`,
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `mine-narratives endpoint returned ${res.status}: ${text}`,
    };
  }
  if (res.body === null) {
    return { ok: false, error: 'mine-narratives returned empty body' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final: DoneEvent | null = null;
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
          } else if (isPhase(obj) && typeof obj.phase === 'string') {
            onPhase?.(obj.phase);
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
    return {
      ok: false,
      error: 'mine-narratives stream closed without a done event',
    };
  }
  return {
    ok: final.ok,
    exitCode: final.exitCode,
    stdoutTail: final.stdoutTail,
    stderrTail: final.stderrTail,
  };
}
