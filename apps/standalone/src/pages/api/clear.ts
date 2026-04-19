import type { APIRoute } from 'astro';
import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

/**
 * "Nuclear reset" endpoint — wipes everything under
 * `apps/standalone/public/chat-arch-data/` except the `.gitkeep`
 * sentinel. The matching UI button surfaces a double-confirmation
 * modal before POSTing here; no accidental nukes.
 *
 * Same CSRF posture as `/api/rescan`:
 *   - Origin must parse to a local-only hostname (browsers always send
 *     Origin on POST, so a missing Origin is also rejected).
 *   - Custom `X-Requested-With: chat-arch-clear` header — an attacker
 *     page can't set this via a simple form submission.
 *
 * Deployments that don't want this endpoint can delete this file; the
 * static build is unaffected.
 */

export const prerender = false;

const REQUIRED_HEADER = 'chat-arch-clear';
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

/** apps/standalone/src/pages/api/clear.ts → apps/standalone/public/chat-arch-data/ */
function dataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'public', 'chat-arch-data');
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  const dir = dataDir();
  let removed = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (e) => {
        // Preserve the `.gitkeep` sentinel so the directory stays
        // tracked after the wipe — matches the gitignore config.
        if (e.name === '.gitkeep') return;
        await rm(join(dir, e.name), { recursive: true, force: true });
        removed += 1;
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, removed }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

/**
 * Mirror of rescan's GET probe — the UI calls this on mount to decide
 * whether to show the nuclear-reset button. Static-build deploys
 * without this endpoint get a 404 and the button stays hidden.
 */
export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
