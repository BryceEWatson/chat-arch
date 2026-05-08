import type { APIRoute } from 'astro';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Wipe the correction-mining pipeline's output files so the user can
 * re-mine from scratch. Scope is deliberately narrow:
 *
 *   - `analysis/corrections.json` — the pattern output (deleted)
 *   - `analysis/correction-status-*.json` — orphan status files from
 *     prior runs (deleted)
 *   - `analysis/_correction-target-ids-*.json` — orphan target-id
 *     files written by the API endpoint when a run started (deleted)
 *
 * NOT touched:
 *   - `analysis/correction-candidates.json` — the exporter's heuristic
 *     recall output. That is mining INPUT, not output, and regenerating
 *     it requires re-running the exporter. Wiping it would leave the
 *     user with nothing to mine.
 *   - Any other analysis file (duplicates, narratives, projects, etc.).
 *
 * CSRF posture matches `/api/clear` and `/api/mine-corrections`:
 *   1. Origin parses to a local-only hostname.
 *   2. Custom `X-Requested-With: chat-arch-clear-corrections` header.
 *
 * Static-build deploys without this endpoint return 404; the panel hides
 * the clear button when the GET probe fails.
 */
export const prerender = false;

const REQUIRED_HEADER = 'chat-arch-clear-corrections';
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

/** apps/standalone/src/pages/api/clear-corrections.ts → apps/standalone/public/chat-arch-data/analysis/ */
function analysisDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'public', 'chat-arch-data', 'analysis');
}

/**
 * Identify a file as belonging to the mining pipeline's writable set.
 * Conservative on purpose — anything not matching is left alone so a
 * misconfigured deploy can't accidentally wipe sibling analysis output.
 */
function isMiningArtifact(name: string): boolean {
  if (name === 'corrections.json') return true;
  if (name.startsWith('correction-status-') && name.endsWith('.json')) return true;
  if (name.startsWith('_correction-target-ids-') && name.endsWith('.json')) return true;
  return false;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  const dir = analysisDir();
  const removed: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Dir doesn't exist → nothing to clear; that's not a failure.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response(JSON.stringify({ ok: true, removed: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  await Promise.all(
    entries.map(async (e) => {
      if (!e.isFile()) return;
      if (!isMiningArtifact(e.name)) return;
      try {
        await rm(join(dir, e.name), { force: true });
        removed.push(e.name);
      } catch {
        // Best-effort: if one file is locked we still report the rest.
      }
    }),
  );

  return new Response(JSON.stringify({ ok: true, removed }), {
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
