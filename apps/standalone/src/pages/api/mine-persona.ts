import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from '../../lib/resolveClaude.js';
import {
  assertDataDirContained,
  handleDataDirGuardError,
} from '../../lib/dataDirGuard.js';

/**
 * NDJSON-streaming endpoint that drives the `/mine-persona` skill.
 * Shape mirrors `/api/mine-corrections` line-for-line — same CSRF
 * posture, same inFlight serializer, same fallback-prompt path when
 * the `/slash` form isn't recognized.
 *
 * SCAN chain step 5. Reads `analysis/persona-candidates.json`
 * (Stage 1, written by the exporter), dispatches per-project
 * sub-agents that synthesize each persona, writes
 * `analysis/personas.json` (index) + `analysis/personas/<project-id>.md`
 * (per-project markdown).
 */
export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-mine-persona';
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

const SLASH_UNSUPPORTED_MARKERS = ['unknown command', 'command not found', 'no such command'];

function looksLikeSlashUnsupported(stdout: string, stderr: string): boolean {
  const haystack = (stdout + '\n' + stderr).toLowerCase();
  return SLASH_UNSUPPORTED_MARKERS.some((m) => haystack.includes(m));
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

export interface PersonaOutcomeProbe {
  /** `generatedAt` from a `personas.json` on disk, or null. */
  personasGeneratedAt: number | null;
  /** `status` from a `persona-status-<requestId>.json` file, or null. */
  statusFileStatus: string | null;
  /** `error` from the same status file (set when status is `error`), or null. */
  statusFileError: string | null;
}

export interface PersonaMiningVerdict {
  ok: boolean;
  reason: string | null;
}

/**
 * Same shape as the mine-corrections endpoint: CLI exit code alone
 * isn't a reliable success signal — the skill can hit a `cap-and-ask`
 * branch in headless mode, print, and exit 0 without writing. Require
 * a fresh `personas.json` on disk before reporting success.
 */
export function classifyOutcome(
  startedAt: number,
  exitCode: number | null,
  spawnError: Error | null,
  probe: PersonaOutcomeProbe,
): PersonaMiningVerdict {
  if (spawnError !== null) {
    return { ok: false, reason: `spawn error: ${spawnError.message}` };
  }
  if (exitCode !== 0) {
    return { ok: false, reason: `claude CLI exited with code ${exitCode}` };
  }
  if (probe.statusFileStatus === 'error') {
    const msg = probe.statusFileError ?? '(no message in status file)';
    return { ok: false, reason: `skill reported error: ${msg}` };
  }
  if (
    probe.personasGeneratedAt === null ||
    probe.personasGeneratedAt < startedAt
  ) {
    const detail =
      probe.statusFileStatus !== null
        ? ` (last skill status: ${probe.statusFileStatus})`
        : ' (no skill status file written — skill likely aborted before initializing)';
    return {
      ok: false,
      reason:
        `skill exited cleanly but did not write a fresh personas.json${detail}. ` +
        `This is the "silent abort" failure mode.`,
    };
  }
  return { ok: true, reason: null };
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function probeOutcome(
  rootAbs: string,
  dataDir: string,
  requestId: string,
): Promise<PersonaOutcomeProbe> {
  const dataDirAbs = resolve(rootAbs, dataDir);
  const personas = await readJsonOrNull<{ generatedAt?: unknown }>(
    join(dataDirAbs, 'analysis', 'personas.json'),
  );
  const status = await readJsonOrNull<{
    status?: unknown;
    error?: unknown;
  }>(join(dataDirAbs, 'analysis', `persona-status-${requestId}.json`));
  return {
    personasGeneratedAt:
      typeof personas?.generatedAt === 'number' ? personas.generatedAt : null,
    statusFileStatus:
      typeof status?.status === 'string' ? status.status : null,
    statusFileError:
      typeof status?.error === 'string' ? status.error : null,
  };
}

interface PersonaParams {
  requestId: string;
  dataDir: string;
  /** Optional single-project override — when present, the skill mines only
   *  that project. Surfaced through the PERSONAS page's REGEN PERSONA button. */
  projectId: string | null;
}

const DEFAULT_DATA_DIR = 'apps/standalone/public/chat-arch-data';

interface MineRequestBody {
  dataDir?: unknown;
  projectId?: unknown;
}

function parseParams(body: MineRequestBody): PersonaParams {
  const rawDir = body.dataDir;
  const candidate =
    typeof rawDir === 'string' && rawDir.trim().length > 0
      ? rawDir
      : DEFAULT_DATA_DIR;
  const dataDir = assertDataDirContained(candidate, repoRoot());

  const projectId =
    typeof body.projectId === 'string' && body.projectId.trim().length > 0
      ? body.projectId.trim()
      : null;

  return {
    requestId: randomUUID(),
    dataDir,
    projectId,
  };
}

function runClaudeOnce(
  prompt: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<SpawnOutcome> {
  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // Already closed.
    }
  };

  return new Promise<SpawnOutcome>((resolvePromise) => {
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
        stdoutBuf = '';
      }
      if (stderrBuf.trim().length > 0) {
        send({ type: 'stderr', line: clampLine(stderrBuf.trim()) });
        stderrFull.v += stderrBuf;
        stderrBuf = '';
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

async function streamMinePersona(
  params: PersonaParams,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const started = Date.now();
  const { requestId, dataDir, projectId } = params;
  const projectArg = projectId !== null ? ` --project-id=${projectId}` : '';
  const argSuffix = `--request-id=${requestId} --data-dir=${dataDir}${projectArg}`;
  const slashPrompt = `/mine-persona ${argSuffix}`;
  const fallbackPrompt =
    `Read .claude/skills/mine-persona/SKILL.md and execute it with these arguments: ${argSuffix}`;

  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // Already closed.
    }
  };

  send({
    type: 'start',
    command: `claude -p "${slashPrompt}"`,
    requestId,
    startedAt: started,
    projectId,
  });

  let outcome = await runClaudeOnce(slashPrompt, controller, encoder);
  let usedFallback = false;

  const slashLooksUnsupported =
    outcome.exitCode !== 0 && looksLikeSlashUnsupported(outcome.stdout, outcome.stderr);

  if (slashLooksUnsupported) {
    usedFallback = true;
    send({ type: 'phase', phase: 'fallback-prompt' });
    const second = await runClaudeOnce(fallbackPrompt, controller, encoder);
    outcome = {
      exitCode: second.exitCode,
      stdout: outcome.stdout + second.stdout,
      stderr: outcome.stderr + second.stderr,
      spawnError: second.spawnError ?? outcome.spawnError,
    };
  }

  const extraStderr = outcome.spawnError
    ? '\nspawn error: ' + (outcome.spawnError.message ?? String(outcome.spawnError))
    : '';

  const probe = await probeOutcome(repoRoot(), dataDir, requestId);
  const verdict = classifyOutcome(
    started,
    outcome.exitCode,
    outcome.spawnError,
    probe,
  );
  const verdictNote = verdict.reason !== null ? '\n[outcome] ' + verdict.reason : '';

  send({
    type: 'done',
    ok: verdict.ok,
    exitCode: outcome.exitCode,
    durationMs: Date.now() - started,
    requestId,
    usedFallback,
    stdoutTail: tailBytes(outcome.stdout),
    stderrTail: tailBytes(outcome.stderr + extraStderr + verdictNote),
    command: usedFallback
      ? `claude -p "${fallbackPrompt}"`
      : `claude -p "${slashPrompt}"`,
  });

  try {
    controller.close();
  } catch {
    // Already closed.
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  let body: MineRequestBody = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        body = parsed as MineRequestBody;
      }
    }
  } catch {
    body = {};
  }

  if (inFlight) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'A persona-mining run is already in progress. Wait for it to finish.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  let params: PersonaParams;
  try {
    params = parseParams(body);
  } catch (e) {
    const r = handleDataDirGuardError(e);
    if (r) return r;
    throw e;
  }

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
        await streamMinePersona(params, controller, encoder);
      } finally {
        inFlight = null;
        inFlightRequestId = null;
        done?.();
      }
    },
    cancel() {
      // Client disconnected; CLI keeps running.
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
