import type { APIRoute } from 'astro';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

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
const ALL_SOURCES = ['cli-direct', 'cli-desktop', 'cowork', 'cloud'] as const;
type SourceName = (typeof ALL_SOURCES)[number];

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

interface ManifestSession {
  id: string;
  source: string;
  transcriptPath?: string;
  [k: string]: unknown;
}
interface Manifest {
  schemaVersion: number;
  generatedAt: number;
  counts: Record<string, number>;
  sessions: ManifestSession[];
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const m = JSON.parse(raw) as Manifest;
    if (!m || !Array.isArray(m.sessions)) return null;
    return m;
  } catch {
    return null;
  }
}

/** Wipe the entire data dir except `.gitkeep` — kitchen-sink mode. */
async function wipeAll(dir: string): Promise<{ removed: number }> {
  const entries = await readdir(dir, { withFileTypes: true });
  let removed = 0;
  await Promise.all(
    entries.map(async (e) => {
      if (e.name === '.gitkeep') return;
      await rm(join(dir, e.name), { recursive: true, force: true });
      removed += 1;
    }),
  );
  return { removed };
}

/**
 * Delete the sessions belonging to `selected` sources, rewrite the
 * manifest without them, and drop derived state (analysis files,
 * demo sentinel if cloud is touched). Returns per-source tallies so
 * the UI can render "X sessions removed from cli-direct".
 */
async function wipeSources(
  dir: string,
  selected: Set<SourceName>,
): Promise<{ removed: number; bySources: Record<string, number> }> {
  const manifest = await readManifest(dir);
  const bySources: Record<string, number> = {};
  let fileRemovals = 0;

  if (manifest) {
    const kept: ManifestSession[] = [];
    const toDelete: ManifestSession[] = [];
    for (const s of manifest.sessions) {
      if (selected.has(s.source as SourceName)) {
        toDelete.push(s);
        bySources[s.source] = (bySources[s.source] ?? 0) + 1;
      } else {
        kept.push(s);
      }
    }

    // Unlink the transcript files belonging to removed sessions.
    await Promise.all(
      toDelete.map(async (s) => {
        if (!s.transcriptPath) return;
        // Guard: resolve against `dir` and reject any path that
        // escapes. Mirrors the path-traversal check in the exporter.
        const resolved = resolve(dir, s.transcriptPath);
        if (!resolved.startsWith(resolve(dir))) return;
        try {
          await rm(resolved, { force: true });
          fileRemovals += 1;
        } catch {
          /* best-effort — manifest rewrite is the source of truth */
        }
      }),
    );

    // Rewrite the manifest with the filtered session list and
    // recomputed counts. Touch `generatedAt` so cache-busts land.
    const counts: Record<string, number> = {
      cloud: 0,
      cowork: 0,
      'cli-direct': 0,
      'cli-desktop': 0,
    };
    for (const s of kept) counts[s.source] = (counts[s.source] ?? 0) + 1;
    const next: Manifest = {
      ...manifest,
      generatedAt: Date.now(),
      counts,
      sessions: kept,
    };
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(next, null, 2) + '\n');
  }

  // Cloud conversations live under a top-level folder — wipe the
  // whole folder when cloud is selected (in case the manifest
  // missed some orphaned JSONs).
  if (selected.has('cloud')) {
    try {
      await rm(join(dir, 'cloud-conversations'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // Demo-data sentinel is paired with a demo-seeded manifest;
    // if cloud is being pruned, the sentinel no longer reflects
    // reality and should drop.
    try {
      await rm(join(dir, '.demo'), { force: true });
    } catch {
      /* ignore */
    }
  }

  // Always wipe derived analysis files — they are a function of the
  // manifest, and any source change invalidates them.
  try {
    await rm(join(dir, 'analysis'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const removed = fileRemovals + Object.values(bySources).reduce((a, b) => a + b, 0);
  return { removed, bySources };
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
    if (selected === null || selected.size === 0 || selected.size === ALL_SOURCES.length) {
      const { removed } = await wipeAll(dir);
      return new Response(JSON.stringify({ ok: true, mode: 'all', removed, bySources: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const { removed, bySources } = await wipeSources(dir, selected);
    return new Response(JSON.stringify({ ok: true, mode: 'partial', removed, bySources }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
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
