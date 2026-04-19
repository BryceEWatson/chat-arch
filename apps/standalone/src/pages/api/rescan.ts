import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Opt this route into server rendering. The rest of the site is static
 * (see `astro.config.mjs`). Only this endpoint runs at request time.
 *
 * Deployments that don't want this endpoint can delete the file; the
 * static build is unaffected.
 */
export const prerender = false;

/**
 * CSRF gate. The rescan endpoint spawns the exporter against the user's
 * filesystem, so an unauthenticated POST from any cross-origin page in
 * the same browser is a genuine attack surface.
 *
 * Two stacked checks, both must pass:
 *   1. `Origin` must parse to a hostname in the local-only allow-list.
 *      Browsers always send Origin on POST, so a missing Origin is also
 *      rejected.
 *   2. `X-Requested-With: chat-arch-rescan` — a custom header that an
 *      attacker page cannot set on a simple form submission and that
 *      cannot be smuggled via `<img>`/`<a>`/etc.
 *
 * The viewer's `useRescan()` hook sends both. Anything that doesn't
 * (curl one-liner, hostile <form>, DNS-rebinding probe) gets 403.
 */
const REQUIRED_HEADER = 'chat-arch-rescan';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalOrigin(origin: string | null): boolean {
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
 * Serializes concurrent rescans. Spawning the exporter twice in
 * parallel would race to write `manifest.json` and is never what the
 * user wants, so we hold a single in-flight promise and return `409`
 * to concurrent callers.
 */
let inFlight: Promise<void> | null = null;

/** Cap per-event line length so a single runaway log doesn't bloat the stream. */
const MAX_LINE_CHARS = 2_000;
const MAX_TAIL_BYTES = 8 * 1024;

/** Keep only the last N bytes so huge log dumps don't balloon the `done` event. */
function tailBytes(text: string, max = MAX_TAIL_BYTES): string {
  if (text.length <= max) return text;
  return '… (truncated) …\n' + text.slice(-max);
}

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS - 12) + '… (truncated)';
}

/**
 * Resolve the repo root from this file's location. `fileURLToPath` is
 * used so we don't depend on Astro passing us a cwd (it doesn't).
 *
 *   apps/standalone/src/pages/api/rescan.ts    (this file)
 *   apps/standalone/                           (repo-relative)
 *   ..\..\..\..                                (four levels up = repo root)
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

/**
 * Stream the exporter as NDJSON over a single long-lived response.
 *
 * Event kinds the client handles:
 *   { type: 'start',  command, startedAt }
 *   { type: 'stdout', line }     // one per non-empty stdout line
 *   { type: 'stderr', line }     // one per non-empty stderr line
 *   { type: 'phase',  phase, ix, total }  // detected `[N/3] phase:` milestones
 *   { type: 'done',   ok, exitCode, durationMs, stdoutTail, stderrTail }
 *
 * Using NDJSON (one JSON object per `\n`-terminated line) rather than
 * SSE because (a) we don't need auto-reconnect and (b) it lets the
 * browser read the body via the standard Response.body ReadableStream
 * without an EventSource dependency.
 */
function streamExporter(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const started = Date.now();
  // Prefer `pnpm --filter` over resolving the bin path ourselves — it
  // handles workspace linking and avoids a stale dist/ problem if the
  // user rebuilt packages in a sibling worktree. `--silent` drops
  // pnpm's own banner from stdout so the exporter's logger lines read
  // clean back in the browser.
  const cmd = 'pnpm';
  // `--no-cloud` skips the cloud phase. Cloud data only updates when
  // the user uploads a fresh ZIP (either via the viewer's UPLOAD
  // panel, or by running `chat-arch cloud` manually against a new
  // ZIP in ~/Downloads). Rescanning local disks shouldn't require a
  // fresh cloud ZIP to be on hand; the existing cloud-manifest.json
  // is preserved in the merge.
  const args = ['--silent', '--filter', '@chat-arch/exporter', 'start', 'all', '--no-cloud'];
  const commandLine = `${cmd} ${args.join(' ')}`;

  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // Controller may already be closed if the client disconnected.
    }
  };

  send({ type: 'start', command: commandLine, startedAt: started });

  return new Promise<void>((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot(),
      env: process.env,
      // shell: true on Windows so `pnpm.cmd` resolves without us
      // hardcoding the extension.
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let stdoutBuf = '';
    let stderrBuf = '';

    /**
     * Drain a chunk-buffer into per-line events, keeping the trailing
     * unterminated fragment for the next chunk. Mutates `buf` via
     * return and also appends to the full-output accumulator so the
     * final `done` event can carry stable tails.
     */
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
        // Detect `[N/total] phase:` milestones on BOTH streams — the
        // exporter's logger writes `info` calls to stderr (so that
        // stdout can stay reserved for machine-readable output), so
        // restricting detection to stdout missed every phase marker
        // in practice.
        const m = /\[(\d+)\/(\d+)\]\s+(\w[\w-]*)\s*:/.exec(line);
        if (m) {
          send({
            type: 'phase',
            phase: m[3],
            ix: Number(m[1]),
            total: Number(m[2]),
          });
        } else if (/\banalysis complete\b/i.test(line)) {
          // Phase 6 analysis phase — the exporter logs this after
          // the merge write, so it's the final pre-`done` milestone.
          send({ type: 'phase', phase: 'analysis', ix: 0, total: 0 });
        }
      }
      return lastFragment;
    };

    const stdoutFull = { v: '' };
    const stderrFull = { v: '' };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf = drain(stdoutBuf, chunk.toString('utf8'), 'stdout', stdoutFull);
      stdout = stdoutFull.v;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf = drain(stderrBuf, chunk.toString('utf8'), 'stderr', stderrFull);
      stderr = stderrFull.v;
    });

    const finish = (ok: boolean, exitCode: number | null, extraStderr = '') => {
      if (stdoutBuf.trim().length > 0) {
        send({ type: 'stdout', line: clampLine(stdoutBuf.trim()) });
      }
      if (stderrBuf.trim().length > 0) {
        send({ type: 'stderr', line: clampLine(stderrBuf.trim()) });
      }
      send({
        type: 'done',
        ok,
        exitCode,
        durationMs: Date.now() - started,
        stdoutTail: tailBytes(stdout),
        stderrTail: tailBytes(stderr + extraStderr),
        command: commandLine,
      });
      try {
        controller.close();
      } catch {
        // Already closed by a client disconnect — ignore.
      }
      resolvePromise();
    };

    child.on('error', (err) => {
      finish(false, null, '\nspawn error: ' + (err.message ?? String(err)));
    });
    child.on('close', (code) => {
      finish(code === 0, code);
    });
  });
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
        error: 'A rescan is already in progress. Wait for it to finish.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  let done: (() => void) | null = null;
  const completed = new Promise<void>((res) => {
    done = res;
  });
  inFlight = completed.then(() => undefined);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await streamExporter(controller, encoder);
      } finally {
        inFlight = null;
        done?.();
      }
    },
    cancel() {
      // Client disconnected; exporter keeps running (it's the local
      // user, they'll see the result on the next probe). The promise
      // chain above still resolves when `close` fires.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      // Tell intermediaries (dev proxy, browser) not to buffer — the
      // whole point is real-time.
      'x-accel-buffering': 'no',
    },
  });
};

/**
 * Small readiness/probe endpoint. The UI calls this on mount so it
 * knows whether to show the RESCAN button — which only makes sense
 * when a dev server is running, since the production static build has
 * no backend to spawn processes.
 */
export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true, busy: inFlight !== null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
