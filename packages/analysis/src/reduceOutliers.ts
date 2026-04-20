/**
 * c-TF-IDF outlier reassignment pass.
 *
 * Runtime-neutral post-processing for the semantic classifier: after the
 * classify + discover passes complete, any session whose `projectId`
 * stayed `null` (didn't beat τ against a named project centroid AND
 * wasn't picked up into an emergent cluster) gets a second chance by
 * comparing its token bag against each emergent cluster's aggregate
 * token bag with a class-based TF-IDF cosine. If the best match clears
 * a secondary threshold (default 0.30) the session inherits that
 * cluster's label.
 *
 * Why it helps. Complete-linkage discovery rejects sessions whose
 * embedding geometry is marginally off the cluster core even when the
 * token content is clearly the same topic (common for short titles
 * with high-frequency vocabulary that embed as bland centroid-of-corpus
 * vectors). c-TF-IDF sidesteps the embedding manifold entirely: it's
 * word-frequency math in the vocabulary the user would recognize.
 *
 * IDF scope. The document-frequency map MUST be computed over the FULL
 * unfiltered session population, not over the cluster-discovery input.
 * Otherwise rare tokens that only appear in short sessions (the exact
 * population this pass is meant to rescue) get inflated IDF weight and
 * bias the reassignment toward spurious matches. Callers pass
 * `allSessionTokens` unfiltered; the caller at `semanticClassify.ts`
 * must build that map before the `DISCOVER_MIN_TOKEN_COUNT` filter
 * trims the discovery input.
 */

export interface ReduceOutliersLabelEntry {
  projectId: string | null;
  similarity: number;
}

export interface ReduceOutliersOptions {
  /**
   * Current per-session label map, produced by the classify + discover
   * passes. Sessions with `projectId === null` are the reassignment
   * candidates. Passed in as ReadonlyMap so the caller's own map is
   * never mutated by this function — the caller merges the return
   * value in themselves.
   */
  readonly labels: ReadonlyMap<string, ReduceOutliersLabelEntry>;
  /**
   * Full-corpus token inventory, keyed by sessionId. MUST include every
   * session regardless of `DISCOVER_MIN_TOKEN_COUNT` or any other
   * upstream token-count filter — this map backs the corpus-wide IDF
   * computation. A session may map to an empty array if it has no
   * meaningful tokens; such sessions are skipped but still count toward
   * N for the IDF denominator.
   */
  readonly allSessionTokens: ReadonlyMap<string, readonly string[]>;
  /**
   * Per-cluster aggregated token bag, keyed by the cluster's final
   * label (including the leading `~` prefix). The array is the
   * concatenation of every member session's tokens — repeated tokens
   * contribute to in-cluster term frequency. Typically the caller
   * builds this after the discovery pass completes by mapping
   * `cluster.memberIds → allSessionTokens.get(id) ?? []` and
   * flattening.
   */
  readonly clusterTokens: ReadonlyMap<string, readonly string[]>;
  /**
   * Minimum cosine similarity between an outlier session's TF-IDF
   * vector and a cluster's c-TF-IDF vector for reassignment. Below
   * this, the session stays unlabeled. BERTopic's Best Practices
   * suggests 0.3 as a production-safe floor; values as low as 0.2
   * can increase coverage at the cost of thematic coherence.
   */
  readonly threshold?: number;
}

export interface ReduceOutliersAssignment {
  projectId: string;
  similarity: number;
}

export type ReduceOutliersResult = Map<string, ReduceOutliersAssignment>;

const DEFAULT_REDUCE_THRESHOLD = 0.3;

/**
 * Run c-TF-IDF outlier reassignment. Returns a sparse map of
 * `sessionId → new label` — only for sessions that (a) were unlabeled
 * on input and (b) scored above threshold against some cluster. The
 * caller merges this into its own label map; `reduceOutliers` itself
 * is side-effect-free.
 */
export function reduceOutliers(
  opts: ReduceOutliersOptions,
): ReduceOutliersResult {
  const threshold = opts.threshold ?? DEFAULT_REDUCE_THRESHOLD;
  const result: ReduceOutliersResult = new Map();

  const N = opts.allSessionTokens.size;
  if (N === 0) return result;
  if (opts.clusterTokens.size === 0) return result;

  const df = buildDocumentFrequency(opts.allSessionTokens);

  const idf = (tok: string): number => {
    const d = df.get(tok);
    if (d === undefined || d === 0) return 0;
    return Math.log(N / d);
  };

  const clusterVecs = buildClusterVectors(opts.clusterTokens, idf);
  if (clusterVecs.length === 0) return result;

  for (const [sid, labelEntry] of opts.labels) {
    if (labelEntry.projectId !== null) continue;
    const tokens = opts.allSessionTokens.get(sid);
    if (!tokens || tokens.length === 0) continue;

    const sess = buildTfIdfVector(tokens, idf);
    if (sess === null) continue;

    let bestLabel: string | null = null;
    let bestSim = 0;
    for (const cv of clusterVecs) {
      let dot = 0;
      for (const [t, w] of sess.weights) {
        const cw = cv.weights.get(t);
        if (cw === undefined) continue;
        dot += w * cw;
      }
      const sim = dot / (sess.norm * cv.norm);
      if (sim > bestSim) {
        bestSim = sim;
        bestLabel = cv.label;
      }
    }

    if (bestLabel !== null && bestSim >= threshold) {
      result.set(sid, { projectId: bestLabel, similarity: bestSim });
    }
  }

  return result;
}

function buildDocumentFrequency(
  allTokens: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of allTokens.values()) {
    if (tokens.length === 0) continue;
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return df;
}

interface TfIdfVector {
  weights: Map<string, number>;
  norm: number;
}

function buildTfIdfVector(
  tokens: readonly string[],
  idf: (tok: string) => number,
): TfIdfVector | null {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const weights = new Map<string, number>();
  let sq = 0;
  for (const [t, count] of tf) {
    const w = count * idf(t);
    if (w === 0) continue;
    weights.set(t, w);
    sq += w * w;
  }
  const norm = Math.sqrt(sq);
  if (norm === 0) return null;
  return { weights, norm };
}

interface ClusterVector extends TfIdfVector {
  label: string;
}

function buildClusterVectors(
  clusterTokens: ReadonlyMap<string, readonly string[]>,
  idf: (tok: string) => number,
): ClusterVector[] {
  const out: ClusterVector[] = [];
  for (const [label, tokens] of clusterTokens) {
    const v = buildTfIdfVector(tokens, idf);
    if (v === null) continue;
    out.push({ label, weights: v.weights, norm: v.norm });
  }
  return out;
}
