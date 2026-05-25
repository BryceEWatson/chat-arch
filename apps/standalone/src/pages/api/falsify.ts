/**
 * `/api/falsify` — POST drives the `/falsify` skill via `claude -p`.
 * The skill reads each candidate finding's `evidenceChain`, pulls the
 * cited session turns from the SQLite substrate, and emits a per-turn
 * `supports / neutral / contradicts` verdict aggregated against
 * `THRESHOLDS.curator.falsifierMinSupportRatio`. Writes
 * `analysis/falsifier-verdicts.json` (Rev3-F F2 scaffold; F4 lands the
 * verifier kernel).
 *
 * Sibling to `/api/curate` — same CSRF / in-flight / NDJSON streaming
 * shape; the only real difference is the skill args (input file vs
 * single finding-id) and the in-flight error copy.
 *
 * Note: the curator's Stage 2 calls /falsify in-process from inside the
 * `claude -p /curate` subprocess; this endpoint is the manual /
 * meta-validation entry point (a user spot-checking a finding, or F8
 * re-judging a held-out set).
 */

import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from '../../lib/resolveClaude.js';
import {
  AUTH_ENV_VARS,
  computeAllowApiKeyFallback,
  probeClaudeAvailable,
} from '../../lib/curatorClaude.js';
import {
  assertDataDirContained,
  handleDataDirGuardError,
} from '../../lib/dataDirGuard.js';

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-falsify';
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
// Iter-2 security finding (mirror of curate.ts): empty cancel() left
// an orphan child holding the inFlight slot for up to 10 min until the
// kill-timer fired. Track the active child so cancel() can SIGTERM it.
let inFlightChildKill: (() => void) | null = null;

const MAX_LINE_CHARS = 2_000;
const MAX_TAIL_BYTES = 8 * 1024;
const DEFAULT_DATA_DIR = 'apps/standalone/public/chat-arch-data';
/** Loose ceiling on finding-id length — UUIDs / kernel-prefixed ids are well under this. */
const MAX_FINDING_ID_CHARS = 256;
/**
 * Allowed charset for `findingId` — alphanumerics + `_`, `.`, `:`, `-`.
 * Covers UUIDs, kernel-prefixed ids (`kernel:uuid`), short hash slugs,
 * and dotted-namespace ids. Excludes whitespace, shell metacharacters
 * (`$`, `` ` ``, `;`, `|`, `&`, `<`, `>`, `(`, `)`, `\`), quotes, and
 * Unicode that could compose ambiguous flag tokens.
 *
 * Defense in depth: combined with the Windows `useShell: true`
 * fallback in `resolveClaude`, an unvalidated findingId becomes a
 * shell-injection sink. Iter-1 finding closes that gap.
 */
const FINDING_ID_CHARSET_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
/** See `curate.ts` — same kill-timeout / grace contract. */
const SPAWN_KILL_TIMEOUT_MS = 10 * 60 * 1000;
const SPAWN_KILL_GRACE_MS = 5_000;

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

interface FalsifyBody {
  dataDir?: unknown;
  /** Verify a single finding by id. Mutually exclusive with `input`. */
  findingId?: unknown;
  /** Path to a JSON file with `{ findings: [...] }`. Validated under dataDir. */
  input?: unknown;
  /** Optional output path. Defaults inside the skill to `${dataDir}/analysis/falsifier-verdicts.json`. */
  output?: unknown;
  /** F6 viewer-side opt-in for API-key fallback. Forwarded verbatim. */
  apiKeyFallback?: unknown;
}

interface FalsifyParams {
  requestId: string;
  dataDir: string;
  findingId: string | null;
  inputPath: string | null;
  outputPath: string | null;
  /** Viewer-side opt-in flag (raw body value). Surfaced to the skill. */
  apiKeyFallback: boolean;
  /**
   * Two-rail-resolved decision: viewer opt-in AND server env opt-in.
   * Default-deny — drives the AUTH_ENV_VARS scrub in `runClaudeOnce`.
   */
  allowApiKeyFallback: boolean;
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

/**
 * Spawn `claude -p /falsify ...` and stream stdio over NDJSON.
 * Sibling to `curate.ts`'s `runClaudeOnce` — same security iter-1
 * fixes apply (AUTH_ENV_VARS scrub when fallback is OFF, kill-timeout
 * escalation so a hung child doesn't permanently 409 the endpoint).
 */
function runClaudeOnce(
  prompt: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  allowApiKeyFallback: boolean,
): Promise<SpawnOutcome> {
  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // controller already closed
    }
  };
  return new Promise<SpawnOutcome>((resolvePromise) => {
    // Falsifier needs the same tool surface as the curator — Read for
    // session turns, Bash for kernel invocations, Write for verdict
    // output, Task for the K=3 self-consistency sub-agents.
    const allowedTools = 'Read Write Edit Bash Task Glob Grep';
    const bin = resolveClaudeBin();
    const args = ['--allowedTools', allowedTools, '-p', prompt];
    // Default-deny env scrub — see curate.ts for the rationale.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!allowApiKeyFallback) {
      for (const name of AUTH_ENV_VARS) {
        delete env[name];
      }
    }
    const child = spawn(bin.file, args, {
      cwd: repoRoot(),
      env,
      shell: bin.useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    inFlightChildKill = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead — ignore
      }
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    const stdoutFull = { v: '' };
    const stderrFull = { v: '' };
    let spawnError: Error | null = null;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const settleOnce = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      inFlightChildKill = null;
      resolvePromise(outcome);
    };

    killTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already dead
        }
        settleOnce({
          exitCode: null,
          stdout: stdoutFull.v,
          stderr:
            stderrFull.v +
            (stderrFull.v.length > 0 ? '\n' : '') +
            `[falsify] spawn exceeded ${SPAWN_KILL_TIMEOUT_MS}ms; SIGKILL'd.`,
          spawnError: new Error(
            `claude -p subprocess exceeded ${SPAWN_KILL_TIMEOUT_MS}ms kill-timeout`,
          ),
        });
      }, SPAWN_KILL_GRACE_MS);
    }, SPAWN_KILL_TIMEOUT_MS);

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
      settleOnce({
        exitCode: code,
        stdout: stdoutFull.v,
        stderr: stderrFull.v,
        spawnError,
      });
    });
  });
}

async function streamFalsify(
  params: FalsifyParams,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const started = Date.now();
  const {
    requestId,
    dataDir,
    findingId,
    inputPath,
    outputPath,
    apiKeyFallback,
    allowApiKeyFallback,
  } = params;
  const flags: string[] = [
    `--request-id=${requestId}`,
    `--data-dir=${dataDir}`,
  ];
  if (findingId !== null) flags.push(`--finding-id=${findingId}`);
  if (inputPath !== null) flags.push(`--input=${inputPath}`);
  if (outputPath !== null) flags.push(`--output=${outputPath}`);
  // Only forward the two-rail-resolved decision; viewer opt-in alone
  // is not enough. The env-scrub in runClaudeOnce is the load-bearing
  // enforcement.
  if (allowApiKeyFallback) flags.push('--api-key-fallback');
  const prompt = `/falsify ${flags.join(' ')}`;

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
    findingId,
    inputPath,
    apiKeyFallback,
    allowApiKeyFallback,
  });

  const outcome = await runClaudeOnce(
    prompt,
    controller,
    encoder,
    allowApiKeyFallback,
  );
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
        error: 'A falsifier run is already in progress. Wait for it to finish (1-3 min).',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  // Same up-front probe as /api/curate. The two endpoints fail fast
  // independently — operator can be missing claude on a host that still
  // has a stale curator run in flight from a different binary version,
  // so we don't share probe state.
  const probe = await probeClaudeAvailable();
  if (!probe.available) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          'claude CLI not detected on this host. The falsifier runs as a `claude -p` subprocess (plan-billed); install Claude Code or set CLAUDE_BIN to a working binary, then retry.',
        reason: probe.reason ?? 'not-found',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }

  let body: FalsifyBody = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') body = parsed as FalsifyBody;
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

  // Mutually exclusive: --finding-id verifies one finding, --input
  // batch-processes a generator's output file. Both unset is fine —
  // the skill falls back to its default input path.
  let findingId: string | null = null;
  if (typeof body.findingId === 'string' && body.findingId.trim().length > 0) {
    const v = body.findingId.trim();
    if (v.length > MAX_FINDING_ID_CHARS) {
      return new Response(
        JSON.stringify({ ok: false, error: `findingId exceeds ${MAX_FINDING_ID_CHARS} chars` }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    // Charset validation — defense-in-depth against shell-injection
    // via the Windows `useShell: true` fallback. Whitelist is
    // alphanumerics + `_`, `.`, `:`, `-` (covers all kernel-emitted
    // finding-id shapes — UUIDs, prefixed slugs, dotted namespaces);
    // rejects whitespace + shell metacharacters + quotes + Unicode.
    if (!FINDING_ID_CHARSET_RE.test(v)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Invalid findingId format' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    findingId = v;
  }

  let inputPath: string | null = null;
  if (typeof body.input === 'string' && body.input.trim().length > 0) {
    try {
      // Containment: the input file MUST live under the chat-arch-data
      // safe root. Same guard the dataDir param uses; without it a local-
      // origin caller could ask the skill to read an arbitrary repo file.
      inputPath = assertDataDirContained(body.input, repoRoot());
    } catch (e) {
      const r = handleDataDirGuardError(e);
      if (r) return r;
      throw e;
    }
  }

  let outputPath: string | null = null;
  if (typeof body.output === 'string' && body.output.trim().length > 0) {
    try {
      outputPath = assertDataDirContained(body.output, repoRoot());
    } catch (e) {
      const r = handleDataDirGuardError(e);
      if (r) return r;
      throw e;
    }
  }

  if (findingId !== null && inputPath !== null) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'findingId and input are mutually exclusive — pick one.',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const apiKeyFallback = body.apiKeyFallback === true;
  // Two-rail composition — see curate.ts. The viewer flag alone
  // never enables the fallback; the server-side env opt-in must
  // also be set. Default-deny.
  const allowApiKeyFallback = computeAllowApiKeyFallback(body.apiKeyFallback);

  const params: FalsifyParams = {
    requestId: randomUUID(),
    dataDir,
    findingId,
    inputPath,
    outputPath,
    apiKeyFallback,
    allowApiKeyFallback,
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
        await streamFalsify(params, controller, encoder);
      } finally {
        inFlight = null;
        inFlightRequestId = null;
        done?.();
      }
    },
    cancel() {
      // Iter-2 security fix: client disconnect SIGTERMs the child so
      // the inFlight slot releases promptly. Mirrors curate.ts.
      inFlightChildKill?.();
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
