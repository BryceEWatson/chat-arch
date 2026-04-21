/**
 * Embedding-based nearest-project classifier.
 *
 * Runtime-neutral pure math: takes pre-computed document vectors + project
 * centroid vectors (both produced by any sentence-embedding model — we ship
 * MiniLM-L6-v2 in the viewer, but the classifier doesn't care) and returns
 * a label per document.
 *
 * Deliberately excluded from the embedding concern:
 *
 *   - How the vectors were produced (Transformers.js, ONNX, Candle, …)
 *   - Whether they live on WebGPU tensors or CPU Float32Arrays
 *   - Tokenization, batch size, caching
 *
 * Keeping the classification math separate from the model driver lets:
 *   - Node-side spikes reuse the same thresholds / margin rules the
 *     browser ships with (so the viewer's behavior is pinned against
 *     spike-time precision/recall numbers)
 *   - Future model swaps (EmbeddingGemma, larger MPNet, etc.) require
 *     re-tuning only one `τ` constant, not rewriting the pipeline
 *
 * The spike run in the phase-3 research established τ=0.40 as the
 * empirical balance point on a real 1,041-conversation claude.ai corpus:
 * 41% coverage, 58% agreement with the string-match ground truth, with
 * most disagreements being "same-project renamed" collisions (e.g.
 * `starz` vs `starz v2`) rather than genuine false positives.
 */

/**
 * A document embedding. Normalized to unit length (L2 = 1) so cosine
 * similarity reduces to a dot product. The embedding pipeline in
 * `@huggingface/transformers` produces this shape when called with
 * `normalize: true` — any pooling strategy (`mean`, `cls`, etc.) is
 * fine, so long as the same strategy is used for all vectors that will
 * be compared.
 */
export type Embedding = Float32Array;

export interface ProjectCentroid {
  /** Stable id, mirrored into the resulting label — usually the project name. */
  id: string;
  /** Normalized embedding vector (same dim as document embeddings). */
  vector: Embedding;
}

export interface ClassifyOptions {
  /**
   * Minimum cosine similarity for a document to be labeled. Below this,
   * the document is left unlabeled rather than forced onto a centroid.
   * Calibrated on a 1,041-conversation / 27-project corpus:
   *
   *   τ=0.30 → 74% coverage, 60% agreement w/ string baseline
   *   τ=0.40 → 41% coverage, 58% agreement     (current default — balanced)
   *   τ=0.45 → 28% coverage, 51% agreement     (precision-biased)
   *   τ=0.55 → 11% coverage, 35% agreement     (string-match parity)
   *
   * Default 0.40; tune per-deployment based on the coverage/precision
   * trade the UI can tolerate.
   */
  threshold?: number;
  /**
   * Minimum gap between the best and second-best similarity for the
   * label to be assigned. Defends against ties — "PetConnect" and
   * "PetCare" scoring within 0.01 of each other shouldn't confidently
   * pick one. When the top match is within `margin` of the runner-up,
   * we abstain.
   */
  margin?: number;
}

export interface ClassificationResult {
  /** The chosen project id, or `null` when no centroid cleared the bar. */
  projectId: string | null;
  /** Cosine similarity of the best match, whether or not it was assigned. */
  similarity: number;
  /** Similarity of the runner-up; useful for margin auditing. */
  runnerUpSimilarity: number;
}

const DEFAULT_THRESHOLD = 0.4;
const DEFAULT_MARGIN = 0.02;

/**
 * Cosine similarity of two unit-length vectors. Equivalent to `dot(a, b)`
 * when both are pre-normalized — we assert that as the calling contract
 * and avoid the sqrt in the hot loop.
 */
export function cosineSimilarityNormalized(a: Embedding, b: Embedding): number {
  let s = 0;
  const len = a.length;
  for (let i = 0; i < len; i += 1) {
    s += (a[i] as number) * (b[i] as number);
  }
  return s;
}

/**
 * Classify a single document against a list of project centroids. Returns
 * the best match + its score + the runner-up for margin analysis. Label
 * is `null` when the best score is below `threshold` or within `margin`
 * of the runner-up (ambiguous).
 */
export function classifyOne(
  doc: Embedding,
  centroids: readonly ProjectCentroid[],
  options: ClassifyOptions = {},
): ClassificationResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const margin = options.margin ?? DEFAULT_MARGIN;

  let bestIdx = -1;
  let bestSim = -Infinity;
  let secondSim = -Infinity;

  for (let i = 0; i < centroids.length; i += 1) {
    const c = centroids[i];
    if (c === undefined) continue;
    const sim = cosineSimilarityNormalized(doc, c.vector);
    if (sim > bestSim) {
      secondSim = bestSim;
      bestSim = sim;
      bestIdx = i;
    } else if (sim > secondSim) {
      secondSim = sim;
    }
  }

  const finite = (x: number): number => (Number.isFinite(x) ? x : 0);
  const assigned =
    bestIdx >= 0 && bestSim >= threshold && bestSim - secondSim >= margin
      ? (centroids[bestIdx] as ProjectCentroid).id
      : null;

  return {
    projectId: assigned,
    similarity: finite(bestSim),
    runnerUpSimilarity: finite(secondSim),
  };
}

/**
 * Batch-classify a list of documents. Thin wrapper around `classifyOne`
 * that preserves index alignment with the input array. Exists for
 * readability at call sites; the cost is the same as a manual map.
 */
export function classifyBatch(
  docs: readonly Embedding[],
  centroids: readonly ProjectCentroid[],
  options: ClassifyOptions = {},
): ClassificationResult[] {
  return docs.map((d) => classifyOne(d, centroids, options));
}

/**
 * Classify a single document that has been split into multiple chunks,
 * each with its own embedding. For each centroid, we take the MAX
 * cosine similarity across the document's chunks — so any chunk that
 * resembles a centroid can anchor the whole document to that label.
 *
 * This is deliberately different from mean-pooling the chunk vectors:
 *
 *   - Mean-pool dilutes distinctive signal. A 20-turn conversation
 *     that spent 18 turns on "refactor this function" and 2 turns on
 *     "how do I deploy this to GCP" would mean-pool toward a generic
 *     software-development centroid and might never cleanly match the
 *     GCP project centroid, even though two chunks discussed it.
 *   - Max-sim-per-centroid keeps both topic signals independently
 *     alive. The same conversation reaches the "refactor" centroid
 *     via the first 18 turns AND the "gcp-deploy" centroid via the
 *     last 2, and assigns to whichever scores higher — so the short
 *     but distinctive topic isn't drowned.
 *
 * Same threshold / margin rules as `classifyOne`. The difference is
 * purely in how the per-centroid similarity is computed — a chunk's
 * max instead of the doc's single-vector dot product.
 */
export function classifyChunksOfOne(
  chunkVectors: readonly Embedding[],
  centroids: readonly ProjectCentroid[],
  options: ClassifyOptions = {},
): ClassificationResult {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const margin = options.margin ?? DEFAULT_MARGIN;

  if (chunkVectors.length === 0 || centroids.length === 0) {
    return { projectId: null, similarity: 0, runnerUpSimilarity: 0 };
  }

  // Compute max similarity from this document to each centroid. O(C × K)
  // dot products per document, where C = centroids, K = chunks — same
  // order of work as classifying K separate docs. Memory is O(C) since
  // we only keep the running max per centroid.
  const perCentroidMax = new Array<number>(centroids.length).fill(-Infinity);
  for (const chunk of chunkVectors) {
    for (let ci = 0; ci < centroids.length; ci += 1) {
      const c = centroids[ci];
      if (c === undefined) continue;
      const sim = cosineSimilarityNormalized(chunk, c.vector);
      if (sim > (perCentroidMax[ci] as number)) perCentroidMax[ci] = sim;
    }
  }

  // Pick best + runner-up from the max-per-centroid table. Reuses the
  // same threshold/margin semantics so results are comparable to
  // single-vector classification — only the signal source differs.
  let bestIdx = -1;
  let bestSim = -Infinity;
  let secondSim = -Infinity;
  for (let i = 0; i < perCentroidMax.length; i += 1) {
    const sim = perCentroidMax[i] as number;
    if (sim > bestSim) {
      secondSim = bestSim;
      bestSim = sim;
      bestIdx = i;
    } else if (sim > secondSim) {
      secondSim = sim;
    }
  }

  const finite = (x: number): number => (Number.isFinite(x) ? x : 0);
  const assigned =
    bestIdx >= 0 && bestSim >= threshold && bestSim - secondSim >= margin
      ? (centroids[bestIdx] as ProjectCentroid).id
      : null;

  return {
    projectId: assigned,
    similarity: finite(bestSim),
    runnerUpSimilarity: finite(secondSim),
  };
}
