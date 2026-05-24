/**
 * PR-land join — Phase 1 Wave 3 (Stream F, task 2).
 *
 * Walks the extended audit-results (the `gh-pr-*` claim families) and,
 * for each unique PR URL it can extract, calls
 * `gh api repos/{owner}/{repo}/pulls/{n}` to fetch the canonical
 * merged/closed-unmerged/open state. Joins the result back into the
 * composite outcomes file so `prLand` reflects GitHub's ground truth
 * rather than the verifier's surface-form heuristic.
 *
 * Gated by `--enable-pr-join` CLI flag (default OFF) — the gh API is
 * rate-limited and unauthenticated runs would burn the user's anonymous
 * quota for a non-critical enrichment.
 *
 * Failure-state cache:
 *   - sidecar: `analysis/pr-land-cache.json`
 *   - state ∈ {ok | notFound | rateLimited | authError | transient}
 *   - 404 → cache forever (PR doesn't exist; nothing changes)
 *   - rateLimited / transient → TTL re-fetch (default 1 day)
 *   - authError → log loud, set `meta.json.prJoinStatus = 'auth-error'`
 *
 * Node-only — shells out to `gh` via `execFile`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteJsonSync as atomicWriteJson } from '../lib/atomicWrite.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditResultsFile, CompositeOutcome, CompositeOutcomesFile } from '@chat-arch/schema';
import { logger } from '../lib/logger.js';

const execFileP = promisify(execFile);

export type PrLandCacheState =
  | 'ok'
  | 'notFound'
  | 'rateLimited'
  | 'authError'
  | 'transient';

export interface PrLandCacheEntry {
  state: PrLandCacheState;
  /** Unix ms. */
  fetchedAt: number;
  /** Only present on state==='ok'. */
  data?: GhPrApiResponse;
  // No `error` field — gh-CLI stderr can carry org/repo names, file
  // paths, and token hints (PII). The `state` enum is sufficient for
  // the cache layer's TTL decisions. Diagnostic text is logged to
  // stderr at fetch time, not persisted. (S2)
}

export interface PrLandCacheFile {
  version: 1;
  generatedAt: number;
  entries: Record<string, PrLandCacheEntry>;
}

/**
 * Minimal typed projection of `gh api repos/.../pulls/N` JSON. Only the
 * fields the join actually uses. Fully typed — no `any` per the project
 * quality gate.
 */
export interface GhPrApiResponse {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
  title: string;
  html_url: string;
}

export interface BuildPrLandJoinOptions {
  outDir: string;
  now: number;
  /** TTL for re-fetching rate-limited / transient cache entries. */
  ttlMs?: number;
  /** Override the `gh` binary path (tests). */
  ghBinary?: string;
  /** Skip network calls — use cache only (tests). */
  cacheOnly?: boolean;
}

export interface BuildPrLandJoinResult {
  joinedCount: number;
  fetchedCount: number;
  reusedCount: number;
  authErrorEncountered: boolean;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Match `https://github.com/<owner>/<repo>/pull/<n>` anywhere in the
 * audit-result surrounding context or span. Tolerates trailing path
 * components (`#issuecomment-…`) by anchoring on `pull/<digits>`.
 */
const PR_URL_REGEX =
  /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

// atomicWriteJson is now the shared atomicWriteJsonSync helper from
// ../lib/atomicWrite.js (aliased on import) — consolidated per DN3.

async function loadCache(outDir: string): Promise<PrLandCacheFile> {
  const p = path.join(outDir, 'analysis', 'pr-land-cache.json');
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as PrLandCacheFile;
    if (parsed.version === 1 && parsed.entries) return parsed;
  } catch {
    // First run, malformed, or absent — start fresh.
  }
  return { version: 1, generatedAt: 0, entries: {} };
}

async function loadAuditResults(outDir: string): Promise<AuditResultsFile | null> {
  const p = path.join(outDir, 'analysis', 'audit-results.json');
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as AuditResultsFile;
  } catch {
    return null;
  }
}

async function loadCompositeOutcomes(outDir: string): Promise<CompositeOutcomesFile | null> {
  const p = path.join(outDir, 'analysis', 'composite-outcomes.json');
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as CompositeOutcomesFile;
  } catch {
    return null;
  }
}

interface PrKey {
  owner: string;
  repo: string;
  num: number;
  /** Canonical key for the cache map. */
  k: string;
}

/**
 * Walk an audit-results file's `gh-pr-*` rows and extract every distinct
 * (owner, repo, number) triple referenced. Returns one entry per session
 * that has at least one PR reference, keyed by sessionId.
 */
function extractPrRefs(audit: AuditResultsFile): Map<string, PrKey[]> {
  const bySession = new Map<string, PrKey[]>();
  for (const r of audit.results) {
    if (
      r.claimType !== 'gh-pr-opened' &&
      r.claimType !== 'gh-pr-merged' &&
      r.claimType !== 'gh-pr-closed-unmerged'
    ) {
      continue;
    }
    const hay = `${r.span}\n${r.surroundingContext}`;
    PR_URL_REGEX.lastIndex = 0;
    for (let m = PR_URL_REGEX.exec(hay); m !== null; m = PR_URL_REGEX.exec(hay)) {
      const owner = m[1] as string;
      const repo = m[2] as string;
      const num = Number(m[3]);
      const key: PrKey = { owner, repo, num, k: `${owner}/${repo}#${num}` };
      const list = bySession.get(r.sessionId) ?? [];
      if (!list.some((p) => p.k === key.k)) list.push(key);
      bySession.set(r.sessionId, list);
    }
  }
  return bySession;
}

/**
 * Fetch one PR via `gh api`. Maps known failure surfaces to typed
 * states so the cache layer can apply the right TTL strategy.
 */
async function fetchPr(
  key: PrKey,
  ghBinary: string,
): Promise<{ state: PrLandCacheState; data?: GhPrApiResponse; error?: string }> {
  try {
    const { stdout } = await execFileP(
      ghBinary,
      ['api', `repos/${key.owner}/${key.repo}/pulls/${key.num}`],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
    );
    const json = JSON.parse(stdout) as GhPrApiResponse;
    return { state: 'ok', data: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 404/i.test(msg) || /Not Found/i.test(msg)) {
      return { state: 'notFound', error: msg };
    }
    if (/rate limit|secondary rate/i.test(msg)) {
      return { state: 'rateLimited', error: msg };
    }
    if (/HTTP 401|HTTP 403|authentication/i.test(msg)) {
      return { state: 'authError', error: msg };
    }
    return { state: 'transient', error: msg };
  }
}

/**
 * Should we trust a cached entry, given its state + TTL?
 *   - ok                → reuse (PR state is durable for a join cycle)
 *   - notFound          → reuse forever (404s don't undelete)
 *   - rateLimited       → reuse only within TTL
 *   - authError         → reuse within TTL; flagged on each run
 *   - transient         → reuse only within TTL
 */
function isCacheFresh(
  entry: PrLandCacheEntry,
  now: number,
  ttlMs: number,
): boolean {
  if (entry.state === 'ok' || entry.state === 'notFound') return true;
  return now - entry.fetchedAt < ttlMs;
}

/**
 * Map an OK response into a `CompositeOutcome.prLand` value.
 * (merged → 'merged'; closed but not merged → 'closed-unmerged';
 *  open → 'open'.)
 */
function prLandFromGh(
  data: GhPrApiResponse,
): CompositeOutcome['prLand'] {
  if (data.merged) return 'merged';
  if (data.state === 'closed') return 'closed-unmerged';
  return 'open';
}

export async function buildPrLandJoin(
  options: BuildPrLandJoinOptions,
): Promise<BuildPrLandJoinResult> {
  const t0 = Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const ghBinary = options.ghBinary ?? 'gh';

  const audit = await loadAuditResults(options.outDir);
  const composite = await loadCompositeOutcomes(options.outDir);
  if (audit === null || composite === null) {
    logger.warn(
      'pr-land: missing prerequisite sidecar (audit-results / composite-outcomes) — skipping',
    );
    return { joinedCount: 0, fetchedCount: 0, reusedCount: 0, authErrorEncountered: false };
  }

  const cache = await loadCache(options.outDir);
  const refsBySession = extractPrRefs(audit);

  let fetched = 0;
  let reused = 0;
  let authErrorEncountered = false;

  // Fetch each distinct key once across sessions.
  const allKeys = new Map<string, PrKey>();
  for (const list of refsBySession.values()) {
    for (const k of list) allKeys.set(k.k, k);
  }

  for (const key of allKeys.values()) {
    const cached = cache.entries[key.k];
    if (cached !== undefined && isCacheFresh(cached, options.now, ttlMs)) {
      reused += 1;
      if (cached.state === 'authError') authErrorEncountered = true;
      continue;
    }
    if (options.cacheOnly === true) continue;
    const r = await fetchPr(key, ghBinary);
    const entry: PrLandCacheEntry = {
      state: r.state,
      fetchedAt: options.now,
      ...(r.data !== undefined ? { data: r.data } : {}),
      // r.error is logged below but NOT persisted to the cache (S2 —
      // see PrLandCacheEntry comment).
    };
    cache.entries[key.k] = entry;
    fetched += 1;
    if (r.state === 'authError') {
      authErrorEncountered = true;
      logger.warn(
        `pr-land: auth error from \`gh api\` for ${key.k} — set GH_TOKEN or run \`gh auth login\` (continuing with cache-only join)`,
      );
    }
  }

  // Persist the cache.
  const cacheOut: PrLandCacheFile = {
    version: 1,
    generatedAt: options.now,
    entries: cache.entries,
  };
  atomicWriteJson(path.join(options.outDir, 'analysis', 'pr-land-cache.json'), cacheOut);

  // Join: rewrite composite-outcomes.json with updated prLand where
  // we have a fresh OK entry. We mutate in place per session: if any
  // referenced PR is `merged`, the session's prLand wins as 'merged';
  // else any 'closed-unmerged' wins; else 'open'; else leave untouched.
  let joined = 0;
  const byId = new Map(composite.outcomes.map((o) => [o.sessionId, o] as const));
  for (const [sessionId, keys] of refsBySession) {
    const ranks: CompositeOutcome['prLand'][] = [];
    for (const k of keys) {
      const c = cache.entries[k.k];
      if (c?.state === 'ok' && c.data !== undefined) ranks.push(prLandFromGh(c.data));
    }
    if (ranks.length === 0) continue;
    let chosen: CompositeOutcome['prLand'] = 'open';
    if (ranks.includes('merged')) chosen = 'merged';
    else if (ranks.includes('closed-unmerged')) chosen = 'closed-unmerged';
    else if (ranks.includes('open')) chosen = 'open';
    const row = byId.get(sessionId);
    if (row !== undefined && row.prLand !== chosen) {
      // Build a new immutable row; preserve all other fields. We don't
      // re-score here — the score reflects the verifier's view at compose
      // time. A follow-up commit can plumb GH ground-truth back through
      // the kernel; for now we surface the corrected `prLand` field.
      const next: CompositeOutcome = { ...row, prLand: chosen };
      byId.set(sessionId, next);
      joined += 1;
    }
  }

  if (joined > 0) {
    const updated: CompositeOutcomesFile = {
      ...composite,
      generatedAt: options.now,
      outcomes: [...byId.values()],
    };
    atomicWriteJson(
      path.join(options.outDir, 'analysis', 'composite-outcomes.json'),
      updated,
    );
  }

  // Update meta.json with auth-error status if we hit one — let the
  // viewer's diagnostic surface flag the run.
  if (authErrorEncountered) {
    await markMetaPrJoinStatus(options.outDir, 'auth-error');
  }

  logger.info(
    `pr-land: ${joined} joined, ${fetched} fetched, ${reused} reused, ` +
      `${allKeys.size} distinct refs, ${Date.now() - t0}ms`,
  );

  return {
    joinedCount: joined,
    fetchedCount: fetched,
    reusedCount: reused,
    authErrorEncountered,
  };
}

/**
 * Set `meta.json.prJoinStatus`. Best-effort: when meta.json is absent
 * (first run before analysis orchestrator wrote it) we just log and
 * skip — the orchestrator's own meta.json write will overwrite this
 * field anyway.
 */
async function markMetaPrJoinStatus(
  outDir: string,
  status: 'auth-error' | 'ok',
): Promise<void> {
  const p = path.join(outDir, 'analysis', 'meta.json');
  try {
    const raw = await readFile(p, 'utf8');
    const meta = JSON.parse(raw) as Record<string, unknown>;
    meta['prJoinStatus'] = status;
    atomicWriteJson(p, meta);
  } catch {
    logger.warn(
      `pr-land: meta.json not writable — skipping prJoinStatus=${status} surface`,
    );
  }
}
