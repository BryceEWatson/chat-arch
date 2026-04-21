/**
 * UMass topic coherence.
 *
 * For each cluster, computes the UMass score over its top-N tokens:
 *
 *   UMass(topic) = (2 / (N * (N-1))) * sum_{i<j} log((D(w_i, w_j) + 1) / D(w_j))
 *
 * where `D(w)` is document frequency of token `w` in the corpus and
 * `D(w_i, w_j)` is co-document frequency. We use the normalized
 * arithmetic mean across pairs (same convention as gensim's
 * `CoherenceModel(coherence='u_mass')`). The `+1` in the numerator is
 * the smoothing constant from Mimno et al. 2011; the denominator uses
 * the less-frequent word's df (index `j` is chosen so `w_j` appears
 * later in the sorted top-N, which correlates with lower frequency in
 * typical TF-IDF-ranked topic word lists).
 *
 * Higher (less negative) is better. Typical values on short-text
 * corpora land in [-10, -1]. Deltas of ~0.5+ between configs are
 * meaningful; deltas under ~0.2 are noise.
 *
 * Scope note: UMass assumes the corpus `D` is the same as the training
 * corpus for TF-IDF and document frequencies. We pass in the full
 * `allSessionTokens` map (same population the semantic classifier
 * sees) so caller's per-cluster scores stay comparable across
 * benchmark rows.
 */

export interface CoherenceOptions {
  /**
   * Per-cluster top-N tokens (already TF-IDF-ranked, stopword-stripped,
   * dedup-within-cluster). Keyed by cluster label. Each token array
   * should be in descending importance order — UMass pairs earlier
   * (more frequent) words with later (less frequent) words.
   */
  readonly clusterTopTerms: ReadonlyMap<string, readonly string[]>;
  /**
   * Full corpus tokens, keyed by sessionId. Used to compute document
   * frequency and co-document frequency. MUST be the full population,
   * not a filtered subset — UMass interprets df against the corpus
   * the clusters came from.
   */
  readonly allSessionTokens: ReadonlyMap<string, readonly string[]>;
  /**
   * How many top terms per cluster to score. Defaults to 10 (gensim
   * default). Values below 5 produce unstable numbers; above 20 the
   * tail terms dilute the score with noise.
   */
  readonly topN?: number;
}

export type CoherenceScores = Map<string, number>;

const DEFAULT_TOP_N = 10;

/**
 * Compute UMass coherence for every cluster in `clusterTopTerms`.
 * Returns a map from cluster label to score. Clusters with fewer
 * than 2 scoreable top-terms (i.e. not enough pairs to score) get
 * omitted from the result rather than assigned a sentinel value —
 * callers that want an aggregate mean should skip missing keys.
 */
export function computeCoherence(opts: CoherenceOptions): CoherenceScores {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const scores: CoherenceScores = new Map();

  const N = opts.allSessionTokens.size;
  if (N === 0) return scores;

  const df = buildDocumentFrequency(opts.allSessionTokens);
  const coDf = buildCoDocumentFrequency(opts.allSessionTokens);

  for (const [label, terms] of opts.clusterTopTerms) {
    const top = terms.slice(0, topN);
    if (top.length < 2) continue;
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < top.length; i += 1) {
      for (let j = i + 1; j < top.length; j += 1) {
        const wi = top[i] as string;
        const wj = top[j] as string;
        const dj = df.get(wj) ?? 0;
        if (dj === 0) continue;
        const co = coDf.get(pairKey(wi, wj)) ?? 0;
        sum += Math.log((co + 1) / dj);
        pairs += 1;
      }
    }
    if (pairs === 0) continue;
    scores.set(label, sum / pairs);
  }

  return scores;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
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

function buildCoDocumentFrequency(
  allTokens: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const coDf = new Map<string, number>();
  for (const tokens of allTokens.values()) {
    if (tokens.length < 2) continue;
    const uniq = new Set(tokens);
    const arr = [...uniq];
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const k = pairKey(arr[i] as string, arr[j] as string);
        coDf.set(k, (coDf.get(k) ?? 0) + 1);
      }
    }
  }
  return coDf;
}
