import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * v2 spec §8 / decision D12: Repo-grounding endpoint for the
 * corrective-prompt flow.
 *
 * Returns `{ gitStatus, gitDiff, fileContents }` for a target repo,
 * plus a coarse `repoOk` boolean so the frontend can decide whether
 * the prompt-generation flow should proceed or surface a "can't
 * ground" error per spec §8 ("Validation failure handling").
 *
 * Scope guarantees per D12:
 *   - `git status` + `git diff` are run via `git -C <repoPath>`.
 *   - `fileContents` is populated only for paths explicitly named
 *     in `namedFiles[]`. NO filesystem walk; NO globs; NO symlink
 *     traversal beyond what `readFile` honors.
 *   - Each named file is resolved to an absolute path inside the
 *     target repo and rejected if it escapes via `..`. A 4MB cap
 *     per file keeps a runaway include from ballooning the response.
 */
export const prerender = false;

const REQUIRED_HEADER = 'chat-arch-repo-ground';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_NAMED_FILES = 12;
const MAX_DIFF_BYTES = 256 * 1024;

const execFileP = promisify(execFile);

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

/** Resolve repo root the same way rescan.ts does — for the default target. */
function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

interface RepoGroundRequest {
  repoPath?: string;
  namedFiles?: readonly string[];
}

interface RepoGroundResponse {
  ok: boolean;
  repoPath: string;
  repoOk: boolean;
  gitStatus: string | null;
  gitDiff: string | null;
  fileContents: Record<string, string>;
  errors: readonly string[];
}

async function runGit(repoPath: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', repoPath, ...args], {
      maxBuffer: MAX_DIFF_BYTES * 2,
      windowsHide: true,
    });
    return stdout.length > MAX_DIFF_BYTES
      ? '… (truncated) …\n' + stdout.slice(-MAX_DIFF_BYTES)
      : stdout;
  } catch {
    return null;
  }
}

async function readNamed(
  repoPath: string,
  rel: string,
): Promise<{ content?: string; error?: string }> {
  // Path-traversal guard: resolve under repoPath and reject if it
  // walks above. Absolute named paths are rejected outright.
  // The startsWith check is NOT sufficient on its own — given
  // repoPath = `/foo/chat-arch`, the path `../chat-arch-secret/x`
  // resolves to `/foo/chat-arch-secret/x`, which startsWith
  // `/foo/chat-arch` returns true (sibling-prefix attack).
  // Use `path.relative()` + a `..` / absolute check instead.
  if (isAbsolute(rel)) return { error: 'absolute paths are not allowed' };
  const abs = resolve(repoPath, rel);
  const rootAbs = resolve(repoPath);
  const rel2 = relative(rootAbs, abs);
  if (
    rel2.startsWith('..') ||
    isAbsolute(rel2) ||
    rel2.split(sep).includes('..')
  ) {
    return { error: 'path escapes repo root' };
  }
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { error: 'not a regular file' };
    if (st.size > MAX_FILE_BYTES) return { error: `file > ${MAX_FILE_BYTES} bytes` };
    return { content: await readFile(abs, 'utf8') };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  let body: RepoGroundRequest;
  try {
    body = (await request.json()) as RepoGroundRequest;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const repoPath = (body.repoPath && body.repoPath.trim().length > 0
    ? body.repoPath
    : defaultRepoRoot()
  ).trim();

  const namedFiles = Array.isArray(body.namedFiles) ? body.namedFiles.slice(0, MAX_NAMED_FILES) : [];

  const errors: string[] = [];
  let repoOk = true;

  // Probe the repo with `git rev-parse --is-inside-work-tree`. A non-
  // git directory is a hard fail per spec §8 — we surface the error
  // and skip the diff calls.
  const probe = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!probe || probe.trim() !== 'true') {
    repoOk = false;
    errors.push(`not a git repo: ${repoPath}`);
  }

  const [gitStatus, gitDiff] = repoOk
    ? await Promise.all([
        runGit(repoPath, ['status', '--porcelain=v1']),
        runGit(repoPath, ['diff', '--no-color']),
      ])
    : [null, null];

  const fileContents: Record<string, string> = {};
  for (const rel of namedFiles) {
    if (typeof rel !== 'string' || rel.length === 0) {
      errors.push(`skipped non-string named file`);
      continue;
    }
    const r = await readNamed(repoPath, rel);
    if (r.content !== undefined) {
      fileContents[rel] = r.content;
    } else {
      errors.push(`failed to read ${rel}: ${r.error ?? 'unknown error'}`);
    }
  }

  const payload: RepoGroundResponse = {
    ok: repoOk,
    repoPath,
    repoOk,
    gitStatus,
    gitDiff,
    fileContents,
    errors,
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
