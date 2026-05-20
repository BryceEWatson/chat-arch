/**
 * Calibration API — backs the `/calibrate` page for the threshold-
 * labeling workflow.
 *
 * Three actions (all under one endpoint to keep the route surface
 * small):
 *
 *   GET  /api/calibrate?action=init&band=0.85,0.97&n=100
 *     Computes the pool of pairs in band, samples N deterministically,
 *     reads existing labels from disk, returns the un-labeled subset
 *     in display order. Cached in-process — repeat calls reuse the
 *     pool until the `band` or sample seed changes.
 *
 *   POST /api/calibrate
 *     Body: `{ pairId: "<a>::<b>", nearDup: boolean, cos: number }`
 *     Writes the label to chat-arch-data/labels/threshold-pairs.json
 *     (the same file the CLI labeler at `scripts/label.mjs` writes,
 *     so swapping between web + CLI is lossless).
 *
 *   GET  /api/calibrate?action=sweep
 *     Returns the precision/recall sweep across thresholds 0.85–0.97
 *     given the current labels. Same math as the CLI labeler.
 *
 * CSRF: same gate pattern as `/api/rescan.ts` — only same-origin
 * localhost requests with the X-Requested-With header are allowed.
 */

import type { APIRoute } from 'astro';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

export const prerender = false;

const REQUIRED_HEADER = 'chat-arch-calibrate';
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

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

function dataDir(): string {
  return join(repoRoot(), 'apps', 'standalone', 'public', 'chat-arch-data');
}

interface Pair {
  id: string;
  a: string;
  b: string;
  aTitle: string;
  bTitle: string;
  aPreview: string;
  bPreview: string;
  cos: number;
}

interface LabelStore {
  labels: Record<string, { nearDup: boolean; cos: number }>;
  completed: number;
  lastUpdated: number | null;
}

// In-process cache for the *full* in-band pair set, keyed by the band
// alone. Sampling (stratified or otherwise) is layered on top so cache
// hits survive across different n/strata combos within one Node session.
// Rebuilds on dev-server restart, which is fine for this workflow.
const pairCache = new Map<string, Pair[]>();

async function loadLabels(): Promise<{ store: LabelStore; path: string }> {
  const labelsPath = join(dataDir(), 'labels', 'threshold-pairs.json');
  try {
    const raw = await readFile(labelsPath, 'utf8');
    return { store: JSON.parse(raw), path: labelsPath };
  } catch {
    return {
      store: { labels: {}, completed: 0, lastUpdated: null },
      path: labelsPath,
    };
  }
}

async function saveLabels(store: LabelStore, path: string): Promise<void> {
  store.completed = Object.keys(store.labels).length;
  store.lastUpdated = Date.now();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function sampleN<T>(arr: T[], n: number, seedStr: string): T[] {
  if (arr.length <= n) return arr.slice();
  const rng = mulberry32(hashSeed(seedStr));
  const copy = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]] as [T, T];
  }
  return copy.slice(0, n);
}

interface ManifestEntry {
  id: string;
  title?: string;
  preview?: string | null;
}

interface ManifestFile {
  sessions: ManifestEntry[];
}

interface EmbeddingsMeta {
  dimensions: number;
  entries: Array<{ sessionId: string; offset: number }>;
}

async function computeAllPairs(band: [number, number]): Promise<Pair[]> {
  const key = `${band[0]},${band[1]}`;
  const cached = pairCache.get(key);
  if (cached !== undefined) return cached;

  const metaPath = join(dataDir(), 'analysis', 'embeddings.meta.json');
  const binPath = join(dataDir(), 'analysis', 'embeddings.bin');
  const manifestPath = join(dataDir(), 'manifest.json');

  const meta: EmbeddingsMeta = JSON.parse(await readFile(metaPath, 'utf8'));
  const bin = await readFile(binPath);
  const manifest: ManifestFile = JSON.parse(await readFile(manifestPath, 'utf8'));
  const byId = new Map<string, ManifestEntry>();
  for (const s of manifest.sessions) byId.set(s.id, s);

  const dim = meta.dimensions;
  const stride = dim * 4;
  const vecs: { sessionId: string; v: Float32Array }[] = [];
  for (const e of meta.entries) {
    if (e.offset + stride > bin.length) continue;
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = bin.readFloatLE(e.offset + i * 4);
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
    vecs.push({ sessionId: e.sessionId, v });
  }

  // O(N²) cosine. At N≈500–1000 this is sub-second.
  const all: Pair[] = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      let dot = 0;
      const a = vecs[i]!.v;
      const b = vecs[j]!.v;
      for (let k = 0; k < dim; k++) dot += a[k]! * b[k]!;
      // Inclusive at the top edge — cos=1.0 (perfect duplicates) and
      // any pairs exactly on the band ceiling are part of the
      // calibration surface, not noise to be dropped.
      if (dot >= band[0] && dot <= band[1]) {
        const sa = byId.get(vecs[i]!.sessionId);
        const sb = byId.get(vecs[j]!.sessionId);
        all.push({
          id: `${vecs[i]!.sessionId}::${vecs[j]!.sessionId}`,
          a: vecs[i]!.sessionId,
          b: vecs[j]!.sessionId,
          aTitle: sa?.title ?? '(unknown)',
          bTitle: sb?.title ?? '(unknown)',
          aPreview: sa?.preview ?? '',
          bPreview: sb?.preview ?? '',
          cos: dot,
        });
      }
    }
  }

  pairCache.set(key, all);
  return all;
}

function parseBand(input: string | null): [number, number] {
  if (!input) return [0.85, 1.0];
  const [lo, hi] = input.split(',').map(Number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return [0.85, 1.0];
  return [lo!, hi!];
}

export interface BucketBound {
  lo: number;
  hi: number;
  isLast: boolean;
}

// Equal-width buckets over [band[0], band[1]]. With band [0.85, 1.0]
// and strata 4 you get [0.85, 0.8875), [0.8875, 0.925),
// [0.925, 0.9625), [0.9625, 1.0]. Top bucket is closed on the right.
export function computeBucketBounds(
  band: [number, number],
  strata: number,
): BucketBound[] {
  const width = (band[1] - band[0]) / strata;
  const out: BucketBound[] = [];
  for (let i = 0; i < strata; i++) {
    out.push({
      lo: band[0] + i * width,
      hi: band[0] + (i + 1) * width,
      isLast: i === strata - 1,
    });
  }
  return out;
}

export function bucketIndexFor(
  cos: number,
  band: [number, number],
  strata: number,
): number {
  if (strata <= 1) return 0;
  const width = (band[1] - band[0]) / strata;
  const idx = Math.floor((cos - band[0]) / width);
  return Math.max(0, Math.min(strata - 1, idx));
}

// Stratified sampling: target equal counts per cosine bucket, with the
// remainder of (n mod strata) routed to the lowest-index buckets.
// Buckets that don't have enough pairs simply contribute what they
// can — the deficit is reported to the caller rather than silently
// re-routed to neighbors, since the whole point of stratification is
// to keep the label distribution interpretable.
export function stratifiedSample(
  pairs: Pair[],
  n: number,
  band: [number, number],
  strata: number,
  seed: string,
): Pair[] {
  if (strata <= 1) return sampleN(pairs, n, seed);
  const base = Math.floor(n / strata);
  const remainder = n - base * strata;
  const buckets: Pair[][] = Array.from({ length: strata }, () => []);
  for (const p of pairs) buckets[bucketIndexFor(p.cos, band, strata)]!.push(p);
  const out: Pair[] = [];
  for (let i = 0; i < strata; i++) {
    const target = base + (i < remainder ? 1 : 0);
    const want = Math.min(target, buckets[i]!.length);
    out.push(...sampleN(buckets[i]!, want, `${seed}-bucket-${i}`));
  }
  return out;
}

export interface BucketStat extends BucketBound {
  target: number;
  alreadyLabeled: number;
  deficit: number;
}

// Per-bucket stats from existing labels + target totals. The deficit
// is what the labeler still needs to fill; alreadyLabeled is counted
// from the on-disk labels store using each label's stored cosine.
//
// Labels whose cos falls outside the current band are ignored — they
// don't count toward any bucket (the band changed since they were
// labeled, so they're out-of-scope for this sweep).
export function computeBucketStats(
  labels: LabelStore['labels'],
  band: [number, number],
  strata: number,
  n: number,
): BucketStat[] {
  const bounds = computeBucketBounds(band, strata);
  const base = Math.floor(n / strata);
  const remainder = n - base * strata;
  const stats: BucketStat[] = bounds.map((b, i) => ({
    ...b,
    target: base + (i < remainder ? 1 : 0),
    alreadyLabeled: 0,
    deficit: 0,
  }));
  for (const l of Object.values(labels)) {
    if (typeof l.cos !== 'number') continue;
    if (l.cos < band[0] || l.cos > band[1]) continue;
    const idx = bucketIndexFor(l.cos, band, strata);
    stats[idx]!.alreadyLabeled += 1;
  }
  for (const s of stats) {
    s.deficit = Math.max(0, s.target - s.alreadyLabeled);
  }
  return stats;
}

// Deficit-aware stratified sampling: each bucket draws only as many
// unlabeled pairs as it still needs (target minus already-labeled).
// Existing labels from a prior random pass are not discarded — they
// count toward their bucket, and stratification fills the holes.
export function stratifiedSampleDeficit(
  unlabeledPairs: Pair[],
  stats: BucketStat[],
  band: [number, number],
  strata: number,
  seed: string,
): Pair[] {
  if (strata <= 1) {
    const total = stats.reduce((sum, s) => sum + s.deficit, 0);
    return sampleN(unlabeledPairs, total, seed);
  }
  const buckets: Pair[][] = Array.from({ length: strata }, () => []);
  for (const p of unlabeledPairs) {
    buckets[bucketIndexFor(p.cos, band, strata)]!.push(p);
  }
  const out: Pair[] = [];
  for (let i = 0; i < strata; i++) {
    const want = Math.min(stats[i]!.deficit, buckets[i]!.length);
    out.push(...sampleN(buckets[i]!, want, `${seed}-bucket-${i}`));
  }
  return out;
}

// Wilson CI moved to @chat-arch/analysis/src/stats.ts so the outcome-
// substrate pipeline can share one implementation. Import + re-export
// here to keep existing imports stable AND local call sites working.
import { wilsonCI } from '@chat-arch/analysis';
export { wilsonCI };

export interface SweepRow {
  threshold: number;
  precision: number;
  ciLow: number;
  ciHigh: number;
  recall: number;
  n: number;
}

export function computeSweep(
  labels: LabelStore['labels'],
  band: [number, number] = [0.85, 1.0],
): SweepRow[] {
  const values = Object.values(labels);
  if (values.length === 0) return [];
  const totalPos = values.filter((v) => v.nearDup === true).length;
  const out: SweepRow[] = [];
  const round2 = (x: number) => Math.round(x * 100) / 100;
  for (let t = band[0]; t <= band[1] + 1e-9; t += 0.01) {
    const above = values.filter((v) => v.cos >= t);
    if (above.length === 0) continue;
    const tp = above.filter((v) => v.nearDup === true).length;
    const precision = tp / above.length;
    const recall = totalPos > 0 ? tp / totalPos : 0;
    const ci = wilsonCI(precision, above.length);
    out.push({
      threshold: round2(t),
      precision: round2(precision),
      ciLow: round2(ci.low),
      ciHigh: round2(ci.high),
      recall: round2(recall),
      n: above.length,
    });
  }
  return out;
}

// ---------- Handlers ----------

export const GET: APIRoute = async ({ request, url }) => {
  if (!isLocalOrigin(request.headers.get('origin') ?? request.headers.get('referer'))) {
    // The page itself loads on a same-origin GET — be lenient if origin
    // is absent (Astro fetch from the page) but reject foreign origins.
    const origin = request.headers.get('origin');
    if (origin) return csrfReject('cross-origin GET rejected');
  }

  const action = url.searchParams.get('action');

  if (action === 'init') {
    const band = parseBand(url.searchParams.get('band'));
    const n = Number(url.searchParams.get('n') ?? '100');
    const strataParam = Number(url.searchParams.get('strata') ?? '4');
    const strata = Math.max(
      1,
      Number.isFinite(strataParam) ? Math.floor(strataParam) : 4,
    );
    try {
      const allPairs = await computeAllPairs(band);
      const { store } = await loadLabels();
      const labeled = new Set(Object.keys(store.labels));
      const stats = computeBucketStats(store.labels, band, strata, n);
      const unlabeledPool = allPairs.filter((p) => !labeled.has(p.id));
      const sampled = stratifiedSampleDeficit(
        unlabeledPool,
        stats,
        band,
        strata,
        'seed-threshold',
      );
      const sampledPerBucket = new Array<number>(strata).fill(0);
      for (const p of sampled) {
        sampledPerBucket[bucketIndexFor(p.cos, band, strata)]! += 1;
      }
      const buckets = stats.map((s, i) => ({
        lo: s.lo,
        hi: s.hi,
        isLast: s.isLast,
        target: s.target,
        alreadyLabeled: s.alreadyLabeled,
        deficit: s.deficit,
        sampled: sampledPerBucket[i] ?? 0,
      }));
      const totalTarget = stats.reduce((sum, s) => sum + s.target, 0);
      const totalAlready = stats.reduce((sum, s) => sum + s.alreadyLabeled, 0);
      return new Response(
        JSON.stringify({
          ok: true,
          total: totalTarget,
          labeledCount: totalAlready,
          pairs: sampled,
          completedAll: store.completed,
          band,
          strata,
          buckets,
          poolSize: allPairs.length,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({
          ok: false,
          error: msg,
          hint: 'Embeddings sidecar missing? Run `pnpm exporter run start` with Ollama up.',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }
  }

  if (action === 'sweep') {
    const { store } = await loadLabels();
    return new Response(
      JSON.stringify({
        ok: true,
        sweep: computeSweep(store.labels, [0.85, 1.0]),
        completed: store.completed,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  return new Response(JSON.stringify({ ok: false, error: 'unknown action' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('non-local origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With');
  }

  let body: { pairId?: string; nearDup?: boolean; cos?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'bad JSON' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (
    typeof body.pairId !== 'string' ||
    typeof body.nearDup !== 'boolean' ||
    typeof body.cos !== 'number'
  ) {
    return new Response(JSON.stringify({ ok: false, error: 'bad payload shape' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { store, path } = await loadLabels();
  store.labels[body.pairId] = { nearDup: body.nearDup, cos: body.cos };
  await saveLabels(store, path);
  return new Response(
    JSON.stringify({ ok: true, completed: store.completed }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
