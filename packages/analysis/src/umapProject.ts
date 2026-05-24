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
 * Output-metric trap (read before piping this into clustering):
 *
 *   UMAP output vectors are not L2-normalized. Downstream code that
 *   uses dot-product as a stand-in for cosine (`discoverClusters`'s
 *   `dot()` helper, `classifyByEmbedding.cosineSimilarityNormalized`,
 *   anywhere `Embedding` is typed as "L2=1 so cosine ≡ dot") will
 *   silently switch to inner-product on arbitrary-magnitude vectors
 *   and produce a different — usually worse — clustering.
 *
 *   Two safe choices:
 *
 *     a) Pass `l2NormalizeOutput: true` here. Vectors are
 *        re-normalized at the module boundary; existing
 *        cosine-by-dot downstream stays correct.
 *
 *     b) Leave it false and switch downstream to Euclidean distance.
 *        This is the canonical BERTopic recipe (UMAP → HDBSCAN with
 *        Euclidean) — UMAP preserves Euclidean structure in the low-
 *        dim space, so Euclidean is the principled metric there.
 *
 *   Default is `false` for backwards compatibility with callers that
 *   already account for this. New callers should set the flag
 *   explicitly so the choice is visible at the call site.
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
  /**
   * If true, L2-normalize each output vector before returning so cosine-
   * by-dot downstream code stays correct. See the module header for
   * when to use this vs. switching downstream to Euclidean.
   *
   * Default `false` preserves prior behaviour for existing callers.
   */
  readonly l2NormalizeOutput?: boolean;
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
  const embedding = await new Promise<number[][]>((resolve, reject) => {
    umap.fitAsync(data, (epoch) => {
      if (onProgress) onProgress(totalEpochs > 0 ? epoch / totalEpochs : 0);
      return true; // keep going
    }).then((e) => resolve(e as number[][]))
      .catch(reject);
  });

  if (!opts.l2NormalizeOutput) return embedding;
  return embedding.map(l2Normalize);
}

/**
 * L2-normalize a row in place-equivalent form (returns a fresh array).
 * If the vector is the zero vector — possible in degenerate UMAP
 * outputs when an input is far from every neighbor — return it
 * unchanged rather than divide by zero. Cosine against a zero
 * vector is undefined, but a downstream NaN is worse than a zero
 * that still slots into the math as "no similarity to anything."
 */
function l2Normalize(v: readonly number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  if (sumSq === 0) return v.slice();
  const inv = 1 / Math.sqrt(sumSq);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] as number) * inv;
  return out;
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
