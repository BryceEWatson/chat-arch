/**
 * Density-based cluster discovery (DBSCAN), an alternative to
 * `discoverClusters`' complete-linkage agglomerative pass.
 *
 * Why a second clusterer:
 *
 *   Complete-linkage requires every cross-pair in a cluster to stay
 *   above threshold — it produces tight, defensible clusters but
 *   shatters elongated topic manifolds, leaving many true topics
 *   under-recalled (the production sidecar covers ~25% of distinctive
 *   sessions at threshold 0.50). HDBSCAN is the canonical BERTopic
 *   stage (Grootendorst 2022), but no actively-maintained, MIT-
 *   licensed, browser-safe HDBSCAN exists for JS. DBSCAN (Ester et al.
 *   1996) is the close cousin: density-based, native noise abstain,
 *   and crucially has the same "varying-density inside a cluster is
 *   fine as long as ε-neighborhoods chain" property that HDBSCAN
 *   exploits — the main HDBSCAN advantage (auto-tuned per-cluster
 *   density) is muted on L2-normalized embeddings which cluster near-
 *   uniformly on the unit hypersphere anyway.
 *
 *   This module wraps `density-clustering`'s DBSCAN with the same
 *   `ClusterInput → DiscoveredCluster[]` shape as `discoverClusters`,
 *   so callers can A/B without API churn. We DO NOT replace the
 *   complete-linkage default in production; this is an opt-in
 *   alternative pending coverage + coherence comparison on the
 *   user's real corpus.
 *
 * Cosine distance via euclidean shortcut:
 *
 *   `density-clustering` lets the caller pass a custom distance
 *   function. For L2-normalized vectors the squared Euclidean
 *   distance `||a − b||² = 2 − 2·dot(a, b)` is monotonic with cosine
 *   distance `1 − cos(a, b)` — same neighborhood ordering, same
 *   clustering. We pass squared-Euclidean (cheaper — no sqrt) and
 *   convert the user's cosine threshold to its squared-Euclidean
 *   equivalent at the call boundary.
 */

import { DBSCAN } from 'density-clustering';
import type { ClusterInput, DiscoveredCluster } from './discoverClusters.js';
import { pickDistinctiveTerms } from './discoverClusters.js';

const DEFAULT_EPS_COSINE = 0.5;
const DEFAULT_MIN_POINTS = 3;
const DEFAULT_LABEL_TERM_COUNT = 3;
const CENTROID_TITLE_MAX_CHARS = 48;

export interface DiscoverClustersDbscanOptions {
  /**
   * Cosine-similarity threshold below which two points are NOT
   * considered neighbors. Internally converted to squared-Euclidean
   * `(2 − 2·s)` since DBSCAN needs a *distance* threshold. Matches
   * the semantics of `discoverClusters`'s `threshold` option:
   * higher value = tighter clusters.
   *
   * Default 0.50 — same as the complete-linkage production threshold,
   * chosen so the two clusterers can be compared head-to-head on a
   * single corpus without retuning.
   */
  epsCosine?: number;
  /**
   * DBSCAN's `minPts`: a point becomes a *core* point only when it has
   * at least `minPts` neighbors within ε. Smaller values surface more
   * (smaller) clusters; larger values suppress noise but require
   * denser topics. Default 3 mirrors `discoverClusters`'s `minSize`.
   */
  minPoints?: number;
  /** How many distinctive terms to include in the label. Default 3. */
  labelTermCount?: number;
  /**
   * Same fork as `discoverClusters`: `'tfidf'` builds a tag-bag label
   * from the top-k distinctive tokens; `'centroid-title'` picks the
   * cluster member closest to the mean vector and uses its text.
   * Default `'tfidf'`.
   */
  labelStrategy?: 'tfidf' | 'centroid-title';
}

export interface DiscoverClustersDbscanResult {
  clusters: DiscoveredCluster[];
  /** Member ids that DBSCAN flagged as noise (not in any cluster). */
  noiseIds: readonly string[];
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = a.length;
  for (let i = 0; i < len; i += 1) {
    s += (a[i] as number) * (b[i] as number);
  }
  return s;
}

function squaredEuclidean(a: number[], b: number[]): number {
  let s = 0;
  const len = a.length;
  for (let i = 0; i < len; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    s += d * d;
  }
  return s;
}

function pickCentroidTitle(
  memberIndices: readonly number[],
  vectors: readonly Float32Array[],
  texts: readonly (string | undefined)[],
): string | null {
  if (memberIndices.length === 0) return null;
  const dim = (vectors[memberIndices[0] as number] as Float32Array).length;
  const centroid = new Float32Array(dim);
  for (const idx of memberIndices) {
    const v = vectors[idx] as Float32Array;
    for (let d = 0; d < dim; d += 1) {
      centroid[d] = (centroid[d] as number) + (v[d] as number);
    }
  }
  let bestIdx = -1;
  let bestSim = -Infinity;
  for (const idx of memberIndices) {
    const text = texts[idx];
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const s = dot(vectors[idx] as Float32Array, centroid);
    if (s > bestSim) {
      bestSim = s;
      bestIdx = idx;
    }
  }
  if (bestIdx === -1) return null;
  const raw = (texts[bestIdx] as string).trim();
  if (raw.length <= CENTROID_TITLE_MAX_CHARS) return raw;
  const sliceEnd = CENTROID_TITLE_MAX_CHARS - 1;
  const slice = raw.slice(0, sliceEnd);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(sliceEnd * 0.66) ? lastSpace : sliceEnd;
  return `${raw.slice(0, cut).trimEnd()}…`;
}

function clusterIdFromMembers(memberIds: readonly string[]): string {
  const sorted = [...memberIds].sort();
  let h = 2166136261 >>> 0;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i += 1) {
      h ^= id.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    h ^= 0x7c;
  }
  return `cl-${h.toString(16).padStart(8, '0')}`;
}

/**
 * Discover topic clusters via DBSCAN. Same input shape as
 * `discoverClusters`; output is the same `DiscoveredCluster[]` shape
 * plus an explicit `noiseIds` list (the ids that DBSCAN flagged as
 * noise — useful as a coverage diagnostic).
 *
 * Vectors MUST be L2-normalized. The internal cosine→squared-Euclidean
 * conversion is only correct on unit-length input — passing arbitrary-
 * magnitude vectors silently changes the neighborhood definition.
 */
export function discoverClustersDbscan(
  docs: readonly ClusterInput[],
  options: DiscoverClustersDbscanOptions = {},
): DiscoverClustersDbscanResult {
  const epsCosine = options.epsCosine ?? DEFAULT_EPS_COSINE;
  const minPoints = options.minPoints ?? DEFAULT_MIN_POINTS;
  const k = options.labelTermCount ?? DEFAULT_LABEL_TERM_COUNT;
  const labelStrategy = options.labelStrategy ?? 'tfidf';

  if (docs.length === 0) return { clusters: [], noiseIds: [] };

  // Document-frequency map for TF-IDF labeling (mirrors discoverClusters).
  const df = new Map<string, number>();
  const tokenSets: ReadonlySet<string>[] = docs.map((d) => {
    const set = new Set(d.tokens);
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    return set;
  });

  // Cosine threshold s ⇔ squared-Euclidean threshold (2 − 2s) for
  // unit-length vectors. Higher s → smaller ε (tighter clusters).
  const epsSquared = Math.max(0, 2 - 2 * epsCosine);

  // density-clustering expects datapoints as plain arrays.
  const dataset: number[][] = docs.map((d) => Array.from(d.vector));
  const dbscan = new DBSCAN();
  // The library mutates internal state; `.run()` is the public entry.
  const rawClusters = dbscan.run(dataset, epsSquared, minPoints, squaredEuclidean);
  const noiseIndices = dbscan.noise;

  const vectors = docs.map((d) => d.vector);
  const texts = docs.map((d) => d.text);

  const clusters: DiscoveredCluster[] = [];
  for (const group of rawClusters) {
    // DBSCAN may emit clusters smaller than minPoints when border points
    // are reassigned; filter for consistency with the caller's intent.
    if (group.length < minPoints) continue;
    const memberIds = group.map((idx) => (docs[idx] as ClusterInput).id);
    const memberTokenSets = group.map((idx) => tokenSets[idx] as ReadonlySet<string>);
    const labelTerms = pickDistinctiveTerms(memberTokenSets, df, docs.length, k);

    let label: string;
    if (labelStrategy === 'centroid-title') {
      const t = pickCentroidTitle(group, vectors, texts);
      label = t !== null ? t : [...labelTerms].sort().join(' + ');
    } else {
      label = [...labelTerms].sort().join(' + ');
    }

    clusters.push({
      id: clusterIdFromMembers(memberIds),
      memberIds,
      labelTerms,
      label,
      // The `threshold` field on DiscoveredCluster carries the cosine
      // threshold the cluster was built at. Even though DBSCAN works in
      // squared-Euclidean space internally, we report the equivalent
      // cosine value so UI tooltips stay consistent across clusterers.
      threshold: epsCosine,
    });
  }

  clusters.sort((a, b) => b.memberIds.length - a.memberIds.length);

  const noiseIds = noiseIndices.map((idx) => (docs[idx] as ClusterInput).id);

  return { clusters, noiseIds };
}
