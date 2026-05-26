import type { APIRoute } from 'astro';
import { readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Narrative } from '@chat-arch/schema';
import {
  classifyAttribution,
  mergeNarrativeFamilies,
  normalizeNarrativeRow,
  THRESHOLDS,
} from '@chat-arch/analysis';
import { atomicWriteJson, buildNarrativesFileObject } from '@chat-arch/exporter';
import { isMineNarrativesInFlight } from './mine-narratives.ts';

/**
 * Wipe ONLY the LLM-derived narratives produced by the
 * `/mine-narratives` skill. Heuristic narratives written by
 * `runAnalysis` are preserved — they're the always-on baseline. The
 * scope is intentionally narrower than `/api/clear-personas`:
 *
 *   - `analysis/narratives.json` — read-modify-write semantics:
 *     keep heuristic rows; remove `attributedTo: 'llm-derived'` AND
 *     `'falsifier-verified'` rows (both are the LLM family); clear
 *     `skipped[]`; preserve `thresholds`; round-trip unrecognized
 *     top-level keys via `buildNarrativesFileObject`'s passthrough.
 *   - `analysis/narrative-status-*.json` — orphan status files (deleted).
 *   - `analysis/narratives.json.tmp.*` — leaked tmp files from
 *     interrupted skill writes (deleted).
 *
 * NOT touched:
 *   - `analysis/narrative-candidates.json` — Stage-1 INPUT (written
 *     by the exporter, not by the skill). Regenerating it requires
 *     re-running the exporter.
 *   - Any other analysis file.
 *
 * CSRF posture mirrors `/api/clear-personas`:
 *   1. Origin parses to a local-only hostname.
 *   2. Custom `X-Requested-With: chat-arch-clear-narratives` header.
 *
 * Returns 409 when `/api/mine-narratives` is currently running.
 *
 * Static-build deploys without this endpoint return 404; the panel
 * hides the clear button when the GET probe fails.
 */
export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-clear-narratives';
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

/** apps/standalone/src/pages/api/clear-narratives.ts → apps/standalone/public/chat-arch-data/analysis/ */
function analysisDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'public', 'chat-arch-data', 'analysis');
}

/**
 * Identify a narrative-mining status / tmp artifact. Conservative on
 * purpose — anything not matching is left alone so a misconfigured
 * deploy can't accidentally wipe sibling analysis output.
 *
 * NOTE: this allow-list MUST stay in sync with the Stage-2 skill's
 * writes. Adding a new sidecar pattern in the skill without updating
 * this predicate leaves orphan files on disk.
 */
export function isNarrativeOrphan(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.split(/[._-]/).includes('..')) return false;
  if (name.startsWith('narrative-status-') && name.endsWith('.json')) return true;
  // narratives.json.tmp.<requestId> orphans from interrupted skill writes.
  if (name.startsWith('narratives.json.tmp.')) return true;
  // Also catch the exporter's stamped-tmp pattern `narratives.json.tmp-<pid>-…`.
  if (name.startsWith('narratives.json.tmp-')) return true;
  return false;
}

const RESERVED_KEYS = new Set<string>([
  'generatedAt',
  'exporterVersion',
  'thresholds',
  'narratives',
  'skipped',
]);

interface ClearResult {
  removedNarratives: number;
  removedStatusFiles: number;
}

/**
 * Read narratives.json, drop LLM-family rows, atomically write back.
 * Returns the count of LLM rows removed. Throws on file-system errors
 * other than ENOENT (which is treated as "nothing to clear").
 *
 * Exported so the test suite can exercise the rewrite directly without
 * standing up the full Astro request pipeline. The endpoint itself
 * calls this and surfaces the count over JSON.
 */
export async function rewriteNarrativesJson(
  narrativesPath: string,
): Promise<{ removed: number }> {
  let raw: string;
  try {
    raw = await readFile(narrativesPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed: 0 };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed file — leave it alone rather than overwriting with our
    // best-guess shape (could destroy data the user wants to inspect).
    return { removed: 0 };
  }

  if (parsed === null || typeof parsed !== 'object') return { removed: 0 };

  const obj = parsed as Record<string, unknown>;
  const incomingRows = Array.isArray(obj['narratives']) ? obj['narratives'] : [];

  const heuristic: Narrative[] = [];
  let removed = 0;
  for (const r of incomingRows) {
    if (r === null || typeof r !== 'object') continue;
    const row = normalizeNarrativeRow(r as Narrative);
    const family = classifyAttribution(row);
    if (family === 'heuristic') {
      heuristic.push(row);
    } else {
      // 'llm' rows AND 'unknown' rows are dropped — the latter to keep
      // the file shape clean post-clear.
      removed += 1;
    }
  }

  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!RESERVED_KEYS.has(k)) {
      passthrough[k] = v;
    }
  }

  const merged = mergeNarrativeFamilies({
    heuristic,
    existingLlm: [],
    mode: 'full-rewrite',
  });

  const fileObj = buildNarrativesFileObject(
    {
      generatedAt:
        typeof obj['generatedAt'] === 'number' ? obj['generatedAt'] : Date.now(),
      exporterVersion:
        typeof obj['exporterVersion'] === 'string'
          ? obj['exporterVersion']
          : '1.7.0',
      thresholds:
        obj['thresholds'] && typeof obj['thresholds'] === 'object'
          ? (obj['thresholds'] as ReturnType<
              typeof buildNarrativesFileObject
            >['thresholds'])!
          : {
              minSessionsForLlm: THRESHOLDS.narrative.minSessionsForLlm,
              maxSessionsForCorpus: THRESHOLDS.narrative.maxSessionsForCorpus,
              minPerProject: THRESHOLDS.narrative.minPerProject,
              maxPerProject: THRESHOLDS.narrative.maxPerProject,
              evidenceMinPerNarrative:
                THRESHOLDS.narrative.evidenceMinPerNarrative,
              maxLlmUsdPerProject: THRESHOLDS.narrative.maxLlmUsdPerProject,
            },
      narratives: merged,
      // skipped[] is cleared on a clear (a fresh narrative-mining run
      // will rebuild it).
      skipped: [],
    },
    passthrough,
  );

  await atomicWriteJson(
    narrativesPath,
    JSON.stringify(fileObj, null, 2) + '\n',
  );
  return { removed };
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  if (isMineNarrativesInFlight()) {
    return new Response(
      JSON.stringify({
        ok: false,
        error:
          'A narrative-mining run is currently in progress. Wait for it to finish before clearing.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  const dir = analysisDir();
  const removed: ClearResult = { removedNarratives: 0, removedStatusFiles: 0 };

  // 1. Rewrite narratives.json (drop LLM rows + clear skipped[]).
  try {
    const r = await rewriteNarrativesJson(join(dir, 'narratives.json'));
    removed.removedNarratives = r.removed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ ok: false, error: `narratives.json rewrite failed: ${msg}` }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  // 2. Sweep status files + tmp orphans.
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response(JSON.stringify({ ok: true, ...removed }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg, ...removed }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  await Promise.all(
    entries.map(async (e) => {
      if (!e.isFile()) return;
      if (!isNarrativeOrphan(e.name)) return;
      try {
        await rm(join(dir, e.name), { force: true });
        removed.removedStatusFiles += 1;
      } catch {
        // Best-effort.
      }
    }),
  );

  return new Response(JSON.stringify({ ok: true, ...removed }), {
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
