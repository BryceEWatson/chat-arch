/**
 * Workflow archetype detection (#5 in the outcome-substrate roadmap).
 *
 * Per-session feature vector → k-means → centroid summary. Picks `k` in
 * a small range (5–7 by default) by silhouette score on the assigned
 * features. Centroids are hashed to produce an `archetypeVersion` so the
 * viewer can detect drift across re-runs and trigger a relabel.
 *
 * Feature vector (length 9):
 *
 *   0  normalize(readCount)
 *   1  normalize(editCount)
 *   2  normalize(bashCount)
 *   3  normalize(grepCount)
 *   4  normalize(globCount)
 *   5  normalize(webFetchCount)
 *   6  editToReadRatio              (editCount / (readCount + editCount))
 *   7  longestSameToolRunFraction   (longest same-tool run / total tools)
 *   8  hasPlanTool                  (0 or 1 — ExitPlanMode / TodoWrite presence)
 *
 * `normalize` is per-feature min-max scaling across the input cohort so
 * tool-count magnitudes don't dominate the ratio features. Ratios are
 * already in [0,1] so the function is identity for indices 6–8.
 *
 * Browser-safe — no Node imports. Reuses `kmeansCluster` and the
 * `THRESHOLDS` config; defines a local silhouette helper because
 * `kmeansCluster.ts` doesn't yet export one.
 */

import { kmeansCluster } from './kmeansCluster.js';
import { euclidean } from './stats.js';
import { THRESHOLDS } from './thresholds.js';

export interface SessionToolStats {
  /** Stable session id. */
  readonly sessionId: string;
  readonly readCount: number;
  readonly editCount: number;
  readonly bashCount: number;
  readonly grepCount: number;
  readonly globCount: number;
  readonly webFetchCount: number;
  /**
   * Length of the longest run of the same tool name in the session.
   * Caller computes this from the timeline — passing 0 when unknown
   * collapses feature 7 to 0, which is the right behavior for very-low-
   * activity sessions.
   */
  readonly longestSameToolRun: number;
  /** Total tool calls in the session (denominator for run-length fraction). */
  readonly totalToolCalls: number;
  /** Whether the session used a planning tool (ExitPlanMode/TodoWrite). */
  readonly hasPlanTool: boolean;
}

export interface DetectArchetypesOptions {
  /** Candidate k values to sweep. Default [5, 6, 7]. */
  readonly kCandidates?: readonly number[];
  /** PRNG seed for k-means determinism. Default 42. */
  readonly seed?: number;
  /**
   * Per-archetype minimum cluster size to be included in `centroids[]`.
   * Default `THRESHOLDS.clustering.archetypeMinSize` (20).
   */
  readonly archetypeMinSize?: number;
  /**
   * Minimum silhouette score for the chosen k to be considered "good
   * enough". Default `THRESHOLDS.clustering.silhouetteMin` (0.15).
   * If no candidate clears the floor, the best-silhouette k is still
   * returned but `silhouette` will reflect that value (callers can gate
   * downstream behavior).
   */
  readonly silhouetteFloor?: number;
}

export interface ArchetypeCentroid {
  /** Stable id within this run — `archetype-<index>` after sorting by size. */
  readonly archetypeId: string;
  /** Centroid vector in the SAME normalized space as `featureVectors`. */
  readonly vector: readonly number[];
  /** Number of sessions assigned to this archetype. */
  readonly sessionCount: number;
}

export interface ArchetypesResult {
  /** Centroids passing the `archetypeMinSize` guard, sorted descending by sessionCount. */
  readonly centroids: ArchetypeCentroid[];
  /**
   * Per-session archetype assignment. Sessions whose home cluster fell
   * below the min-size guard are still assigned to the closest qualifying
   * centroid — callers that want a "uncluttered" map can filter to only
   * sessions whose archetype is in `centroids[]`.
   *
   * Sessions whose home cluster fell below the guard AND no centroid
   * qualified are mapped to `null`.
   */
  readonly assignments: Record<string, string | null>;
  /** Silhouette score at the chosen k. NaN when fewer than 2 clusters survive. */
  readonly silhouette: number;
  /** Chosen k after the silhouette sweep. */
  readonly chosenK: number;
  /**
   * 32-bit FNV-1a hash of the (rounded) centroid vectors after sorting,
   * formatted as a decimal integer. Used by the viewer to detect drift
   * across re-runs — when this changes, hand-labels need a refresh.
   */
  readonly archetypeVersion: number;
}

const DEFAULT_K_CANDIDATES: readonly number[] = [5, 6, 7];

/**
 * Compute archetypes for a set of sessions. The kernel is pure: same
 * input + same seed → same output.
 */
export function detectArchetypes(
  sessions: readonly SessionToolStats[],
  opts: DetectArchetypesOptions = {},
): ArchetypesResult {
  const kCandidates = opts.kCandidates ?? DEFAULT_K_CANDIDATES;
  const seed = opts.seed ?? 42;
  const archetypeMinSize =
    opts.archetypeMinSize ?? THRESHOLDS.clustering.archetypeMinSize;

  if (sessions.length === 0) {
    return {
      centroids: [],
      assignments: {},
      silhouette: Number.NaN,
      chosenK: 0,
      archetypeVersion: 0,
    };
  }

  // 1. Build raw feature vectors.
  const raw = sessions.map((s) => rawFeatureVector(s));

  // 2. Min-max normalize tool-count columns (0..5); leave ratio columns alone.
  const normalized = minMaxNormalize(raw, [0, 1, 2, 3, 4, 5]);

  // 3. Sweep k; pick the candidate with the best silhouette score.
  let best: {
    k: number;
    assignmentByIndex: number[];
    centroidByCluster: Map<number, number[]>;
    sizesByCluster: Map<number, number>;
    silhouette: number;
  } | null = null;

  for (const k of kCandidates) {
    if (k <= 1 || k > sessions.length) continue;
    const inputs = normalized.map((vec, i) => ({
      id: sessions[i]!.sessionId,
      vector: vec,
      tokens: [],
    }));
    const clusters = kmeansCluster(inputs, { k, seed });
    if (clusters.length < 2) continue;

    // Re-derive per-session cluster index (kmeansCluster returns
    // `kmeans-<i>`-keyed groups). Keep the int index for centroid math.
    const assignmentByIndex = new Array<number>(sessions.length).fill(-1);
    const sessionIdToIndex = new Map<string, number>();
    sessions.forEach((s, i) => sessionIdToIndex.set(s.sessionId, i));
    for (const c of clusters) {
      const m = /^kmeans-(\d+)$/.exec(c.id);
      const ci = m ? Number.parseInt(m[1]!, 10) : -1;
      if (ci < 0) continue;
      for (const memberId of c.memberIds) {
        const sessionIdx = sessionIdToIndex.get(memberId);
        if (sessionIdx === undefined) continue;
        assignmentByIndex[sessionIdx] = ci;
      }
    }

    // Compute centroid means and sizes from the (index → cluster) map.
    const centroidByCluster = new Map<number, number[]>();
    const sizesByCluster = new Map<number, number>();
    for (let i = 0; i < normalized.length; i++) {
      const ci = assignmentByIndex[i]!;
      if (ci < 0) continue;
      sizesByCluster.set(ci, (sizesByCluster.get(ci) ?? 0) + 1);
      const acc = centroidByCluster.get(ci);
      if (acc === undefined) {
        centroidByCluster.set(ci, normalized[i]!.slice());
      } else {
        const v = normalized[i]!;
        for (let d = 0; d < acc.length; d++) acc[d]! += v[d]!;
      }
    }
    for (const [ci, acc] of centroidByCluster) {
      const n = sizesByCluster.get(ci) ?? 1;
      for (let d = 0; d < acc.length; d++) acc[d]! /= n;
    }

    const silhouette = computeSilhouette(normalized, assignmentByIndex);

    if (best === null || silhouette > best.silhouette) {
      best = { k, assignmentByIndex, centroidByCluster, sizesByCluster, silhouette };
    }
  }

  if (best === null) {
    return {
      centroids: [],
      assignments: Object.fromEntries(sessions.map((s) => [s.sessionId, null])),
      silhouette: Number.NaN,
      chosenK: 0,
      archetypeVersion: 0,
    };
  }

  // 4. Filter centroids by archetypeMinSize and assign stable archetype ids
  // (sorted by size descending so archetype-0 is always the largest).
  const sortedClusters = [...best.sizesByCluster.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, size]) => size >= archetypeMinSize);

  const clusterIdxToArchetypeId = new Map<number, string>();
  const centroidsOut: ArchetypeCentroid[] = sortedClusters.map(
    ([ci, size], rank) => {
      const id = `archetype-${rank}`;
      clusterIdxToArchetypeId.set(ci, id);
      return {
        archetypeId: id,
        vector: best!.centroidByCluster.get(ci) ?? [],
        sessionCount: size,
      };
    },
  );

  // 5. Build assignments. Sessions in surviving centroids → their archetypeId;
  // sessions in dropped clusters → closest surviving centroid, or null if
  // none survived.
  const assignments: Record<string, string | null> = {};
  for (let i = 0; i < sessions.length; i++) {
    const ci = best.assignmentByIndex[i]!;
    const homeArchetypeId = clusterIdxToArchetypeId.get(ci);
    if (homeArchetypeId !== undefined) {
      assignments[sessions[i]!.sessionId] = homeArchetypeId;
      continue;
    }
    if (centroidsOut.length === 0) {
      assignments[sessions[i]!.sessionId] = null;
      continue;
    }
    // Re-attach to nearest surviving centroid.
    let nearestId: string | null = null;
    let nearestD = Number.POSITIVE_INFINITY;
    const vec = normalized[i]!;
    for (const c of centroidsOut) {
      const d = euclidean(vec, c.vector);
      if (Number.isFinite(d) && d < nearestD) {
        nearestD = d;
        nearestId = c.archetypeId;
      }
    }
    assignments[sessions[i]!.sessionId] = nearestId;
  }

  const archetypeVersion = hashCentroids(centroidsOut);

  return {
    centroids: centroidsOut,
    assignments,
    silhouette: best.silhouette,
    chosenK: best.k,
    archetypeVersion,
  };
}

/**
 * Build the raw (un-normalized) feature vector for one session.
 * Indices 6–8 are already in [0, 1]; indices 0–5 are tool counts.
 */
function rawFeatureVector(s: SessionToolStats): number[] {
  const editToReadRatio =
    s.readCount + s.editCount > 0
      ? s.editCount / (s.readCount + s.editCount)
      : 0;
  const longestSameToolRunFraction =
    s.totalToolCalls > 0 ? s.longestSameToolRun / s.totalToolCalls : 0;
  return [
    s.readCount,
    s.editCount,
    s.bashCount,
    s.grepCount,
    s.globCount,
    s.webFetchCount,
    editToReadRatio,
    longestSameToolRunFraction,
    s.hasPlanTool ? 1 : 0,
  ];
}

/**
 * Min-max normalize the listed columns across the corpus. Columns not in
 * `columns` are passed through unchanged. Returns a new array of vectors;
 * never mutates input.
 */
function minMaxNormalize(
  raw: readonly number[][],
  columns: readonly number[],
): number[][] {
  if (raw.length === 0) return [];
  const ncols = raw[0]!.length;
  const mins = new Array<number>(ncols).fill(Number.POSITIVE_INFINITY);
  const maxs = new Array<number>(ncols).fill(Number.NEGATIVE_INFINITY);
  for (const r of raw) {
    for (const c of columns) {
      const v = r[c]!;
      if (v < mins[c]!) mins[c] = v;
      if (v > maxs[c]!) maxs[c] = v;
    }
  }
  return raw.map((r) => {
    const out = r.slice();
    for (const c of columns) {
      const lo = mins[c]!;
      const hi = maxs[c]!;
      if (hi <= lo) {
        out[c] = 0;
      } else {
        out[c] = (r[c]! - lo) / (hi - lo);
      }
    }
    return out;
  });
}

/**
 * Mean silhouette score over all points. For each point i:
 *
 *   a(i) = mean distance to other points in own cluster
 *   b(i) = min over other clusters of mean distance to that cluster
 *   s(i) = (b - a) / max(a, b)
 *
 * Singleton clusters contribute s=0 (per the Rousseeuw 1987 convention).
 * Returns NaN if fewer than two clusters are present.
 */
function computeSilhouette(
  vectors: readonly number[][],
  assignment: readonly number[],
): number {
  const clusterToIndices = new Map<number, number[]>();
  for (let i = 0; i < assignment.length; i++) {
    const ci = assignment[i]!;
    if (ci < 0) continue;
    const bucket = clusterToIndices.get(ci);
    if (bucket === undefined) clusterToIndices.set(ci, [i]);
    else bucket.push(i);
  }
  if (clusterToIndices.size < 2) return Number.NaN;

  let total = 0;
  let count = 0;
  for (let i = 0; i < vectors.length; i++) {
    const own = assignment[i]!;
    if (own < 0) continue;
    const ownIndices = clusterToIndices.get(own)!;
    if (ownIndices.length <= 1) {
      // Singleton — Rousseeuw convention.
      total += 0;
      count += 1;
      continue;
    }
    let aSum = 0;
    for (const j of ownIndices) {
      if (j === i) continue;
      aSum += euclidean(vectors[i]!, vectors[j]!);
    }
    const a = aSum / (ownIndices.length - 1);

    let b = Number.POSITIVE_INFINITY;
    for (const [otherCluster, otherIndices] of clusterToIndices) {
      if (otherCluster === own) continue;
      let sum = 0;
      for (const j of otherIndices) sum += euclidean(vectors[i]!, vectors[j]!);
      const mean = sum / otherIndices.length;
      if (mean < b) b = mean;
    }

    const s = (b - a) / Math.max(a, b);
    if (Number.isFinite(s)) {
      total += s;
      count += 1;
    }
  }
  return count === 0 ? Number.NaN : total / count;
}

/**
 * 32-bit FNV-1a hash over the (size-sorted, rounded) centroid vectors.
 * Returned as an unsigned 32-bit integer so the viewer can compare
 * against the prior `archetypeVersion` from `analysis/archetypes.json`
 * to detect drift.
 */
function hashCentroids(centroids: readonly ArchetypeCentroid[]): number {
  const FNV_OFFSET = 2166136261;
  const FNV_PRIME = 16777619;
  let h = FNV_OFFSET;
  const consume = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME);
    }
  };
  for (const c of centroids) {
    consume(`${c.archetypeId}|${c.sessionCount}|`);
    for (const v of c.vector) {
      // 4-decimal rounding keeps small-FP drift from flipping the hash.
      consume(`${Math.round(v * 10000) / 10000};`);
    }
    consume('\n');
  }
  return h >>> 0;
}
