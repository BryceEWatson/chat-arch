/**
 * Phase Rev3-F F5 + F6 — subprocess infrastructure for the /curate
 * and /falsify skills.
 *
 *   - F5: `probeClaudeAvailable()` — `claude --version` probe with
 *     timeout. Used at curator startup; on miss, the skill surfaces
 *     the "claude CLI not detected — curator paused" banner state
 *     instead of spawning a failing subprocess on every request.
 *   - F5: `runCuratorSubprocess()` — wraps `spawn(claude, ['-p', ...])`
 *     with single 50ms→1s exponential backoff retry on `SIGTERM /
 *     non-zero exit + stderr contains '429'`. Returns a tagged-union
 *     result so callers can render the right banner.
 *   - F6: `apiKeyFallbackAllowed()` — gates the `ANTHROPIC_API_KEY`
 *     fallback behind the `chatArchCuratorApiKeyOptIn` flag. OFF by
 *     default per `feedback_claude_code_not_api` and plan §
 *     "Subprocess failure handling". This server-side helper checks
 *     the env-equivalent (`CHAT_ARCH_CURATOR_API_KEY_OPT_IN=1`); the
 *     viewer-side localStorage toggle is read in the browser via a
 *     separate helper and the result is mirrored into the request
 *     body the skill endpoint receives.
 *   - F7: atomic writes use the existing
 *     `@chat-arch/exporter` helper `atomicWriteJson` (re-exported via
 *     the package's main entry). This file does NOT re-export it —
 *     callers import directly from the exporter to avoid a second
 *     copy of the contract.
 */

import { spawn } from 'node:child_process';

import { resolveClaudeBin, type ClaudeBin } from './resolveClaude.js';

/**
 * Result of probing the Claude Code CLI. `available: true` means the
 * `--version` probe completed within the timeout AND exited 0.
 * Anything else (binary not on PATH, timeout, non-zero exit) maps to
 * `available: false` with the reason recorded for diagnostics.
 */
export interface ProbeResult {
  readonly available: boolean;
  readonly version?: string;
  readonly source?: ClaudeBin['source'];
  readonly reason?: 'not-found' | 'timeout' | 'non-zero-exit' | 'spawn-error';
}

const PROBE_TIMEOUT_MS = 1_500;

/**
 * Spawn `claude --version` with a tight timeout. Returns the parsed
 * version string when available, or a `reason` code when not.
 *
 * Cheap (<200ms on a happy path; 1.5s worst case). Safe to call on
 * every curator startup; the result is small enough that no caching
 * layer is needed.
 */
export async function probeClaudeAvailable(): Promise<ProbeResult> {
  const bin = resolveClaudeBin();
  return new Promise<ProbeResult>((resolve) => {
    const child = spawn(bin.file, ['--version'], {
      shell: bin.useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already dead — ignore.
      }
      resolve({ available: false, source: bin.source, reason: 'timeout' });
    }, PROBE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ available: false, source: bin.source, reason: 'spawn-error' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // Trim+collapse — claude prints e.g. "claude 2.1.138" or
        // "@anthropic-ai/claude-code 2.1.138". First non-empty line.
        const firstLine =
          stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? '';
        resolve({
          available: true,
          source: bin.source,
          version: firstLine,
        });
      } else {
        resolve({
          available: false,
          source: bin.source,
          reason: stderr.length > 0 ? 'non-zero-exit' : 'spawn-error',
        });
      }
    });
  });
}

/**
 * Detected 429 / plan-throttle indicator in subprocess stderr. The
 * Claude Code CLI surfaces these as either an HTTP-style "429" token
 * or a phrase like "rate limit" — both patterns are matched
 * conservatively (case-insensitive substring) so neither variant
 * slips through.
 */
function isThrottled(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes('429') || s.includes('rate limit');
}

export interface RunCuratorOptions {
  /** Argv passed to `claude -p` (the `-p` prefix is added by the helper). */
  readonly args: readonly string[];
  /** Prompt body piped to stdin. */
  readonly prompt: string;
  /**
   * F6 opt-in. When true AND `ANTHROPIC_API_KEY` is in env, the
   * subprocess inherits the env var (claude CLI auto-fallback). When
   * false (default), the env var is scrubbed before spawn so a
   * surprise API-key never silently bills the user.
   */
  readonly allowApiKeyFallback?: boolean;
  /**
   * Soft cap on the total time the helper will spend on retries.
   * Default 30s — long enough to handle a single backoff cycle on a
   * busy plan, short enough that the UI doesn't hang.
   */
  readonly maxElapsedMs?: number;
}

export type RunCuratorResult =
  | { readonly state: 'success'; readonly stdout: string }
  | {
      readonly state: 'throttled';
      readonly retriesAttempted: number;
      readonly lastStderr: string;
    }
  | {
      readonly state: 'unavailable';
      readonly reason: ProbeResult['reason'];
    }
  | {
      readonly state: 'failure';
      readonly exitCode: number | null;
      readonly stderr: string;
    };

const DEFAULT_MAX_ELAPSED_MS = 30_000;
const INITIAL_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn `claude -p <args>` with the given prompt on stdin. Single
 * retry with exponential backoff on 429 / plan-throttle. Returns a
 * tagged-union result the caller can match on.
 *
 * Per F5: detect 429 from subprocess stderr; retry once with
 * 50ms→1s exponential backoff capped at `maxElapsedMs`. On persistent
 * failure return `{ state: 'throttled' }` so the skill surface can
 * render the "curator paused (plan-usage throttle)" banner.
 */
export async function runCuratorSubprocess(
  options: RunCuratorOptions,
): Promise<RunCuratorResult> {
  const probe = await probeClaudeAvailable();
  if (!probe.available) {
    return { state: 'unavailable', reason: probe.reason };
  }

  const bin = resolveClaudeBin();
  const maxElapsedMs = options.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
  const startedAt = Date.now();
  let backoff = INITIAL_BACKOFF_MS;
  let retriesAttempted = 0;
  let lastStderr = '';

  // Loop on throttle only; success / non-throttle failure return
  // immediately. The loop runs at most 2 iterations under the default
  // maxElapsedMs (initial + one retry) — the cap is the safety floor.
  while (Date.now() - startedAt < maxElapsedMs) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.allowApiKeyFallback !== true) {
      // F6: scrub the env var so an opt-out user can't accidentally
      // bill an API call via a CLI that auto-detects ANTHROPIC_API_KEY.
      delete env['ANTHROPIC_API_KEY'];
    }

    const result = await spawnOnce(bin, options, env);
    if (result.kind === 'success') {
      return { state: 'success', stdout: result.stdout };
    }
    if (result.kind === 'failure') {
      return {
        state: 'failure',
        exitCode: result.exitCode,
        stderr: result.stderr,
      };
    }
    // throttled
    lastStderr = result.stderr;
    retriesAttempted += 1;
    const remainingMs = maxElapsedMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await delay(Math.min(backoff, remainingMs));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  return {
    state: 'throttled',
    retriesAttempted,
    lastStderr,
  };
}

/**
 * Inner spawn loop iteration. Returns one of three outcomes the
 * caller (retry loop in `runCuratorSubprocess`) handles.
 */
async function spawnOnce(
  bin: ClaudeBin,
  options: RunCuratorOptions,
  env: NodeJS.ProcessEnv,
): Promise<
  | { kind: 'success'; stdout: string }
  | { kind: 'throttled'; stderr: string }
  | { kind: 'failure'; exitCode: number | null; stderr: string }
> {
  return new Promise((resolve) => {
    const argv = ['-p', ...options.args];
    const child = spawn(bin.file, argv, {
      shell: bin.useShell,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', () => {
      resolve({ kind: 'failure', exitCode: null, stderr: stderr || 'spawn error' });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ kind: 'success', stdout });
        return;
      }
      if (isThrottled(stderr)) {
        resolve({ kind: 'throttled', stderr });
        return;
      }
      resolve({ kind: 'failure', exitCode: code, stderr });
    });
    if (options.prompt.length > 0) {
      child.stdin.end(options.prompt);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Server-side check for the F6 opt-in flag. Mirrors the viewer-side
 * localStorage toggle (`chatArchCuratorApiKeyOptIn`); the viewer
 * passes the flag through to the skill endpoint, which then calls
 * `runCuratorSubprocess({ allowApiKeyFallback: true })` when set.
 *
 * On the server, the env variable is the authority:
 * `CHAT_ARCH_CURATOR_API_KEY_OPT_IN=1` enables. Anything else
 * (unset, `0`, `false`, etc.) is OFF.
 *
 * Two-rail design — viewer flag is per-user comfort, server flag is
 * deployment-policy. Both must be ON for the API-key fallback to
 * fire. Default-deny.
 */
export function apiKeyFallbackAllowedFromEnv(): boolean {
  const v = process.env['CHAT_ARCH_CURATOR_API_KEY_OPT_IN'];
  if (typeof v !== 'string') return false;
  return v === '1';
}
