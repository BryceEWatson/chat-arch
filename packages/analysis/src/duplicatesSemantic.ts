/**
 * Semantic-duplicate clustering — spec §7 acceptance #3.
 *
 * Pairs the embedding sidecar with a single-linkage cosine clustering
 * pass. Distinct from `duplicates.exact.json` (first-human-text hash);
 * semantic dedup catches sessions that ask the same thing in different
 * words.
 *
 * Pure. Browser-safe. The caller provides the vectors (Float32Array per
 * sessionId) — the Node I/O shell reads `analysis/embeddings.bin` +
 * `embeddings.meta.json` and passes them in.
 */

import type {
  DuplicatesSemanticCluster,
  DuplicatesSemanticFile,
} from '@chat-arch/schema';
import { cosineSimilarityNormalized } from './classifyByEmbedding.js';

export const DEFAULT_SEMANTIC_DUP_THRESHOLD = 0.92;

export interface SemanticDupInput {
  /** UnifiedSessionEntry.id of one session, plus its embedding. */
  sessionId: string;
  vector: Float32Array;
}

export interface BuildSemanticDuplicatesOptions {
  /** Cosine threshold (default 0.92 — tight; we want true near-dups, not topics). */
  threshold?: number;
  /**
   * Pairs that already appear together in `duplicates.exact.json` —
   * those are not "near-dup" by the spec's wording (they're exact dups,
   * already surfaced). Provide as a set of `sessionIdA::sessionIdB`
   * keys with sessionIdA < sessionIdB lexicographically.
   */
  excludePairs?: ReadonlySet<string>;
  /** Override Date.now() for tests. */
  now?: number;
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

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Single-pass O(N^2) pairwise cosine; at the user's corpus scale (≤ ~2k
 * embedded sessions × 768 dims) this is ~4M dot products — sub-second.
 * Vectors are pre-normalized so each comparison is one dot product.
 *
 * Groups via union-find: any pair above threshold links its members; the
 * resulting connected components are the clusters. Skips clusters of size
 * < 2 (singleton sessions aren't duplicates).
 */
export function buildSemanticDuplicates(
  inputs: readonly SemanticDupInput[],
  options: BuildSemanticDuplicatesOptions = {},
): DuplicatesSemanticFile {
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_DUP_THRESHOLD;
  const exclude = options.excludePairs ?? new Set<string>();
  const now = options.now ?? Date.now();

  // Normalize once.
  const normalized: { sessionId: string; vector: Float32Array }[] = inputs.map((i) => ({
    sessionId: i.sessionId,
    vector: normalize(i.vector),
  }));

  // Union-find scaffolding.
  const parent: number[] = normalized.map((_, i) => i);
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

  // Per-pair similarities, kept for centroid + mean-sim computation.
  // Map from componentRoot → list of {a, b, sim}.
  const pairs: Array<{ a: number; b: number; sim: number }> = [];

  for (let i = 0; i < normalized.length; i += 1) {
    const ni = normalized[i];
    if (ni === undefined) continue;
    for (let j = i + 1; j < normalized.length; j += 1) {
      const nj = normalized[j];
      if (nj === undefined) continue;
      if (exclude.has(pairKey(ni.sessionId, nj.sessionId))) continue;
      const sim = cosineSimilarityNormalized(ni.vector, nj.vector);
      if (sim < threshold) continue;
      pairs.push({ a: i, b: j, sim });
      union(i, j);
    }
  }

  // Bucket member indices by root, then build clusters.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < normalized.length; i += 1) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list === undefined) byRoot.set(r, [i]);
    else list.push(i);
  }

  const clusters: DuplicatesSemanticCluster[] = [];
  let nextId = 0;
  for (const [root, members] of byRoot) {
    if (members.length < 2) continue;
    const memberSet = new Set<number>(members);
    const memberPairs = pairs.filter((p) => memberSet.has(p.a) && memberSet.has(p.b));
    if (memberPairs.length === 0) continue;

    const meanSim =
      memberPairs.reduce((acc, p) => acc + p.sim, 0) / memberPairs.length;

    // Centroid: the member whose summed similarity to other members is
    // highest. Cheap weighted-degree computation over the member graph.
    const degree = new Map<number, number>();
    for (const p of memberPairs) {
      degree.set(p.a, (degree.get(p.a) ?? 0) + p.sim);
      degree.set(p.b, (degree.get(p.b) ?? 0) + p.sim);
    }
    let bestIndex = members[0] ?? root;
    let bestScore = -Infinity;
    for (const m of members) {
      const d = degree.get(m) ?? 0;
      if (d > bestScore) {
        bestScore = d;
        bestIndex = m;
      }
    }
    const centroidSessionId = normalized[bestIndex]?.sessionId ?? '';

    // Order members by descending similarity-to-centroid.
    const centroidVec = normalized[bestIndex]?.vector;
    const orderedIds = [...members]
      .map((m) => {
        const v = normalized[m]?.vector;
        const sim =
          centroidVec !== undefined && v !== undefined
            ? cosineSimilarityNormalized(centroidVec, v)
            : 0;
        return { sessionId: normalized[m]?.sessionId ?? '', sim };
      })
      .sort((x, y) => y.sim - x.sim)
      .map((x) => x.sessionId);

    clusters.push({
      id: `dup-semantic-${nextId}`,
      sessionIds: orderedIds,
      centroidSessionId,
      meanSimilarity: meanSim,
    });
    nextId += 1;
  }

  // Stable order: by largest cluster first, then by centroidSessionId.
  clusters.sort((a, b) => {
    if (b.sessionIds.length !== a.sessionIds.length) {
      return b.sessionIds.length - a.sessionIds.length;
    }
    return a.centroidSessionId < b.centroidSessionId ? -1 : 1;
  });

  return {
    version: 1,
    generatedAt: now,
    threshold,
    clusters,
  };
}
