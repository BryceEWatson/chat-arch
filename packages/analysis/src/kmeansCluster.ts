/**
 * k-means clustering wrapper.
 *
 * Conforms to the `DiscoveredCluster[]` output shape produced by
 * `discoverClusters` so the benchmark-harness metrics pipeline is
 * clusterer-agnostic. Built on `ml-kmeans` 7.x.
 *
 * Trade-off vs. complete-linkage agglomerative: k-means assigns every
 * point to a cluster (no abstain), so `classified_pct + emergent_pct +
 * unlabeled_pct` for a k-means-only run sums to 100% on the emergent
 * column. That's the whole reason we don't ship k-means as a
 * production classifier — the "abstain on noise" property is lost.
 * For a benchmark it's fine; for production it's a UX regression.
 */

import { kmeans } from 'ml-kmeans';
import type { DiscoveredCluster } from './discoverClusters.js';

// ml-kmeans 7 does not re-export `KMeansResult` from its package entry
// (it lives at `./lib/KMeansResult.js` with no re-export from `index`),
// so we infer the return type via `ReturnType<typeof kmeans>` rather
// than introduce a deep-module import that could break on minor-version
// bumps.
type KMeansResult = ReturnType<typeof kmeans>;

export interface KmeansClusterInput {
  /** Session / document id. Passed through to the cluster's memberIds. */
  readonly id: string;
  /** Pre-projected vector (UMAP output or raw embedding). */
  readonly vector: readonly number[];
  /** Tokens used to pick distinctive cluster label terms. */
  readonly tokens: readonly string[];
  /** Optional raw text — used by `labelStrategy: 'centroid-title'` if set. */
  readonly text?: string;
}

export interface KmeansClusterOptions {
  /** Number of clusters. Typical: sqrt(n/2) for BunkaTopics-style defaults. */
  readonly k: number;
  /**
   * Seed for k-means initialization. Required for determinism — same
   * reasoning as UMAP's seeded PRNG. `ml-kmeans` 7 accepts a numeric
   * seed directly (no closure wrapping needed).
   */
  readonly seed: number;
  /** Max iterations. Default 100 (library default). */
  readonly maxIterations?: number;
  /** Min cluster size — smaller clusters are filtered from the output. */
  readonly minSize?: number;
  /** How many top terms per cluster to keep in the label. Default 3. */
  readonly labelTermCount?: number;
}

/**
 * Run k-means over the inputs and return `DiscoveredCluster[]`.
 * Labels are TF-ranked token bags (no centroid-title strategy — k-means
 * doesn't have a well-defined centroid member; if we pick the closest
 * point, it's often not a good summary).
 */
export function kmeansCluster(
  inputs: readonly KmeansClusterInput[],
  options: KmeansClusterOptions,
): DiscoveredCluster[] {
  if (inputs.length === 0) return [];
  if (options.k <= 0) return [];

  const data = inputs.map((x) => [...x.vector]);
  const result: KMeansResult = kmeans(data, options.k, {
    seed: options.seed,
    maxIterations: options.maxIterations ?? 100,
  });

  const minSize = options.minSize ?? 1;
  const labelTermCount = options.labelTermCount ?? 3;

  // Group inputs by assigned cluster index.
  const groups: KmeansClusterInput[][] = Array.from({ length: options.k }, () => []);
  for (let i = 0; i < inputs.length; i += 1) {
    const ci = result.clusters[i];
    if (typeof ci !== 'number') continue;
    const input = inputs[i];
    if (input !== undefined) groups[ci]?.push(input);
  }

  const out: DiscoveredCluster[] = [];
  groups.forEach((members, ci) => {
    if (members.length < minSize) return;
    const labelTerms = pickTopTokens(members, labelTermCount);
    out.push({
      id: `kmeans-${ci}`,
      memberIds: members.map((m) => m.id),
      labelTerms,
      label: labelTerms.join(' + '),
      threshold: 0, // k-means doesn't produce a per-cluster threshold
    });
  });
  return out;
}

/**
 * Simple token-frequency ranking across a cluster's members. Tokens
 * appearing in more members rank higher; ties broken by total count.
 * Not c-TF-IDF — IDF would require the corpus here, and the caller
 * already decides when it wants IDF weighting (via the coherence /
 * reduceOutliers modules).
 */
function pickTopTokens(members: readonly KmeansClusterInput[], count: number): string[] {
  const df = new Map<string, { docs: number; total: number }>();
  for (const m of members) {
    const seen = new Set<string>();
    for (const t of m.tokens) {
      const cur = df.get(t) ?? { docs: 0, total: 0 };
      cur.total += 1;
      if (!seen.has(t)) {
        cur.docs += 1;
        seen.add(t);
      }
      df.set(t, cur);
    }
  }
  const ranked = [...df.entries()].sort((a, b) => {
    if (b[1].docs !== a[1].docs) return b[1].docs - a[1].docs;
    return b[1].total - a[1].total;
  });
  return ranked.slice(0, count).map(([t]) => t);
}
