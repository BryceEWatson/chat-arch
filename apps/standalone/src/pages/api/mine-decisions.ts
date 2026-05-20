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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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
    const isWin = process.platform === 'win32';
    let child: ReturnType<typeof spawn>;
    if (isWin) {
      const cmdLine =
        `claude.cmd --allowedTools ${JSON.stringify(allowedTools)} ` +
        `-p ${JSON.stringify(prompt)}`;
      child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
        cwd: repoRoot(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      child = spawn(
        'claude',
        ['--allowedTools', allowedTools, '-p', prompt],
        {
          cwd: repoRoot(),
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    }

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
    ? '\nspawn error: ' + (outcome.spawnError.message ?? String(outcome.spawnError))
    : '';

  send({
    type: 'done',
    ok: outcome.exitCode === 0 && outcome.spawnError === null,
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
  const dataDir =
    typeof body.dataDir === 'string' && body.dataDir.trim().length > 0
      ? body.dataDir
      : DEFAULT_DATA_DIR;

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
