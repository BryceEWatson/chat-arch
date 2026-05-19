/**
 * Semantic-duplicate clustering — spec §7 acceptance #3.
 *
 * Pairs the embedding sidecar with a cosine-similarity clustering pass.
 * Distinct from `duplicates.exact.json` (first-human-text hash);
 * semantic dedup catches sessions that ask the same thing in different
 * words.
 *
 * Scale ceiling (2026-05 audit):
 *
 *   Pairwise cosine is O(N²) in the input length. Empirically (1k × 768
 *   dims, mxbai-embed-large, V8): ~0.3s at N=1k, ~20s at N=10k, ~30min
 *   at N=100k. The 1k regime is the current corpus; 10k is the
 *   stretch target.
 *
 *   Future-proofing path when corpus crosses ~20k: replace the inner
 *   pairwise loop with HNSW (Malkov & Yashunin 2018) top-k retrieval
 *   thresholded at the cosine cutoff. Library survey (2026-05) ranked
 *   pure-TS `hnsw` (npm, MIT) first — adequate at this scale, zero
 *   native deps, browser-safe. `usearch` (prebuilt N-API binaries) is
 *   the fallback if pure-JS perf becomes the bottleneck. Native
 *   `hnswlib-node` (node-gyp) is rejected — breaks Windows CI.
 *
 *   Not done today because brute-force at 1k is <10ms and adds zero
 *   dependency surface; HNSW would just be carrying weight.
 *
 * Linkage choice — single vs complete:
 *
 *   `single` (default, the original implementation): any pair above
 *     threshold links its members; connected components are the clusters.
 *     Fast, simple, and historically what this module emitted. The
 *     well-known downside (Stanford IR Book, §17.3) is *chaining*:
 *     A~B at 0.92, B~C at 0.92, C~D at 0.92 transitively merges A and D
 *     even if cos(A,D) is only 0.80. At small N this rarely bites; at
 *     10k+ sessions it produces visible mega-clusters.
 *
 *   `complete`: a candidate merge is only accepted when *every* cross-
 *     cluster pair stays above threshold. Compact, non-transitive
 *     clusters that match the user's intuition of "these really are
 *     near-duplicates of each other." Adds an O(N) per-merge link-cost
 *     check on top of the N² similarity build, so wall-clock at small
 *     N is similar; at large N the merge loop is the dominant term and
 *     stays under the O(N³) worst case in practice because most pairs
 *     fall below threshold.
 *
 * New callers should prefer `complete` unless they specifically want the
 * permissive chaining of the union-find path (e.g. for "show me anything
 * remotely related" exploration). Default stays `single` to preserve
 * existing sidecar contents byte-for-byte until a caller opts in.
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
import {
  DEFAULT_P_NEAR_DUP_TARGET,
  evaluateCalibration,
  type CalibrationCurve,
} from './calibration.js';

/**
 * Cosine threshold above which two sessions are considered near-
 * duplicates. **Calibrated against the user's actual corpus** via the
 * /calibrate page (2026-05): 100 random pairs in [0.85, 0.97) hand-
 * labeled "near-dup / not", producing the precision/recall sweep:
 *
 *   threshold  precision  recall  n     verdict
 *   0.92       0.86       0.77    58    (literature default, too loose)
 *   0.93       0.87       0.74    55
 *   0.94       0.90       0.57    41    ← picked: precision-leaning
 *   0.95       0.88       0.34    25    (sample too small to trust)
 *   0.96       0.93       0.20    14    (sample too small to trust)
 *
 * 0.94 trades ~25% of true-dup recall for ~30% fewer false positives
 * vs the prior 0.92. Picked over 0.93 because the "duplicates" view
 * erodes user trust faster on false hits than on missed ones — when
 * someone sees two sessions clustered, they expect those two sessions
 * to be near-identical, not just topically similar.
 *
 * Precision never crosses 0.95 in this band on this embedder
 * (mxbai-embed-large at 768d); the precision plateau between 0.87 and
 * 0.93 suggests the embedder doesn't cleanly separate "near-duplicate"
 * from "topically very similar" at any sharp cutoff. The next
 * calibration pass should extend the band above 0.97 to see whether
 * the very-high-cos region is reliably ≥0.95 precision.
 */
export const DEFAULT_SEMANTIC_DUP_THRESHOLD = 0.94;

export type SemanticDupLinkage = 'single' | 'complete';

export interface SemanticDupInput {
  /** UnifiedSessionEntry.id of one session, plus its embedding. */
  sessionId: string;
  vector: Float32Array;
}

export interface BuildSemanticDuplicatesOptions {
  /**
   * Raw cosine threshold (default DEFAULT_SEMANTIC_DUP_THRESHOLD).
   * Ignored when `calibration` is provided — the calibrated path uses
   * `pTarget` in probability space instead.
   */
  threshold?: number;
  /**
   * Isotonic calibration curve mapping cos → P(near-duplicate). When
   * present, pairs are accepted iff `evaluateCalibration(curve, cos)
   * >= pTarget` (default 0.5). See packages/analysis/src/
   * calibration.ts and research/dedup-calibration-design.md for the
   * design rationale (Park et al. 2026 anisotropy fix).
   */
  calibration?: CalibrationCurve;
  /**
   * Target probability when calibration is in use (default 0.5 —
   * "more likely than not"). Higher = fewer, more precise flags.
   * Ignored when `calibration` is absent.
   */
  pTarget?: number;
  /**
   * Pairs that already appear together in `duplicates.exact.json` —
   * those are not "near-dup" by the spec's wording (they're exact dups,
   * already surfaced). Provide as a set of `sessionIdA::sessionIdB`
   * keys with sessionIdA < sessionIdB lexicographically.
   */
  excludePairs?: ReadonlySet<string>;
  /**
   * How to group passing pairs into clusters. Default `'single'`
   * preserves the original union-find behaviour. See module header for
   * why `'complete'` is the recommended choice for new callers.
   */
  linkage?: SemanticDupLinkage;
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
 * Lowest cosine at which a calibration curve crosses `pTarget`. Used
 * to feed the complete-linkage merge loop a sentinel raw-cosine cutoff
 * — anything below this is guaranteed to fail `accept`, so the merge
 * loop can keep its existing "best similarity < threshold → stop" API
 * without bifurcating into a calibrated path.
 *
 * Walk the knots left-to-right; return the cos of the first knot whose
 * `p >= pTarget`. If no knot meets the target, return Infinity so the
 * merge loop terminates immediately.
 */
function minCosForTarget(curve: CalibrationCurve, pTarget: number): number {
  for (const knot of curve.knots) {
    if (knot.p >= pTarget) return knot.cos;
  }
  return Infinity;
}

/**
 * Single-linkage grouping via union-find. Any cross-pair above threshold
 * unions its two members. Returns one Set of member indices per cluster.
 */
function singleLinkageGroups(
  passingPairs: ReadonlyArray<{ a: number; b: number }>,
  totalMembers: number,
): number[][] {
  const parent: number[] = Array.from({ length: totalMembers }, (_, i) => i);
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      const next = parent[cur] as number;
      parent[cur] = parent[next] as number;
      cur = parent[cur] as number;
    }
    return cur;
  };
  for (const { a, b } of passingPairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < totalMembers; i += 1) {
    const r = find(i);
    const list = byRoot.get(r);
    if (list === undefined) byRoot.set(r, [i]);
    else list.push(i);
  }
  return [...byRoot.values()];
}

/**
 * Complete-linkage grouping. Starts with every member as its own
 * cluster. At each step finds the cluster pair whose *minimum* cross-
 * member similarity is highest and merges them — but only if that
 * minimum still beats `threshold` (otherwise stop). Equivalent to the
 * `discoverClusters.completeLinkageClusters` kernel; inlined here to
 * avoid a public-API expansion and keep this module self-contained.
 */
function completeLinkageGroups(
  vectors: ReadonlyArray<Float32Array>,
  passingPairs: ReadonlyArray<{ a: number; b: number; sim: number }>,
  threshold: number,
): number[][] {
  const n = vectors.length;
  if (n === 0) return [];

  // simMatrix[i,j] lookup; pairs not in `passingPairs` are below
  // threshold and will never satisfy complete-linkage anyway, so we
  // can record them as -Infinity (any merge containing them is dead).
  const simKey = (i: number, j: number): number => (i < j ? i * n + j : j * n + i);
  const sim = new Float32Array(n * n);
  // Sentinel: -Infinity not representable in Float32; use a very-negative
  // number that any real cosine (≤ 1) trivially exceeds. NaN is also
  // unsafe because the min() reduction would propagate. -2 works:
  // cosine ≥ -1 always.
  sim.fill(-2);
  for (const p of passingPairs) sim[simKey(p.a, p.b)] = p.sim;

  // Active cluster list (each is a list of original member indices).
  const clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const activeIds: number[] = clusters.map((_, i) => i);

  // Cache the min-pair-similarity between each active pair, refreshed
  // on every merge that touched one of them.
  const linkSim = new Map<string, number>();
  const linkKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const computeLink = (a: number, b: number): number => {
    const ma = clusters[a] as number[];
    const mb = clusters[b] as number[];
    let minSim = Infinity;
    for (const x of ma) {
      for (const y of mb) {
        const s = sim[simKey(x, y)] as number;
        if (s < minSim) minSim = s;
      }
    }
    return minSim;
  };
  for (let a = 0; a < activeIds.length; a += 1) {
    for (let b = a + 1; b < activeIds.length; b += 1) {
      const idA = activeIds[a] as number;
      const idB = activeIds[b] as number;
      linkSim.set(linkKey(idA, idB), sim[simKey(idA, idB)] as number);
    }
  }

  while (true) {
    let bestSim = -Infinity;
    let bestA = -1;
    let bestB = -1;
    for (let a = 0; a < activeIds.length; a += 1) {
      for (let b = a + 1; b < activeIds.length; b += 1) {
        const idA = activeIds[a] as number;
        const idB = activeIds[b] as number;
        const s = linkSim.get(linkKey(idA, idB));
        if (s !== undefined && s > bestSim) {
          bestSim = s;
          bestA = idA;
          bestB = idB;
        }
      }
    }
    if (bestSim < threshold || bestA === -1) break;

    // Merge B into A.
    const merged = [
      ...(clusters[bestA] as number[]),
      ...(clusters[bestB] as number[]),
    ];
    clusters[bestA] = merged;
    clusters[bestB] = [];
    activeIds.splice(activeIds.indexOf(bestB), 1);

    for (let k = 0; k < activeIds.length; k += 1) {
      const idK = activeIds[k] as number;
      if (idK === bestA) continue;
      linkSim.delete(linkKey(bestA, idK));
      linkSim.delete(linkKey(bestB, idK));
      linkSim.set(linkKey(bestA, idK), computeLink(bestA, idK));
    }
  }

  return activeIds.map((id) => clusters[id] as number[]);
}

export function buildSemanticDuplicates(
  inputs: readonly SemanticDupInput[],
  options: BuildSemanticDuplicatesOptions = {},
): DuplicatesSemanticFile {
  const threshold = options.threshold ?? DEFAULT_SEMANTIC_DUP_THRESHOLD;
  const calibration = options.calibration;
  const pTarget = options.pTarget ?? DEFAULT_P_NEAR_DUP_TARGET;
  const exclude = options.excludePairs ?? new Set<string>();
  const linkage: SemanticDupLinkage = options.linkage ?? 'single';
  const now = options.now ?? Date.now();

  // Pair acceptance predicate. When a calibration curve is supplied,
  // we threshold on calibrated P(near-dup), not raw cosine — this is
  // the Park-et-al. anisotropy fix. Falls back to the cosine cutoff
  // when no curve is present (cold start, or installs that opted out
  // of auto-labeling).
  const accept = (sim: number): boolean => {
    if (calibration !== undefined) {
      return evaluateCalibration(calibration, sim) >= pTarget;
    }
    return sim >= threshold;
  };
  // Linkage code paths still use a "threshold" sentinel for the
  // complete-linkage merge loop. With calibration we feed it the
  // lowest cosine whose calibrated P meets pTarget — anything below
  // that is guaranteed to fail `accept`, so it's a sound shortcut
  // that keeps the merge-loop API stable without bifurcating it.
  const effectiveThreshold = calibration === undefined
    ? threshold
    : minCosForTarget(calibration, pTarget);

  // Normalize once.
  const normalized: { sessionId: string; vector: Float32Array }[] = inputs.map((i) => ({
    sessionId: i.sessionId,
    vector: normalize(i.vector),
  }));
  const vectors = normalized.map((n) => n.vector);

  // O(N²) pairwise — collect everything above threshold (and not excluded).
  const pairs: Array<{ a: number; b: number; sim: number }> = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const ni = normalized[i];
    if (ni === undefined) continue;
    for (let j = i + 1; j < normalized.length; j += 1) {
      const nj = normalized[j];
      if (nj === undefined) continue;
      if (exclude.has(pairKey(ni.sessionId, nj.sessionId))) continue;
      const sim = cosineSimilarityNormalized(ni.vector, nj.vector);
      if (!accept(sim)) continue;
      pairs.push({ a: i, b: j, sim });
    }
  }

  // Linkage-specific grouping.
  const groups =
    linkage === 'complete'
      ? completeLinkageGroups(vectors, pairs, effectiveThreshold)
      : singleLinkageGroups(pairs, normalized.length);

  const clusters: DuplicatesSemanticCluster[] = [];
  let nextId = 0;
  for (const members of groups) {
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
    let bestIndex = members[0] as number;
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
