/**
 * Knowledge-debt detection — Phase 1 expansion #11.
 *
 * Cluster recurring first-user-turn questions across sessions. When the
 * same question shape keeps coming back across sessions, that's a signal
 * the answer isn't sticking in the user's notes / agents.md / CLAUDE.md —
 * i.e. "knowledge debt" the user could pay down with a single artifact.
 *
 * Pipeline:
 *
 *   1. Tokenize first-user-turn text (lowercase, stripped punctuation,
 *      English stopwords removed).
 *   2. Cluster:
 *        - High-confidence path: when embeddings are provided, delegate
 *          to `discoverClusters` (complete-linkage agglomerative over
 *          cosine similarity, `intraClusterCosineMin` threshold).
 *        - Fallback path: TF-IDF cosine similarity over tokenized text.
 *          Same agglomerative discoverer, but each cluster is marked
 *          `confidence: 'low'` so the viewer can de-emphasize them.
 *   3. Pick a canonical question per cluster — the member whose tokens
 *      are most representative (highest sum of TF-IDF over the cluster's
 *      pooled tokens).
 *
 * Pure. Browser-safe.
 *
 * The `renderObsidianMarkdown` helper emits a markdown document with
 * YAML frontmatter suitable for dropping into an Obsidian vault as
 * a "Knowledge Debt" note.
 */

import {
  discoverClusters,
  pickDistinctiveTerms,
  type ClusterInput,
  type Embedding,
} from './discoverClusters.js';
import { THRESHOLDS } from './thresholds.js';

export interface KnowledgeDebtEntry {
  sessionId: string;
  /** First user turn text. May be empty; entries with empty text are skipped. */
  firstUserTurn: string;
  /** Unix ms; the timestamp of the session (firstSeen/lastSeen across the
   *  cluster's sessions are derived from this). */
  timestamp: number;
  /** Optional pre-computed unit-length embedding. When present we use the
   *  high-confidence path; when absent we fall back to TF-IDF. */
  embedding?: Embedding;
}

export interface KnowledgeDebtCluster {
  /** Stable id derived from sorted session ids (deterministic). */
  id: string;
  /** Representative question — the first-user-turn of the cluster member
   *  closest to the cluster centroid (or, in the TF-IDF fallback, the
   *  member with the highest distinctive-term overlap). */
  canonicalQuestion: string;
  /** Top distinctive terms — for tooltips / drill-down. */
  labelTerms: readonly string[];
  /** Member session ids. */
  sessionIds: readonly string[];
  /** Unix ms of the earliest entry in the cluster. */
  firstSeen: number;
  /** Unix ms of the latest entry in the cluster. */
  lastSeen: number;
  /** 'high' when embeddings were provided for all members; 'low' on TF-IDF fallback. */
  confidence: 'high' | 'low';
}

export interface DetectKnowledgeDebtOptions {
  /** Minimum cluster size; defaults to `THRESHOLDS.clustering.minClusterSize` (10). */
  minClusterSize?: number;
  /** Intra-cluster cosine floor; defaults to `THRESHOLDS.clustering.intraClusterCosineMin` (0.7). */
  intraClusterCosineMin?: number;
}

// English stopword list — intentionally short; we just need to drop the
// most common function words so TF-IDF doesn't surface "the / and / of"
// as distinctive terms.
const STOPWORDS = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'how',
  'i', 'if', 'in', 'is', 'it', 'its', 'just', 'may', 'me', 'my', 'no',
  'not', 'of', 'on', 'or', 'our', 'out', 'over', 's', 'should', 'so',
  'some', 't', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'too', 'up', 'use', 'used', 'using',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'would', 'you', 'your',
]);

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return tokens;
}

/**
 * Build a TF-IDF unit vector for one document over a fixed vocabulary.
 * Used only by the fallback path; the high-confidence path uses the
 * provided dense embeddings instead.
 */
function tfidfVector(
  docTokens: readonly string[],
  vocab: ReadonlyMap<string, number>,
  idf: readonly number[],
): Float32Array {
  const vec = new Float32Array(vocab.size);
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [term, count] of tf) {
    const idx = vocab.get(term);
    if (idx === undefined) continue;
    vec[idx] = count * (idf[idx] ?? 0);
  }
  // L2 normalize so cosine reduces to dot product (matches the embedding
  // path's expectation in discoverClusters).
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i] ?? 0;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) {
      vec[i] = (vec[i] ?? 0) / norm;
    }
  }
  return vec;
}

/**
 * Compute the cluster member closest to the cluster centroid; return
 * its index into the input array. Used to pick the canonical question.
 */
function pickCentroidMember(
  memberIndices: readonly number[],
  vectors: readonly Embedding[],
): number {
  if (memberIndices.length === 0) return -1;
  const dim = (vectors[memberIndices[0] as number] as Embedding).length;
  const centroid = new Float32Array(dim);
  for (const idx of memberIndices) {
    const v = vectors[idx] as Embedding;
    for (let d = 0; d < dim; d += 1) {
      centroid[d] = (centroid[d] as number) + (v[d] as number);
    }
  }
  let bestIdx = memberIndices[0] as number;
  let bestSim = -Infinity;
  for (const idx of memberIndices) {
    const v = vectors[idx] as Embedding;
    let s = 0;
    for (let d = 0; d < dim; d += 1) {
      s += (v[d] as number) * (centroid[d] as number);
    }
    if (s > bestSim) {
      bestSim = s;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

export function detectKnowledgeDebt(
  entries: ReadonlyArray<KnowledgeDebtEntry>,
  options: DetectKnowledgeDebtOptions = {},
): KnowledgeDebtCluster[] {
  const minClusterSize = options.minClusterSize ?? THRESHOLDS.clustering.minClusterSize;
  const intraClusterCosineMin =
    options.intraClusterCosineMin ?? THRESHOLDS.clustering.intraClusterCosineMin;

  // Drop entries with empty first-user-turn text — nothing to cluster.
  const usable = entries.filter((e) => e.firstUserTurn.trim().length > 0);
  if (usable.length === 0) return [];

  // Decide path: high-confidence when every entry has an embedding;
  // fallback otherwise. We require ALL embeddings to be present so the
  // cluster's intra-cluster distance metric is consistent — mixing
  // embedding vectors and TF-IDF vectors in one clustering pass would
  // produce nonsense distances.
  const allHaveEmbeddings = usable.every((e) => e.embedding !== undefined);
  const confidence: 'high' | 'low' = allHaveEmbeddings ? 'high' : 'low';

  const tokenLists = usable.map((e) => tokenize(e.firstUserTurn));

  let vectors: Embedding[];
  if (allHaveEmbeddings) {
    vectors = usable.map((e) => e.embedding as Embedding);
  } else {
    // Build a shared vocabulary over the whole input. We cap by document
    // frequency to keep the vector dimension tractable — terms appearing
    // in only one document add noise without signal.
    const dfCounts = new Map<string, number>();
    for (const tokens of tokenLists) {
      const seen = new Set(tokens);
      for (const t of seen) dfCounts.set(t, (dfCounts.get(t) ?? 0) + 1);
    }
    const vocabTerms = [...dfCounts.entries()]
      .filter(([, df]) => df >= 2)
      .map(([t]) => t);
    const vocab = new Map<string, number>();
    vocabTerms.forEach((t, i) => vocab.set(t, i));
    // Smoothed IDF (sklearn-style): `log((N + 1) / (df + 1)) + 1`. The
    // `+1` floor ensures that a term appearing in every document still
    // contributes a non-zero weight — without it, an N-document corpus
    // where all docs share a vocabulary collapses to the zero vector
    // and clustering returns nothing.
    const idf: number[] = vocabTerms.map((t) => {
      const df = dfCounts.get(t) ?? 1;
      return Math.log((usable.length + 1) / (df + 1)) + 1;
    });
    vectors = tokenLists.map((tokens) => tfidfVector(tokens, vocab, idf));
  }

  const clusterInputs: ClusterInput[] = usable.map((e, i) => ({
    id: e.sessionId,
    vector: vectors[i] as Embedding,
    tokens: tokenLists[i] as readonly string[],
    text: e.firstUserTurn,
  }));

  // We need access to the cluster's member-indices to pick the
  // canonical question + compute first/last seen. `discoverClusters`
  // returns `memberIds`, so we map back through a sessionId → index
  // table.
  const sessionIdToIndex = new Map<string, number>();
  usable.forEach((e, i) => sessionIdToIndex.set(e.sessionId, i));

  const discovered = discoverClusters(clusterInputs, {
    threshold: intraClusterCosineMin,
    minSize: minClusterSize,
    labelTermCount: 5,
    labelStrategy: 'tfidf',
  });

  // Build the corpus-wide DF map for canonical-question picking in
  // small clusters where we still want labelTerm-aware scoring.
  const dfMap = new Map<string, number>();
  for (const tokens of tokenLists) {
    const seen = new Set(tokens);
    for (const t of seen) dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
  }

  const out: KnowledgeDebtCluster[] = [];
  for (const cluster of discovered) {
    const memberIndices = cluster.memberIds
      .map((id) => sessionIdToIndex.get(id))
      .filter((i): i is number => i !== undefined);
    if (memberIndices.length < minClusterSize) continue;

    // Canonical question: closest to the centroid for the
    // high-confidence path, top-tfidf-overlap for the fallback path.
    let canonicalQuestion: string;
    if (allHaveEmbeddings) {
      const bestIdx = pickCentroidMember(memberIndices, vectors);
      canonicalQuestion = (usable[bestIdx] as KnowledgeDebtEntry).firstUserTurn;
    } else {
      // Pick the member with the most distinctive-term hits — i.e. the
      // text that best embodies the cluster's distinctive vocabulary.
      const labelTermSet = new Set(cluster.labelTerms);
      let bestIdx = memberIndices[0] as number;
      let bestScore = -1;
      for (const idx of memberIndices) {
        const tokens = tokenLists[idx] as readonly string[];
        let s = 0;
        for (const t of tokens) if (labelTermSet.has(t)) s += 1;
        if (s > bestScore) {
          bestScore = s;
          bestIdx = idx;
        }
      }
      canonicalQuestion = (usable[bestIdx] as KnowledgeDebtEntry).firstUserTurn;
    }

    let firstSeen = Infinity;
    let lastSeen = -Infinity;
    const sessionIds: string[] = [];
    for (const idx of memberIndices) {
      const e = usable[idx] as KnowledgeDebtEntry;
      sessionIds.push(e.sessionId);
      if (e.timestamp < firstSeen) firstSeen = e.timestamp;
      if (e.timestamp > lastSeen) lastSeen = e.timestamp;
    }

    // Recompute labelTerms over our tokenization (the discoverer used
    // its own tokens — same source, so they should match, but be
    // defensive about ordering / duplicates).
    const memberTokenSets = memberIndices.map(
      (idx) => new Set(tokenLists[idx] as readonly string[]),
    );
    const labelTerms = pickDistinctiveTerms(memberTokenSets, dfMap, usable.length, 5);

    out.push({
      id: cluster.id,
      canonicalQuestion,
      labelTerms,
      sessionIds,
      firstSeen,
      lastSeen,
      confidence,
    });
  }

  // Sort by recurrence count desc, then by recency.
  out.sort((a, b) => {
    if (b.sessionIds.length !== a.sessionIds.length) {
      return b.sessionIds.length - a.sessionIds.length;
    }
    return b.lastSeen - a.lastSeen;
  });

  return out;
}

/**
 * Render the cluster list as an Obsidian-targeted markdown document.
 * YAML frontmatter includes `tags: [knowledge-debt]`, `aliases: []`,
 * and a `created` ISO timestamp so the note slots into a vault
 * cleanly. The viewer's "Export to Obsidian" action consumes this.
 */
export function renderObsidianMarkdown(
  clusters: readonly KnowledgeDebtCluster[],
  options: { generatedAt?: number } = {},
): string {
  const generatedAt = options.generatedAt ?? Date.now();
  const createdIso = new Date(generatedAt).toISOString();
  const lines: string[] = [];
  lines.push('---');
  lines.push('tags: [knowledge-debt]');
  lines.push('aliases: []');
  lines.push(`created: ${createdIso}`);
  lines.push('---');
  lines.push('');
  lines.push('# Knowledge Debt');
  lines.push('');
  lines.push(
    'Questions that recur across sessions — candidates for a CLAUDE.md / skill / note that pays the debt down.',
  );
  lines.push('');

  if (clusters.length === 0) {
    lines.push('_No recurring-question clusters detected on this corpus._');
    lines.push('');
    return lines.join('\n');
  }

  for (const c of clusters) {
    const firstIso = new Date(c.firstSeen).toISOString().slice(0, 10);
    const lastIso = new Date(c.lastSeen).toISOString().slice(0, 10);
    lines.push(`## ${c.canonicalQuestion.replace(/\n+/g, ' ').slice(0, 120)}`);
    lines.push('');
    lines.push(`- **Sessions:** ${c.sessionIds.length}`);
    lines.push(`- **First seen:** ${firstIso}`);
    lines.push(`- **Last seen:** ${lastIso}`);
    lines.push(`- **Confidence:** ${c.confidence}`);
    if (c.labelTerms.length > 0) {
      lines.push(`- **Terms:** ${c.labelTerms.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
