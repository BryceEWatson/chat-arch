import type { APIRoute } from 'astro';
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Decision, DecisionsFile } from '@chat-arch/schema';

/**
 * Reset the decision-mining pipeline's OUTPUT so the user can re-mine
 * from scratch — without destroying the candidates they'd have to
 * re-run the exporter to regenerate.
 *
 * This is NOT a simple delete-by-allowlist like `/api/clear-corrections`,
 * because `decisions.json` is a SINGLE file holding both the exporter's
 * candidates (INPUT) and the skill's classification (OUTPUT). So:
 *
 *   - `analysis/decisions.json` — REWRITTEN in place: every row's
 *     `classification` + `trustCalibration` reset to null, `candidate` +
 *     `outcomeRef` preserved. The candidates (and the
 *     `decisionHeuristicVersion` / `scannedSessionIds` cache keys) survive.
 *   - `analysis/decision-clusters.json` — DELETED (pure skill output).
 *   - `analysis/decision-status-*.json` — DELETED (orphan status files).
 *   - `analysis/decisions.json.tmp.*` — DELETED (atomic-write orphans).
 *
 * NOT touched: any other analysis file. The kitchen-sink `/api/clear`
 * still nukes everything under chat-arch-data/.
 *
 * CSRF posture matches `/api/clear-corrections`:
 *   1. Origin parses to a local-only hostname.
 *   2. Custom `X-Requested-With: chat-arch-clear-decisions` header.
 */
export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-clear-decisions';
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

/** apps/standalone/src/pages/api/clear-decisions.ts → apps/standalone/public/chat-arch-data/analysis/ */
function analysisDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'public', 'chat-arch-data', 'analysis');
}

/**
 * Skill-output sidecars safe to DELETE outright (decisions.json itself is
 * rewritten, not deleted — see module doc). Conservative: reject any name
 * with path separators or `..` segments.
 *
 * NOTE FOR FUTURE MAINTAINERS: keep in sync with
 * `.claude/skills/mine-decisions/SKILL.md` — the sidecars the skill writes.
 */
export function isDecisionSidecar(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.split(/[._-]/).includes('..')) return false;
  if (name === 'decision-clusters.json') return true;
  if (name.startsWith('decision-status-') && name.endsWith('.json')) return true;
  if (name.startsWith('decisions.json.tmp.')) return true;
  return false;
}

/** Strip classification + trustCalibration from every row, keep the rest. */
export function resetDecisionsFile(file: DecisionsFile, now: number): DecisionsFile {
  const decisions: Decision[] = file.decisions.map((d) => ({
    candidate: d.candidate,
    classification: null,
    outcomeRef: d.outcomeRef,
  }));
  return {
    generatedAt: now,
    decisionHeuristicVersion: file.decisionHeuristicVersion,
    decisions,
    scannedSessionIds: file.scannedSessionIds,
  };
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
  let reset = 0;

  // 1. Reset decisions.json in place (preserve candidates).
  const decisionsPath = join(dir, 'decisions.json');
  try {
    const raw = await readFile(decisionsPath, 'utf8');
    const parsed = JSON.parse(raw) as DecisionsFile;
    if (Array.isArray(parsed.decisions)) {
      reset = parsed.decisions.filter((d) => d.classification !== null).length;
      const next = resetDecisionsFile(parsed, Date.now());
      await writeFile(decisionsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
  } catch (err) {
    // Missing file → nothing to reset; malformed → skip the reset but
    // still sweep sidecars below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // leave `reset` at 0; not fatal
    }
  }

  // 2. Sweep skill-output sidecars.
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response(JSON.stringify({ ok: true, removed: [], reset }), {
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
      if (!isDecisionSidecar(e.name)) return;
      try {
        await rm(join(dir, e.name), { force: true });
        removed.push(e.name);
      } catch {
        // Best-effort.
      }
    }),
  );

  return new Response(JSON.stringify({ ok: true, removed, reset }), {
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
