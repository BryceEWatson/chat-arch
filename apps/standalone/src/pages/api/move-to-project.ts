/**
 * Project Identity v2 (plan §5/§6) — "Move to a different project" affordance.
 *
 * Appends a user override row to `chat-arch-data/projectOverrides.json` so the
 * next rescan re-buckets the given session(s) under `projectId` (cascade rule 0,
 * confidence 1.00). The file is consumed by `loadProjectOverrides` in
 * `@chat-arch/exporter`; it accepts a bare array of override rows, which is the
 * shape this endpoint maintains.
 *
 * Override row shape: `{ projectId, displayName?, match: { sessionIds: [...] } }`.
 *
 * Local-only: gated by the same Origin + `X-Requested-With` CSRF checks as the
 * other mutating endpoints (the hosted static build has no `/api`). Writes are
 * serialized via an in-flight gate and land atomically (tmp + rename).
 */
import type { APIRoute } from 'astro';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const prerender = false;
export const REQUIRED_HEADER = 'chat-arch-move-to-project';
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

interface OverrideRow {
  projectId: string;
  displayName?: string;
  match: { cwdGlob?: string; sessionIds?: string[] };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}
function overridesPath(): string {
  return join(repoRoot(), 'apps', 'standalone', 'public', 'chat-arch-data', 'projectOverrides.json');
}

/** Load existing overrides as a flat array (tolerates the `{overrides:[]}` envelope). */
async function loadRows(path: string): Promise<OverrideRow[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // malformed → start fresh (caller rewrites a clean array)
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { overrides?: unknown }).overrides)
      ? (parsed as { overrides: unknown[] }).overrides
      : [];
  return rows.filter(
    (r): r is OverrideRow =>
      r !== null &&
      typeof r === 'object' &&
      typeof (r as OverrideRow).projectId === 'string' &&
      // Require a `match` object so the prune/strip loops below can read
      // `r.match.sessionIds` unguarded (a hand-edited match-less row is
      // dropped here rather than crashing the write).
      typeof (r as OverrideRow).match === 'object' &&
      (r as OverrideRow).match !== null,
  );
}

async function atomicWrite(path: string, rows: OverrideRow[]): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(rows, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

let inFlight: Promise<Response> | null = null;

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return json({ ok: false, error: 'Forbidden: cross-origin or missing Origin' }, 403);
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return json({ ok: false, error: 'Forbidden: missing X-Requested-With token' }, 403);
  }
  if (inFlight) {
    return json({ ok: false, error: 'Another override write is in flight. Retry in a moment.' }, 409);
  }

  let release!: (r: Response) => void;
  const slot = new Promise<Response>((res) => {
    release = res;
  });
  inFlight = slot;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      const r = json({ ok: false, error: 'invalid JSON body' }, 400);
      release(r);
      return r;
    }
    const b = body as { sessionId?: unknown; projectId?: unknown; displayName?: unknown };
    const sessionId = typeof b.sessionId === 'string' ? b.sessionId.trim() : '';
    const projectId = typeof b.projectId === 'string' ? b.projectId.trim() : '';
    if (sessionId === '' || projectId === '') {
      const r = json({ ok: false, error: 'sessionId and projectId are required non-empty strings' }, 400);
      release(r);
      return r;
    }
    const displayName = typeof b.displayName === 'string' && b.displayName.trim() !== '' ? b.displayName.trim() : undefined;

    const path = overridesPath();
    try {
      await mkdir(dirname(path), { recursive: true });
      const rows = await loadRows(path);
      // Idempotent merge: if an override for this projectId already has a
      // sessionIds match, add the session there; else append a new row. Also
      // drop the sessionId from any OTHER row's sessionIds so a re-move wins.
      for (const row of rows) {
        if (Array.isArray(row.match?.sessionIds)) {
          row.match.sessionIds = row.match.sessionIds.filter((s) => s !== sessionId);
        }
      }
      let target = rows.find((r) => r.projectId === projectId && Array.isArray(r.match?.sessionIds));
      if (target === undefined) {
        target = { projectId, ...(displayName ? { displayName } : {}), match: { sessionIds: [] } };
        rows.push(target);
      } else if (displayName !== undefined) {
        target.displayName = displayName;
      }
      target.match.sessionIds = [...new Set([...(target.match.sessionIds ?? []), sessionId])];
      // Prune now-empty rows (a session moved away from a singleton override).
      const cleaned = rows.filter(
        (r) => (r.match.sessionIds && r.match.sessionIds.length > 0) || (r.match.cwdGlob && r.match.cwdGlob !== ''),
      );
      await atomicWrite(path, cleaned);
      const r = json(
        { ok: true, projectId, sessionId, overridesCount: cleaned.length, note: 'Run a rescan to apply.' },
        200,
      );
      release(r);
      return r;
    } catch (err) {
      const r = json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      release(r);
      return r;
    }
  } finally {
    if (inFlight === slot) inFlight = null;
  }
};

/** Availability probe (the viewer hides the affordance when this 404s on the hosted build). */
export const GET: APIRoute = () => json({ ok: true, available: true }, 200);
