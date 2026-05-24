/**
 * Blog candidate selector — spec §5 Blog.1.
 *
 * Pure function. Given the manifest sessions + their discovery scores +
 * their embeddings + optional cross-corpus audit data, returns a ranked
 * list of `BlogCandidate`s. Candidates are clusters of high-discovery-
 * score sessions sharing a topical signal (cosine ≥ 0.78) and a multi-
 * day narrative arc.
 *
 * The draft generator (Blog.2) consumes the top-N candidates. Draft
 * generation requires an LLM call (chat-answer skill in draft mode);
 * this kernel is pure and does no inference.
 */

import type {
  BlogCandidate,
  BlogCandidatesFile,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { cosineSimilarityNormalized } from './classifyByEmbedding.js';

export const DEFAULT_BLOG_DISCOVERY_THRESHOLD = 0.7;
export const DEFAULT_BLOG_CLUSTER_THRESHOLD = 0.78;
export const DEFAULT_MIN_CLUSTER_SIZE = 2;
export const DEFAULT_NARRATIVE_ARC_DAYS = 3;

export interface BuildBlogCandidatesOptions {
  /** Min discoveryScore for cluster admission. */
  discoveryScoreThreshold?: number;
  /** Cosine threshold for clustering. */
  clusterThreshold?: number;
  /** Min sessions per cluster. */
  minClusterSize?: number;
  /** Minimum cluster span in days to be a candidate. */
  narrativeArcDays?: number;
  /**
   * Optional: per-session audit pass rate (from F-layer). When absent,
   * meanAuditPassRate falls back to null and the score component is
   * skipped.
   */
  sessionAuditPassRate?: ReadonlyMap<string, number>;
  /**
   * Optional novelty vectors — embeddings of titles/excerpts from posts
   * already on the user's site. The candidate's noveltyScore = 1 -
   * max-cosine-against-this-set. Empty = treat all candidates as novel.
   */
  noveltyReferenceVectors?: readonly Float32Array[];
  now?: number;
}

interface InputRow {
  entry: UnifiedSessionEntry;
  vector: Float32Array;
  discoveryScore: number;
}

function dotNorm(v: Float32Array): number {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] ?? 0;
    n += x * x;
  }
  return Math.sqrt(n);
}

function normalize(v: Float32Array): Float32Array {
  const n = dotNorm(v);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] ?? 0) / n;
  return out;
}

function novelty(v: Float32Array, refs: readonly Float32Array[]): number {
  if (refs.length === 0) return 1;
  let maxSim = -1;
  for (const r of refs) {
    const sim = cosineSimilarityNormalized(v, r);
    if (sim > maxSim) maxSim = sim;
  }
  return Math.max(0, Math.min(1, 1 - maxSim));
}

export function buildBlogCandidates(
  sessions: readonly UnifiedSessionEntry[],
  embeddings: ReadonlyMap<string, Float32Array>,
  options: BuildBlogCandidatesOptions = {},
): BlogCandidatesFile {
  const discoveryThreshold = options.discoveryScoreThreshold ?? DEFAULT_BLOG_DISCOVERY_THRESHOLD;
  const clusterThreshold = options.clusterThreshold ?? DEFAULT_BLOG_CLUSTER_THRESHOLD;
  const minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const arcDays = options.narrativeArcDays ?? DEFAULT_NARRATIVE_ARC_DAYS;
  const now = options.now ?? Date.now();
  const auditMap = options.sessionAuditPassRate;
  const noveltyRefs = (options.noveltyReferenceVectors ?? []).map(normalize);

  // Eligible: have an embedding AND discoveryScore ≥ threshold.
  const rows: InputRow[] = [];
  for (const s of sessions) {
    if (s.transcriptStatus === 'pruned') continue;
    if (typeof s.discoveryScore !== 'number') continue;
    if (s.discoveryScore < discoveryThreshold) continue;
    const v = embeddings.get(s.id);
    if (v === undefined) continue;
    rows.push({ entry: s, vector: normalize(v), discoveryScore: s.discoveryScore });
  }

  if (rows.length < minClusterSize) {
    return {
      version: 1,
      generatedAt: now,
      clusterThreshold,
      discoveryScoreThreshold: discoveryThreshold,
      candidates: [],
    };
  }

  // Union-find on cluster threshold.
  const parent: number[] = rows.map((_, i) => i);
  function find(x: number): number {
    let cur = x;
    while (parent[cur] !== cur) {
      const next = parent[cur] as number;
      parent[cur] = parent[next] as number;
      cur = parent[cur] as number;
    }
    return cur;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const ri = rows[i];
    if (ri === undefined) continue;
    for (let j = i + 1; j < rows.length; j += 1) {
      const rj = rows[j];
      if (rj === undefined) continue;
      const sim = cosineSimilarityNormalized(ri.vector, rj.vector);
      if (sim >= clusterThreshold) union(i, j);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i += 1) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list === undefined) byRoot.set(r, [i]);
    else list.push(i);
  }

  const candidates: BlogCandidate[] = [];
  let nextId = 0;
  for (const members of byRoot.values()) {
    if (members.length < minClusterSize) continue;

    const memberRows = members
      .map((i) => rows[i])
      .filter((r): r is InputRow => r !== undefined);
    if (memberRows.length === 0) continue;

    // Centroid by discoveryScore (most signal-bearing session).
    const sortedByDiscovery = [...memberRows].sort(
      (a, b) => b.discoveryScore - a.discoveryScore,
    );
    const meanDiscovery =
      memberRows.reduce((acc, m) => acc + m.discoveryScore, 0) / memberRows.length;

    // Span days.
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    for (const m of memberRows) {
      if (m.entry.startedAt < earliest) earliest = m.entry.startedAt;
      if (m.entry.updatedAt > latest) latest = m.entry.updatedAt;
    }
    const spanDays = (latest - earliest) / 86_400_000;
    if (spanDays < arcDays) continue;

    // Audit pass rate.
    let meanAuditPassRate: number | null = null;
    if (auditMap !== undefined) {
      const values: number[] = [];
      for (const m of memberRows) {
        const p = auditMap.get(m.entry.id);
        if (typeof p === 'number') values.push(p);
      }
      if (values.length > 0) {
        meanAuditPassRate = values.reduce((a, b) => a + b, 0) / values.length;
      }
    }

    // Novelty: take the centroid (top-discovery) vector against the
    // novelty references.
    const noveltyScore = novelty(sortedByDiscovery[0]?.vector ?? memberRows[0]!.vector, noveltyRefs);

    // Composite score: equal weights on discovery, audit, and novelty,
    // plus a small bonus for cluster size (capped at 4).
    const sizeBonus = Math.min(memberRows.length, 4) / 4;
    const auditComponent = meanAuditPassRate ?? 0.5;
    const score =
      0.35 * meanDiscovery +
      0.25 * auditComponent +
      0.25 * noveltyScore +
      0.15 * sizeBonus;

    candidates.push({
      id: `blog-candidate-${nextId}`,
      clusterSessionIds: sortedByDiscovery.map((r) => r.entry.id),
      meanDiscoveryScore: meanDiscovery,
      meanAuditPassRate,
      spanDays,
      noveltyScore,
      score,
      workingTitle:
        sortedByDiscovery[0]?.entry.title?.trim() ?? memberRows[0]!.entry.title.trim(),
    });
    nextId += 1;
  }

  candidates.sort((a, b) => b.score - a.score);

  return {
    version: 1,
    generatedAt: now,
    clusterThreshold,
    discoveryScoreThreshold: discoveryThreshold,
    candidates,
  };
}
