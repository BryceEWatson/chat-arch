/**
 * Wave 6 #2 — `/api/generate-exports` endpoint.
 *
 * Drives the markdown / Obsidian export submodule from a viewer POST.
 * Mirrors the security posture of `rescan.ts` (CSRF gate + Origin check
 * + `X-Requested-With` token + in-flight serialization).
 *
 * Body shape:
 *
 *   {
 *     kinds: ('post-mortem' | 'knowledge-debt' | 'decision-log' | 'trust-report')[],
 *     filters?: {
 *       dateFrom?: number,           // ms epoch
 *       dateTo?: number,
 *       projectId?: string,
 *       archetypeId?: string,
 *       outcomePercentile?: number,  // 0..100 floor
 *     }
 *   }
 *
 * Response (JSON, content-type application/json):
 *
 *   {
 *     ok: true,
 *     count: number,                 // total entries newly generated
 *     outputDir: string,             // absolute path the user can open
 *     manifestPath: string,
 *   }
 *
 * For the v1 cut, this endpoint implements the load-bearing **post-
 * mortems** kind only — the other kinds are accepted (no 400) and
 * produce a single stderr note in the response so the UI can keep its
 * checklist live. Filling those in is the follow-up after the Wave 6
 * UI affordances land.
 *
 * Compute path (post-mortems only):
 *   1. Read manifest.json + composite-outcomes.json + decisions.json.
 *   2. Compute per-session composite-percentile from the outcomes file.
 *   3. For each session that:
 *        - matches the filter set (date / project / outcome-percentile),
 *        - passes `checkEligibility` from `postMortemGenerator`,
 *      call `generatePostMortem` and write the file under
 *      `chat-arch-data/exports/post-mortems/<sessionId>.md`.
 *   4. Update `analysis/exports/manifest.json` via `writeExportManifest`.
 *
 * Manual-trigger only; no auto-publish.
 */

import type { APIRoute } from 'astro';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertDataDirContained, handleDataDirGuardError } from '../../lib/dataDirGuard.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type {
  CompositeOutcome,
  CompositeOutcomesFile,
  Decision,
  DecisionsFile,
  SessionManifest,
} from '@chat-arch/schema';
import {
  checkEligibility,
  generatePostMortem,
  writeExportManifest,
  type ExportManifestEntry,
} from '@chat-arch/exporter/export';

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-generate-exports';
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

/**
 * Serializes concurrent generate-exports runs — two parallel runs
 * would race to write the same `manifest.json` and `<sessionId>.md`
 * files. Matches `rescan.ts`'s in-flight pattern.
 */
let inFlight: Promise<Response> | null = null;

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

const DEFAULT_DATA_DIR = 'apps/standalone/public/chat-arch-data';

export interface ExportFilters {
  dateFrom?: number;
  dateTo?: number;
  projectId?: string;
  archetypeId?: string;
  /** Floor in [0, 100]. 80 = top-quintile. */
  outcomePercentile?: number;
}

export interface GenerateExportsBody {
  kinds?: ReadonlyArray<string>;
  filters?: ExportFilters;
  dataDir?: string;
}

interface ValidatedRequest {
  kinds: ReadonlySet<string>;
  filters: ExportFilters;
  dataDir: string;
}

const KNOWN_KINDS = new Set([
  'post-mortem',
  'knowledge-debt',
  'decision-log',
  'trust-report',
]);

export function validateBody(body: unknown): ValidatedRequest {
  const b = (body && typeof body === 'object' ? body : {}) as GenerateExportsBody;
  const kinds = new Set<string>();
  if (Array.isArray(b.kinds)) {
    for (const k of b.kinds) {
      if (typeof k === 'string' && KNOWN_KINDS.has(k)) kinds.add(k);
    }
  }
  // Default: all known kinds (so a missing body still does the right
  // thing). The endpoint will note any kind it doesn't yet implement.
  if (kinds.size === 0) {
    for (const k of KNOWN_KINDS) kinds.add(k);
  }
  const filters: ExportFilters = {};
  if (b.filters && typeof b.filters === 'object') {
    const f = b.filters;
    if (typeof f.dateFrom === 'number' && Number.isFinite(f.dateFrom)) {
      filters.dateFrom = f.dateFrom;
    }
    if (typeof f.dateTo === 'number' && Number.isFinite(f.dateTo)) {
      filters.dateTo = f.dateTo;
    }
    if (typeof f.projectId === 'string' && f.projectId.length > 0) {
      filters.projectId = f.projectId;
    }
    if (typeof f.archetypeId === 'string' && f.archetypeId.length > 0) {
      filters.archetypeId = f.archetypeId;
    }
    if (
      typeof f.outcomePercentile === 'number' &&
      Number.isFinite(f.outcomePercentile) &&
      f.outcomePercentile >= 0 &&
      f.outcomePercentile <= 100
    ) {
      filters.outcomePercentile = f.outcomePercentile;
    }
  }
  const candidate =
    typeof b.dataDir === 'string' && b.dataDir.trim().length > 0
      ? b.dataDir
      : DEFAULT_DATA_DIR;
  // Throws DataDirGuardError on `..`-traversal; POST handler converts
  // to a 400 response. (S1)
  const dataDir = assertDataDirContained(candidate, repoRoot());
  return { kinds, filters, dataDir };
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Compute the cdf-style percentile for each session id by composite
 * score (higher score = higher percentile). Returns a Map<id, [0, 1]>.
 * Sessions absent from the file are not in the map; callers must
 * default-to-zero so they fall outside any percentile floor.
 *
 * Pure — keyed by id, deterministic given the same outcomes list.
 */
export function computePercentiles(
  outcomes: readonly CompositeOutcome[],
): Map<string, number> {
  const sorted = [...outcomes].sort((a, b) => a.score - b.score);
  const out = new Map<string, number>();
  const n = sorted.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i += 1) {
    // Cumulative rank position — i = 0 → 0/(n-1), i = n-1 → 1.0.
    const pct = n === 1 ? 1 : i / (n - 1);
    out.set(sorted[i]!.sessionId, pct);
  }
  return out;
}

interface PostMortemRunResult {
  generated: number;
  errors: readonly string[];
  /** Manifest entries this run produced; the caller merges them into
   *  the persisted manifest.json. */
  entries: readonly ExportManifestEntry[];
}

/**
 * The post-mortem generator generation step. Pure-ish (writes files)
 * but exposed for unit-test stubbing — the caller injects the file-
 * write function so tests can stay in memory.
 */
export async function runPostMortems(
  manifest: SessionManifest,
  outcomes: CompositeOutcomesFile,
  decisions: DecisionsFile | null,
  filters: ExportFilters,
  outDir: string,
  write: (path: string, content: string) => Promise<void>,
): Promise<PostMortemRunResult> {
  const percentiles = computePercentiles(outcomes.outcomes);
  const outcomeBySid = new Map<string, CompositeOutcome>();
  for (const o of outcomes.outcomes) outcomeBySid.set(o.sessionId, o);

  const decisionsBySid = new Map<string, Decision[]>();
  if (decisions !== null) {
    for (const d of decisions.decisions) {
      const sid = d.candidate.sessionId;
      const arr = decisionsBySid.get(sid);
      if (arr) arr.push(d);
      else decisionsBySid.set(sid, [d]);
    }
  }

  const errors: string[] = [];
  const entries: ExportManifestEntry[] = [];
  // Floor in 0..1 — defaults to the generator's own
  // POST_MORTEM_PERCENTILE_FLOOR via the eligibility check; the
  // viewer-side filter is an additional gate, not a replacement.
  const pctFloor =
    filters.outcomePercentile !== undefined
      ? filters.outcomePercentile / 100
      : 0;

  let generated = 0;
  for (const session of manifest.sessions) {
    if (filters.projectId !== undefined && session.project !== filters.projectId) {
      continue;
    }
    const ts = session.updatedAt ?? session.startedAt ?? 0;
    if (filters.dateFrom !== undefined && ts < filters.dateFrom) continue;
    if (filters.dateTo !== undefined && ts > filters.dateTo) continue;

    const composite = outcomeBySid.get(session.id);
    if (composite === undefined) continue;
    const pct = percentiles.get(session.id) ?? 0;
    if (pct < pctFloor) continue;

    const sessionDecisions = decisionsBySid.get(session.id) ?? [];
    const eligibility = checkEligibility({
      session,
      composite,
      decisions: sessionDecisions,
      outcomePercentile: pct,
    });
    if (!eligibility.eligible) continue;

    try {
      // Use a deterministic LLM stub for the v1 cut — the user can
      // re-run with the CLI for real summaries. Falling back to the
      // built-in `summarizeViaClaudeCli` here would block the endpoint
      // on a `claude -p` call per session; that's not the right shape
      // for a viewer button. Future revision: stream progress to the
      // client and call out to claude per session opt-in.
      const doc = generatePostMortem({
        session,
        composite,
        decisions: sessionDecisions,
        outcomePercentile: pct,
        runLlm: () =>
          'Stub summary — re-run via `pnpm --filter @chat-arch/exporter ...` for an LLM-generated narrative.',
      });
      const absPath = join(outDir, doc.path);
      const dir = dirname(absPath);
      await mkdir(dir, { recursive: true });
      await write(absPath, doc.body);
      entries.push({
        id: session.id,
        kind: 'post-mortem',
        relativePath: doc.path,
        generatedAt: new Date().toISOString(),
        title: session.title,
      });
      generated += 1;
    } catch (err) {
      errors.push(
        `${session.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { generated, errors, entries };
}

interface GenerateRunOutcome {
  ok: boolean;
  count: number;
  outputDir: string;
  manifestPath: string;
  notes: readonly string[];
  errors: readonly string[];
}

async function runGenerate(req: ValidatedRequest): Promise<GenerateRunOutcome> {
  const root = repoRoot();
  const outDir = resolve(root, req.dataDir);
  const analysisDir = join(outDir, 'analysis');
  const manifest = await readJsonOrNull<SessionManifest>(
    join(outDir, 'manifest.json'),
  );
  const outcomes = await readJsonOrNull<CompositeOutcomesFile>(
    join(analysisDir, 'composite-outcomes.json'),
  );
  const decisions = await readJsonOrNull<DecisionsFile>(
    join(analysisDir, 'decisions.json'),
  );

  const notes: string[] = [];
  const errors: string[] = [];
  const entries: ExportManifestEntry[] = [];
  let count = 0;

  if (req.kinds.has('post-mortem')) {
    if (manifest === null) {
      errors.push('manifest.json missing — run pnpm exporter run start first.');
    } else if (outcomes === null) {
      errors.push(
        'composite-outcomes.json missing — analysis writer did not run yet.',
      );
    } else {
      const r = await runPostMortems(
        manifest,
        outcomes,
        decisions,
        req.filters,
        outDir,
        async (p, body) => {
          await writeFile(p, body, 'utf8');
        },
      );
      count += r.generated;
      for (const e of r.entries) entries.push(e);
      for (const err of r.errors) errors.push(err);
    }
  }
  // Other kinds — accept the request but flag as not yet implemented in
  // this endpoint. The viewer keeps the checkbox live so users can opt
  // in; running them will become a no-op until the follow-up lands.
  for (const k of ['knowledge-debt', 'decision-log', 'trust-report'] as const) {
    if (req.kinds.has(k)) {
      notes.push(`${k}: not yet implemented in /api/generate-exports`);
    }
  }

  // Merge with any pre-existing manifest so we don't lose entries from
  // earlier kinds. Reads the on-disk shape; falls back to a fresh list.
  const existingManifest = await readJsonOrNull<{
    entries?: ExportManifestEntry[];
  }>(join(analysisDir, 'exports', 'manifest.json'));
  const seen = new Set<string>();
  const merged: ExportManifestEntry[] = [];
  for (const e of entries) {
    seen.add(`${e.kind}:${e.relativePath}`);
    merged.push(e);
  }
  for (const e of existingManifest?.entries ?? []) {
    const key = `${e.kind}:${e.relativePath}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(e);
    }
  }
  const writeResult = await writeExportManifest(outDir, merged);
  return {
    ok: errors.length === 0,
    count,
    outputDir: join(outDir, 'exports'),
    manifestPath: writeResult.manifestPath,
    notes,
    errors,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }
  if (inFlight) {
    return jsonResponse(
      {
        ok: false,
        error: 'A generate-exports run is already in progress. Wait for it to finish.',
      },
      409,
    );
  }
  let resolveSlot!: (r: Response) => void;
  const slot = new Promise<Response>((res) => {
    resolveSlot = res;
  });
  inFlight = slot;
  try {
    let body: unknown = {};
    try {
      const text = await request.text();
      if (text.trim().length > 0) body = JSON.parse(text);
    } catch {
      body = {};
    }
    let validated: ValidatedRequest;
    try {
      validated = validateBody(body);
    } catch (err) {
      const r = handleDataDirGuardError(err); // (XN2)
      if (r) {
        resolveSlot(r);
        return r;
      }
      throw err;
    }
    try {
      const outcome = await runGenerate(validated);
      const status = outcome.ok ? 200 : 200; // body carries error detail; status stays 200 unless we couldn't even start
      const r = jsonResponse(
        {
          ok: outcome.ok,
          count: outcome.count,
          outputDir: outcome.outputDir,
          manifestPath: outcome.manifestPath,
          notes: outcome.notes,
          errors: outcome.errors,
          error: outcome.errors.length > 0 ? outcome.errors.join('; ') : undefined,
        },
        status,
      );
      resolveSlot(r);
      return r;
    } catch (err) {
      const r = jsonResponse(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
      resolveSlot(r);
      return r;
    }
  } finally {
    if (inFlight === slot) inFlight = null;
  }
};

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true, busy: inFlight !== null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
