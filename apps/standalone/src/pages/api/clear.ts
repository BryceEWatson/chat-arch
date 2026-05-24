import type { APIRoute } from 'astro';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ALL_SOURCES,
  type SourceName,
  wipeAll,
  wipeSources,
} from '../../lib/clearDataDir.js';
import {
  closeChatArchDb,
  wipeSqliteDbFiles,
} from '../../lib/chatArchDb.js';

/**
 * Selective-delete endpoint — the UI dropdown posts one or more source
 * names (`cli-direct`, `cli-desktop`, `cowork`, `cloud`) and we wipe
 * exactly those sources. POSTing with an empty body (or `{ sources:
 * null }`) is the "kitchen sink" mode: wipe everything under
 * `apps/standalone/public/chat-arch-data/` except the `.gitkeep`.
 *
 * CSRF posture mirrors `/api/rescan`:
 *   - Origin must parse to a local-only hostname (browsers always send
 *     Origin on POST, so a missing Origin is also rejected).
 *   - Custom `X-Requested-With: chat-arch-clear` header — an attacker
 *     page can't set this via a simple form submission.
 *
 * Partial-delete semantics:
 *   - Load `manifest.json`, filter out sessions whose `source` is in
 *     the selected set, re-compute `counts`, write the filtered
 *     manifest back.
 *   - For each filtered-out session with a `transcriptPath`, delete
 *     the transcript file on disk.
 *   - Always delete `analysis/*.json` — those are derived from the
 *     manifest and are stale the moment any session is removed. They
 *     get regenerated on the next rescan.
 *   - If `cloud` was in the deletion set, also remove the
 *     `cloud-conversations/` directory wholesale and the `.demo`
 *     sentinel (demo data is cloud-rooted; clearing cloud breaks the
 *     "this is the demo corpus" assumption).
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

  // Parse optional JSON body. An empty/missing body means "wipe all".
  let body: { sources?: unknown } = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as { sources?: unknown };
    }
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Body must be valid JSON' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Validate `sources`: optional string[] subset of ALL_SOURCES.
  let selected: Set<SourceName> | null = null;
  if (Array.isArray(body.sources)) {
    const bad: string[] = [];
    const out = new Set<SourceName>();
    for (const s of body.sources) {
      if (typeof s !== 'string') {
        bad.push(String(s));
        continue;
      }
      if ((ALL_SOURCES as readonly string[]).includes(s)) {
        out.add(s as SourceName);
      } else {
        bad.push(s);
      }
    }
    if (bad.length > 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Unknown source name(s): ${bad.join(', ')}. Valid: ${ALL_SOURCES.join(', ')}`,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    selected = out;
  }

  const dir = dataDir();

  try {
    // Kitchen-sink mode: no body, empty list, or all four sources → wipe everything.
    // Inlined (rather than bound to a `shouldWipeAll` local) so TypeScript can
    // narrow `selected` to non-null through the OR chain on the `wipeSources`
    // call below. Extracting the boolean loses that narrowing and the
    // follow-up `wipeSources(dir, selected)` then fails with
    // "Set<…> | null not assignable to Set<…>".
    // Rev3-C C4 iter-2: the SQLite DB lives at a SIBLING of
    // `public/chat-arch-data/` (security fix — Astro serves
    // `public/` verbatim). Both wipe modes need to extend the
    // orphan-sweep (Rev3-A.A9) to the new substrate: close the
    // cached handle first so the OS releases the file, then unlink
    // the `.db` + `.db-wal` + `.db-shm` siblings. Doing this BEFORE
    // the JSON-sidecar wipe keeps the failure mode "DB partially
    // wiped, sidecars intact" rather than "sidecars gone, ledger
    // still references deleted entities."
    closeChatArchDb();
    const dbSweep = await wipeSqliteDbFiles();

    if (selected === null || selected.size === 0 || selected.size === ALL_SOURCES.length) {
      const { removed } = await wipeAll(dir);
      return new Response(
        JSON.stringify({
          ok: true,
          mode: 'all',
          removed: removed + dbSweep.removed,
          bySources: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    const { removed, bySources } = await wipeSources(dir, selected);
    return new Response(
      JSON.stringify({
        ok: true,
        mode: 'partial',
        removed: removed + dbSweep.removed,
        bySources,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};

/**
 * Mirror of rescan's GET probe — the UI calls this on mount to decide
 * whether to show the delete button. Static-build deploys without this
 * endpoint get a 404 and the button stays hidden.
 */
export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
