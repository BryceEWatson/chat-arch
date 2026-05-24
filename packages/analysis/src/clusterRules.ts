/**
 * Agglomerative single-linkage clustering by cosine similarity.
 *
 * Used by the correction-mining pipeline (Stage 4) to merge embedded
 * `distilledRule` vectors into pattern clusters before the proposal LLM
 * runs. Pure — no I/O, browser-safe, no Node imports.
 *
 * Algorithm:
 *   - Each input vector starts in its own cluster.
 *   - Repeatedly find the pair (i, j) of distinct clusters whose maximum
 *     cross-cluster cosine similarity (max over all member-pairs) is
 *     greatest. If that max is ≥ threshold, merge; otherwise stop.
 *   - Single-linkage permits chaining: A-B and B-C similar but A-C below
 *     threshold still co-merge through B. That is the intended behavior
 *     for distilled-rule clustering, where minor phrasing drift across
 *     a rule chain shouldn't fragment the cluster.
 *
 * O(n²) brute-force per iteration over up to n-1 merges → O(n³) overall.
 * Acceptable: n is in the low hundreds at the upper bound for our usage.
 */

// cosineSimilarity previously inlined here is centralized in
// `stats.ts` (D2 tech-debt sweep) — the correction-pipeline-fed
// Ollama vectors are un-normalized, so we use the general form
// rather than `cosineSimilarityNormalized`.
import { cosineSimilarity } from './stats.js';

/**
 * Cluster vectors via agglomerative single-linkage cosine similarity.
 *
 * Returns an array of cluster ids (0-indexed, dense — no gaps) where
 * `result[i]` is the cluster id of `vectors[i]`. Cluster ids are
 * assigned in ascending order of the smallest input index in each
 * cluster, so re-running on the same input is deterministic.
 *
 * Threshold semantics: `>= threshold` merges (threshold is inclusive).
 */
export function clusterByThreshold(
  vectors: ReadonlyArray<Float32Array>,
  threshold: number,
): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  // Each cluster is a list of input indices.
  let clusters: number[][] = vectors.map((_, i) => [i]);

  while (clusters.length > 1) {
    let bestSim = -Infinity;
    let bestA = -1;
    let bestB = -1;

    for (let i = 0; i < clusters.length; i += 1) {
      const ci = clusters[i] as number[];
      for (let j = i + 1; j < clusters.length; j += 1) {
        const cj = clusters[j] as number[];
        let pairMax = -Infinity;
        for (const a of ci) {
          const va = vectors[a] as Float32Array;
          for (const b of cj) {
            const vb = vectors[b] as Float32Array;
            const s = cosineSimilarity(va, vb);
            if (s > pairMax) pairMax = s;
          }
        }
        if (pairMax > bestSim) {
          bestSim = pairMax;
          bestA = i;
          bestB = j;
        }
      }
    }

    if (bestSim < threshold || bestA < 0 || bestB < 0) break;

    const merged = [
      ...(clusters[bestA] as number[]),
      ...(clusters[bestB] as number[]),
    ];
    const next: number[][] = [];
    for (let k = 0; k < clusters.length; k += 1) {
      if (k === bestA) next.push(merged);
      else if (k === bestB) continue;
      else next.push(clusters[k] as number[]);
    }
    clusters = next;
  }

  // Order cluster ids by the smallest input index in each cluster so
  // the assignment is stable and dense regardless of merge order.
  const ordered = clusters
    .map((members, originalIdx) => ({
      members,
      key: Math.min(...members),
      originalIdx,
    }))
    .sort((a, b) => a.key - b.key);

  const result = new Array<number>(n).fill(-1);
  for (let cid = 0; cid < ordered.length; cid += 1) {
    const entry = ordered[cid] as { members: number[] };
    for (const idx of entry.members) result[idx] = cid;
  }
  return result;
}
