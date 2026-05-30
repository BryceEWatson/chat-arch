/**
 * Wave 6 #3a — `/api/mine-decisions` endpoint.
 *
 * Mirrors `/api/mine-corrections.ts` for the decisions pipeline: shells
 * out to `claude -p /mine-decisions` so the user can classify the
 * heuristic-recall decision candidates produced by the analysis writer.
 *
 * For the v1 cut the underlying skill is a stub — the endpoint exists
 * so the UI affordance (the `MINE DECISIONS` button in DecisionsMode)
 * is live. The skill's TODO body returns a "not yet implemented"
 * notice that this endpoint surfaces verbatim via the NDJSON stderr
 * stream so the user sees a real reason rather than a silent no-op.
 *
 * CSRF posture matches mine-corrections.ts exactly.
 */

import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from '../../lib/resolveClaude.js';
import { assertDataDirContained, handleDataDirGuardError } from '../../lib/dataDirGuard.js';
import { translateSpawnError } from '../../lib/spawnDiagnostics.js';

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-mine-decisions';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

function csrfReject(reason: string): Response {
  return new Response(JSON.stringify({ ok: false, error: `Forbidden: ${reason}` }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

let inFlight: Promise<void> | null = null;
let inFlightRequestId: string | null = null;

/**
 * True while a `/mine-decisions` run is streaming. Exported so
 * `/api/clear-decisions` can refuse to rewrite `decisions.json` out from
 * under a mid-flight skill write (mirrors the mine-narratives /
 * clear-narratives in-flight handshake).
 */
export function isMineDecisionsInFlight(): boolean {
  return inFlight !== null;
}

const MAX_LINE_CHARS = 2_000;
const MAX_TAIL_BYTES = 8 * 1024;
const DEFAULT_DATA_DIR = 'apps/standalone/public/chat-arch-data';

function tailBytes(text: string, max = MAX_TAIL_BYTES): string {
  if (text.length <= max) return text;
  return '… (truncated) …\n' + text.slice(-max);
}

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS - 12) + '… (truncated)';
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

interface MineDecisionsBody {
  dataDir?: unknown;
  /** Wave 7 P2 #7 — per-candidate cap. Accepts a positive integer or the literal "all". */
  batch?: unknown;
}

interface MineParams {
  requestId: string;
  dataDir: string;
  /** Resolved batch — number (clamped) or null for "all". */
  batch: number | null;
}

const DEFAULT_BATCH = 5;
const MAX_BATCH = 200;

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

/**
 * Spawn `claude -p /mine-decisions ...` and stream its stdio over the
 * NDJSON response. Same machinery as mine-corrections; trimmed to the
 * minimum because the v1 skill is a stub (no fallback prompt needed).
 */
function runClaudeOnce(
  prompt: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<SpawnOutcome> {
  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // controller already closed
    }
  };
  return new Promise<SpawnOutcome>((resolvePromise) => {
    const allowedTools = 'Read Write Edit Bash Task Glob Grep';
    // resolveClaudeBin handles the broken-npm-shim case (see
    // src/lib/resolveClaude.ts) — required on Windows machines where
    // the auto-updater rotated claude.exe to `.old.<ts>` and left the
    // bin/ directory without a current binary.
    const bin = resolveClaudeBin();
    const args = ['--allowedTools', allowedTools, '-p', prompt];
    const child = spawn(bin.file, args, {
      cwd: repoRoot(),
      env: process.env,
      shell: bin.useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    const stdoutFull = { v: '' };
    const stderrFull = { v: '' };
    let spawnError: Error | null = null;

    const drain = (
      buf: string,
      chunk: string,
      kind: 'stdout' | 'stderr',
      full: { v: string },
    ): string => {
      full.v += chunk;
      const combined = buf + chunk;
      const parts = combined.split('\n');
      const lastFragment = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (line.length === 0) continue;
        send({ type: kind, line: clampLine(line) });
      }
      return lastFragment;
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf = drain(stdoutBuf, chunk.toString('utf8'), 'stdout', stdoutFull);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf = drain(stderrBuf, chunk.toString('utf8'), 'stderr', stderrFull);
    });
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      if (stdoutBuf.trim().length > 0) {
        send({ type: 'stdout', line: clampLine(stdoutBuf.trim()) });
        stdoutFull.v += stdoutBuf;
      }
      if (stderrBuf.trim().length > 0) {
        send({ type: 'stderr', line: clampLine(stderrBuf.trim()) });
        stderrFull.v += stderrBuf;
      }
      resolvePromise({
        exitCode: code,
        stdout: stdoutFull.v,
        stderr: stderrFull.v,
        spawnError,
      });
    });
  });
}

/**
 * Decide whether a mine run actually succeeded, rather than trusting the
 * exit code alone (a `claude -p` wrapper can exit 0 having done nothing,
 * or exit non-zero on a benign teardown). Mirrors mine-corrections'
 * outcome probe: the skill's `decision-status-${requestId}.json` is
 * authoritative when present; otherwise fall back to "decisions.json was
 * rewritten after we started" + a clean exit.
 */
async function probeOutcome(
  dataDir: string,
  requestId: string,
  startedAt: number,
  exitCode: number | null,
  spawnError: Error | null,
): Promise<boolean> {
  if (spawnError !== null) return false;
  const analysisDir = join(resolve(repoRoot(), dataDir), 'analysis');
  // 1. Status file is authoritative when the skill wrote it.
  try {
    const raw = await readFile(join(analysisDir, `decision-status-${requestId}.json`), 'utf8');
    const status = (JSON.parse(raw) as { status?: unknown }).status;
    if (status === 'complete') return true;
    if (status === 'error') return false;
  } catch {
    // no status file — fall through
  }
  // 2. Fallback: decisions.json bumped its generatedAt past our start AND
  //    the process exited cleanly (the skill rewrites the file on a
  //    non-empty classification run).
  try {
    const raw = await readFile(join(analysisDir, 'decisions.json'), 'utf8');
    const gen = (JSON.parse(raw) as { generatedAt?: unknown }).generatedAt;
    if (exitCode === 0 && typeof gen === 'number' && gen >= startedAt) return true;
  } catch {
    // no decisions file — fall through
  }
  // 3. Last resort: trust a clean exit (e.g. a legitimate no-op run with
  //    an empty work set that exited 0 without a status file).
  return exitCode === 0;
}

async function streamMineDecisions(
  params: MineParams,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const started = Date.now();
  const { requestId, dataDir, batch } = params;
  const batchArg = batch === null ? '--batch=all' : `--batch=${batch}`;
  const argSuffix = `--request-id=${requestId} --data-dir=${dataDir} ${batchArg}`;
  const prompt = `/mine-decisions ${argSuffix}`;

  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // closed
    }
  };

  send({
    type: 'start',
    command: `claude -p "${prompt}"`,
    requestId,
    startedAt: started,
  });

  const outcome = await runClaudeOnce(prompt, controller, encoder);
  const extraStderr = outcome.spawnError
    ? '\nspawn error: ' + translateSpawnError(outcome.spawnError)
    : '';

  const ok = await probeOutcome(
    dataDir,
    requestId,
    started,
    outcome.exitCode,
    outcome.spawnError,
  );

  send({
    type: 'done',
    ok,
    exitCode: outcome.exitCode,
    durationMs: Date.now() - started,
    requestId,
    stdoutTail: tailBytes(outcome.stdout),
    stderrTail: tailBytes(outcome.stderr + extraStderr),
    command: `claude -p "${prompt}"`,
  });

  try {
    controller.close();
  } catch {
    // closed
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }
  if (inFlight) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'A decision-mining run is already in progress. Wait for it to finish.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  let body: MineDecisionsBody = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') body = parsed as MineDecisionsBody;
    }
  } catch {
    body = {};
  }
  const candidate =
    typeof body.dataDir === 'string' && body.dataDir.trim().length > 0
      ? body.dataDir
      : DEFAULT_DATA_DIR;
  let dataDir: string;
  try {
    dataDir = assertDataDirContained(candidate, repoRoot()); // (S1)
  } catch (e) {
    const r = handleDataDirGuardError(e); // (XN2)
    if (r) return r;
    throw e;
  }

  let batch: number | null = DEFAULT_BATCH;
  if (typeof body.batch === 'string') {
    if (body.batch === 'all') {
      batch = null;
    } else {
      const n = Number(body.batch);
      if (Number.isFinite(n) && n >= 1) {
        batch = Math.min(Math.floor(n), MAX_BATCH);
      }
    }
  } else if (typeof body.batch === 'number' && Number.isFinite(body.batch)) {
    if (body.batch >= 1) batch = Math.min(Math.floor(body.batch), MAX_BATCH);
  }

  const params: MineParams = { requestId: randomUUID(), dataDir, batch };

  const encoder = new TextEncoder();
  let done: (() => void) | null = null;
  const completed = new Promise<void>((res) => {
    done = res;
  });
  inFlight = completed.then(() => undefined);
  inFlightRequestId = params.requestId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await streamMineDecisions(params, controller, encoder);
      } finally {
        inFlight = null;
        inFlightRequestId = null;
        done?.();
      }
    },
    cancel() {
      // client disconnected; CLI keeps running
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
};

export const GET: APIRoute = () => {
  return new Response(
    JSON.stringify({
      ok: true,
      available: true,
      busy: inFlight !== null,
      busyRequestId: inFlightRequestId,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  );
};
