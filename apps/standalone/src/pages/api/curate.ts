/**
 * `/api/curate` — POST drives the `/curate` skill via `claude -p` so the
 * PRACTICE surface's CuratorFeed has a producer the UI can trigger. The
 * skill itself reads the SQLite substrate, ranks tier-2/tier-3 narratives
 * + knowledge-debt + applied-pattern watcher items, and writes
 * `analysis/curator-feed.json` (Rev3-F F1 scaffold; F3 + F4 land the
 * ranker + falsifier wiring).
 *
 * Shape mirrors `/api/mine-decisions.ts` (the simpler of the two
 * skill-spawn endpoints — no auto-window, no candidate-id sidecar). CSRF
 * + in-flight + NDJSON streaming match `mine-corrections.ts` exactly.
 *
 * One real deviation from the mine-* siblings: we gate spawn behind
 * `probeClaudeAvailable()`. The skills are slow (1-3 min) so paying a
 * <200ms probe up front to short-circuit a missing-CLI session with a
 * clean 503 beats letting the spawn fail opaquely two minutes in.
 */

import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from '../../lib/resolveClaude.js';
import { probeClaudeAvailable } from '../../lib/curatorClaude.js';
import {
  assertDataDirContained,
  handleDataDirGuardError,
} from '../../lib/dataDirGuard.js';

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-curate';
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

/**
 * Serializes concurrent curator runs. Two parallel passes would race to
 * write `curator-feed.json`; concurrent callers get 409. `inFlightRequestId`
 * lets the GET probe surface the active run's id so a page reload can
 * attach to it instead of failing closed (same shape as mine-corrections).
 */
let inFlight: Promise<void> | null = null;
let inFlightRequestId: string | null = null;

const MAX_LINE_CHARS = 2_000;
const MAX_TAIL_BYTES = 8 * 1024;
const DEFAULT_DATA_DIR = 'apps/standalone/public/chat-arch-data';
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

function tailBytes(text: string, max = MAX_TAIL_BYTES): string {
  if (text.length <= max) return text;
  return '… (truncated) …\n' + text.slice(-max);
}

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS - 12) + '… (truncated)';
}

/**
 * Repo root from this file's location — same arithmetic as rescan /
 * mine-corrections / mine-decisions:
 *
 *   apps/standalone/src/pages/api/curate.ts   (this file)
 *   ..\..\..\..\..                            (five up = repo root)
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

interface CurateBody {
  dataDir?: unknown;
  /** Top-K items to surface in the feed. Clamped to [1, MAX_TOP_K]. */
  topK?: unknown;
  /** When true, skip Stage 2 falsifier pass — findings tagged `'skipped-by-user'`. */
  noFalsifier?: unknown;
  /** F6 viewer-side opt-in for API-key fallback. Forwarded verbatim to the skill;
   *  the skill ANDs it with the server-side env flag. */
  apiKeyFallback?: unknown;
}

interface CurateParams {
  requestId: string;
  dataDir: string;
  topK: number;
  noFalsifier: boolean;
  apiKeyFallback: boolean;
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

/**
 * Spawn `claude -p /curate ...` and stream stdio over the NDJSON
 * response. Same machinery as mine-decisions; the skill is a scaffold
 * today (Rev3-F F1) so no fallback prompt — the F3+F4 PRs will exercise
 * the real pipeline against this endpoint.
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
    // Pre-authorize the tools the curator needs. Whitelist (not full
    // bypass) keeps the spawn under per-tool scrutiny: only Read /
    // Write / Edit / Bash / Task (sub-agent) / Glob / Grep are usable.
    // Risk is bounded by this endpoint's CSRF gate + the skill's
    // dataDir-scoped write surface (curator-feed.json + status file).
    const allowedTools = 'Read Write Edit Bash Task Glob Grep';
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
        // Skill stages log `[N/4] stage-name:` markers per SKILL.md;
        // surface them as phase events so the UI can render progress
        // without parsing every stdout line.
        const m = /\[(\d+)\/(\d+)\]\s+(\w[\w-]*)\s*:/.exec(line);
        if (m) {
          send({
            type: 'phase',
            phase: m[3],
            ix: Number(m[1]),
            total: Number(m[2]),
          });
        }
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

async function streamCurate(
  params: CurateParams,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const started = Date.now();
  const { requestId, dataDir, topK, noFalsifier, apiKeyFallback } = params;
  const flags: string[] = [
    `--request-id=${requestId}`,
    `--data-dir=${dataDir}`,
    `--top-k=${topK}`,
  ];
  if (noFalsifier) flags.push('--no-falsifier');
  if (apiKeyFallback) flags.push('--api-key-fallback');
  const prompt = `/curate ${flags.join(' ')}`;

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
    topK,
    noFalsifier,
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
        error: 'A curator run is already in progress. Wait for it to finish (1-3 min).',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  // Probe `claude --version` up front. Curator runs are 1-3 min; failing
  // fast with a clean 503 beats a two-minute spawn that ends in a cryptic
  // ENOENT. Per `feedback_claude_code_not_api` the answer to "claude
  // missing" is NOT to silently fall back to the API key — that's the
  // F6 opt-in path, gated by viewer + server flags inside the skill.
  const probe = await probeClaudeAvailable();
  if (!probe.available) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          'claude CLI not detected on this host. The curator runs as a `claude -p` subprocess (plan-billed); install Claude Code or set CLAUDE_BIN to a working binary, then retry.',
        reason: probe.reason ?? 'not-found',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }

  let body: CurateBody = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') body = parsed as CurateBody;
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

  let topK = DEFAULT_TOP_K;
  if (typeof body.topK === 'number' && Number.isFinite(body.topK) && body.topK >= 1) {
    topK = Math.min(Math.floor(body.topK), MAX_TOP_K);
  }
  const noFalsifier = body.noFalsifier === true;
  const apiKeyFallback = body.apiKeyFallback === true;

  const params: CurateParams = {
    requestId: randomUUID(),
    dataDir,
    topK,
    noFalsifier,
    apiKeyFallback,
  };

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
        await streamCurate(params, controller, encoder);
      } finally {
        inFlight = null;
        inFlightRequestId = null;
        done?.();
      }
    },
    cancel() {
      // client disconnected; CLI keeps running and writes to disk
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

/**
 * Readiness probe. The viewer pings this on mount to decide whether to
 * surface the CURATE button (`available`) and whether a run is already
 * in flight (`busy`). Production static builds have no GET; the viewer
 * treats fetch failure as `available: false`.
 */
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
