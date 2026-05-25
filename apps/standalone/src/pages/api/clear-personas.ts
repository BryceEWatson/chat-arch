import type { APIRoute } from 'astro';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Wipe the persona-mining pipeline's output files so the user can
 * re-mine from scratch. Scope mirrors `/api/clear-corrections`:
 *
 *   - `analysis/personas.json` — the index (deleted)
 *   - `analysis/persona-status-*.json` — orphan status files from
 *     prior runs (deleted)
 *   - `analysis/personas/*.md` — per-project markdown personas
 *     (deleted; directory itself preserved)
 *
 * NOT touched:
 *   - `analysis/persona-candidates.json` — the exporter's Stage-1
 *     output. That is mining INPUT, not output, and regenerating
 *     it requires re-running the exporter.
 *   - Any other analysis file.
 *
 * CSRF posture matches `/api/clear-corrections`:
 *   1. Origin parses to a local-only hostname.
 *   2. Custom `X-Requested-With: chat-arch-clear-personas` header.
 *
 * Static-build deploys without this endpoint return 404; the panel
 * hides the clear button when the GET probe fails.
 */
export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-clear-personas';
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

/** apps/standalone/src/pages/api/clear-personas.ts → apps/standalone/public/chat-arch-data/analysis/ */
function analysisDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'public', 'chat-arch-data', 'analysis');
}

/**
 * Identify a file as belonging to the persona-mining pipeline's
 * writable set. Conservative on purpose — anything not matching is
 * left alone so a misconfigured deploy can't accidentally wipe
 * sibling analysis output.
 *
 * NOTE: this allow-list MUST stay in sync with the Stage-2 skill's
 * writes. Adding a new sidecar pattern in the skill without updating
 * this predicate leaves orphan files on disk.
 */
export function isPersonaArtifact(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.split(/[._-]/).includes('..')) return false;
  if (name === 'personas.json') return true;
  if (name.startsWith('persona-status-') && name.endsWith('.json')) return true;
  return false;
}

/**
 * Per-project markdown personas live under `analysis/personas/`.
 * Match `<project-id>.md` for any non-path-traversal id.
 */
export function isPersonaMarkdown(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.split(/[._-]/).includes('..')) return false;
  return name.endsWith('.md');
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

  // Top-level analysis/ files (personas.json + status files).
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
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
      if (!isPersonaArtifact(e.name)) return;
      try {
        await rm(join(dir, e.name), { force: true });
        removed.push(e.name);
      } catch {
        // Best-effort.
      }
    }),
  );

  // Per-project markdown files under analysis/personas/.
  const personasDir = join(dir, 'personas');
  try {
    const mdEntries = await readdir(personasDir, { withFileTypes: true });
    await Promise.all(
      mdEntries.map(async (e) => {
        if (!e.isFile()) return;
        if (!isPersonaMarkdown(e.name)) return;
        try {
          await rm(join(personasDir, e.name), { force: true });
          removed.push(join('personas', e.name));
        } catch {
          // Best-effort.
        }
      }),
    );
  } catch (err) {
    // Personas dir not yet created → nothing more to do.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ ok: false, error: msg, removed }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

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
