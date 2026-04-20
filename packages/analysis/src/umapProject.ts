/**
 * UMAP projection wrapper.
 *
 * Thin shim over `umap-js` 1.4 that:
 *
 *   1. Takes normalized embeddings (Float32Array[]) and returns a
 *      projected matrix (number[][]) at the configured target dim.
 *   2. Seeds the PRNG via a passed-in `random: () => number` closure —
 *      umap-js accepts any `() => number`. Without a seed, the
 *      projection is non-deterministic across reloads and the
 *      benchmark harness's sample block becomes non-reproducible.
 *   3. Uses `fitAsync(X, callback)` so UMAP's sync optimization loop
 *      doesn't block the main thread for ~2-5 s on n=1010. The
 *      callback forwards 0..1 progress to the caller.
 *
 * The output is NOT L2-normalized — downstream complete-linkage using
 * cosine math on projected vectors must either re-normalize here or
 * switch to a proper cosine (dot + divide by norms). Leaving the
 * renormalization to the caller keeps this module purely about
 * projection.
 */

import { UMAP } from 'umap-js';

export interface UmapProjectOptions {
  /** Target dimensionality. Memo recommends 15 for downstream clustering. */
  readonly nComponents?: number;
  /** UMAP's `n_neighbors`. Default 15 (library default). */
  readonly nNeighbors?: number;
  /** UMAP's `min_dist`. 0.0 gives tight clusters (good for clustering). */
  readonly minDist?: number;
  /**
   * PRNG closure. REQUIRED for determinism — umap-js's default is
   * `Math.random`, which makes every run different and breaks the
   * harness's "same clusters on reload" invariant. Callers should
   * pass a seeded generator (mulberry32 etc.).
   */
  readonly random: () => number;
  /** 0..1 progress callback, fired during `fitAsync`. */
  readonly onProgress?: (fraction: number) => void;
}

export async function umapProject(
  vectors: readonly Float32Array[],
  opts: UmapProjectOptions,
): Promise<number[][]> {
  if (vectors.length === 0) return [];

  const data: number[][] = vectors.map((v) => Array.from(v));

  const umap = new UMAP({
    nComponents: opts.nComponents ?? 15,
    nNeighbors: opts.nNeighbors ?? 15,
    minDist: opts.minDist ?? 0.0,
    random: opts.random,
  });

  const totalEpochs = umap.initializeFit(data);
  const onProgress = opts.onProgress;
  return new Promise<number[][]>((resolve, reject) => {
    umap.fitAsync(data, (epoch) => {
      if (onProgress) onProgress(totalEpochs > 0 ? epoch / totalEpochs : 0);
      return true; // keep going
    }).then((embedding) => resolve(embedding as number[][]))
      .catch(reject);
  });
}

/**
 * Seeded PRNG — `mulberry32`. Deterministic given a fixed seed.
 * Exposed here so harness callers can instantiate one without adding
 * a random-number dep. Public-domain impl (Tommy Ettinger).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
