/**
 * Unsupervised topic-cluster discovery — the fallback path when the user's
 * cloud export doesn't include a `projects.json` to classify against.
 *
 * Pipeline:
 *
 *   1. Agglomerative clustering, complete-linkage. Starts with every doc
 *      as its own cluster, repeatedly merges the pair of clusters whose
 *      *minimum* pairwise similarity (hence "complete linkage") is
 *      highest, stops when no merge clears `threshold`.
 *
 *      Why complete-linkage and not single-linkage: single-linkage chains
 *      on arbitrary noise ("A near B, B near C, C near D — merge all")
 *      and produced a 65%-of-corpus blob on real data (cluster-spike.mjs
 *      in the repo's probe dir). Complete-linkage requires every pair
 *      across merged clusters to stay ≥ threshold, which kills chaining.
 *
 *      Why not HDBSCAN: HDBSCAN is more principled for unknown-k
 *      discovery but much more to implement. For N ≲ few thousand, a
 *      dumb pairwise agglomerative pass runs in <1s per cluster count.
 *
 *   2. Cluster labeling via TF-IDF over member titles + summaries.
 *      Distinctive terms within a cluster vs. the corpus win — this is
 *      what turns a bag of conversations into `~csrf + error + ajax`.
 *
 * Pure functions throughout. Callers provide pre-computed embedding
 * vectors (same shape as the seed-based classifier consumes), and the
 * tokenized title/summary text per document. The browser embed worker
 * handles the actual MiniLM inference; this module only does the
 * downstream math.
 */

/** A unit-length embedding vector (L2 = 1 so cosine reduces to dot). */
export type Embedding = Float32Array;

export interface ClusterInput {
  /** Stable id (usually the session.id) — echoed into the output label. */
  id: string;
  /** Document vector; must be L2-normalized (the embed worker outputs this). */
  vector: Embedding;
  /** Tokens used for TF-IDF labeling. Typical input: distinctive words
   *  from title + summary with stopwords removed. */
  tokens: readonly string[];
  /**
   * Human-readable text for the document — typically the conversation
   * title. Used by `labelStrategy: 'centroid-title'` to pick a real-
   * sentence label from the cluster member closest to the cluster
   * centroid. Optional: when omitted (or empty), the centroid-title
   * strategy falls back to TF-IDF for that cluster so callers don't
   * have to thread placeholder strings through.
   */
  text?: string;
}

export interface DiscoveredCluster {
  /** Stable cluster id — hash of the sorted member ids; deterministic for
   *  a given input so UI state (expanded pills, route hashes) stays
   *  stable across re-runs on the same corpus. */
  id: string;
  /** Member document ids. */
  memberIds: readonly string[];
  /** Top-k distinctive terms, highest-weight first. */
  labelTerms: readonly string[];
  /** Human-readable label: `labelTerms.join(' + ')` with a `~` prefix
   *  added at render time. Precomputed for convenience. */
  label: string;
  /** Pairwise similarity threshold that was used — useful for UI tooltip. */
  threshold: number;
}

export interface DiscoverOptions {
  /**
   * Minimum pairwise similarity between any two documents in a merged
   * cluster (complete-linkage constraint). Tuned on the real 1,041-
   * conversation chat-arch corpus: 0.50 produces ~29 coherent clusters
   * covering ~25% of the distinctive-content docs. Tighter values yield
   * fewer, smaller, more homogeneous clusters; looser values admit
   * noisier merges.
   */
  threshold?: number;
  /** Minimum member count for a cluster to be surfaced. Defaults to 3 —
   *  pairs (2 members) are too weak to justify a shared label. */
  minSize?: number;
  /** How many distinctive terms to include in the label. Default 3. */
  labelTermCount?: number;
  /**
   * How to derive the human-readable `label` field on each output
   * cluster.
   *
   *   'tfidf' (default): top-`labelTermCount` distinctive tokens joined
   *     with ' + '. Cheap and consistent but reads as a tag bag —
   *     `commit + git + message` rather than `Git commit messages`.
   *
   *   'centroid-title': the title of the cluster member whose vector
   *     is closest to the cluster centroid (mean of member vectors).
   *     Reads as a real topic because it IS a real human-or-LLM-
   *     authored chat title. Requires `text` to be populated on
   *     `ClusterInput`; if a cluster's centroid member has no text,
   *     that one cluster falls back to the TF-IDF label.
   *
   * `labelTerms` is always populated via TF-IDF regardless of strategy
   * so debug tooltips and UI hover states have access to the keyword
   * shape. Only the rendered `label` field switches.
   */
  labelStrategy?: 'tfidf' | 'centroid-title';
}

/**
 * Options for the cooperative-yield variant. Same semantics as
 * `DiscoverOptions` plus a yield callback so long runs don't freeze
 * the browser — the clustering loop pauses every N merge iterations
 * to let the event loop process pending work (React flushes, log
 * updates, click events).
 */
export interface DiscoverOptionsAsync extends DiscoverOptions {
  /**
   * Called when the cooperative scheduler wants to yield. Typical
   * implementation: `() => new Promise(r => setTimeout(r, 0))`. The
   * caller owns the yield mechanism so we don't impose a dependency
   * on any specific scheduler (requestIdleCallback, scheduler.yield,
   * setTimeout) on this pure-math module.
   */
  yield: () => Promise<void>;
  /**
   * Called periodically with clustering progress in [0, 1]. Useful
   * for driving a UI progress bar / activity log heartbeat during the
   * long merge loop. Fires at the same cadence as `yield` (every N
   * merge iterations).
   */
  onProgress?: (fraction: number) => void;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_SIZE = 3;
const DEFAULT_LABEL_TERM_COUNT = 3;
/**
 * Maximum characters in a centroid-title label before we truncate with
 * an ellipsis. Tuned to fit comfortably in a single LCARS pill at the
 * project-pill row's typical viewport width without forcing wrap. Chat
 * titles are auto-generated by Claude.ai and usually hover around
 * 30-60 chars; 48 catches most of the topic-bearing prefix while
 * keeping pills compact.
 */
const CENTROID_TITLE_MAX_CHARS = 48;

/**
 * Pick the cluster member whose vector is closest to the cluster
 * centroid (mean of member vectors), and return its text trimmed to
 * `CENTROID_TITLE_MAX_CHARS`. Returns `null` when no member has usable
 * text — the caller falls back to TF-IDF labeling for that cluster.
 *
 * Why centroid (not e.g. longest text or first member): the centroid
 * member is by definition the most-representative document in the
 * cluster's embedding space, so its title is the best single proxy
 * for the cluster's theme. Picking by member order would surface
 * whichever conversation happened to come first in the input.
 *
 * Vectors are pre-normalized (L2=1), so the centroid is just the
 * arithmetic mean. We don't bother re-normalizing for the closeness
 * comparison since dot product against an unnormalized centroid
 * preserves the ranking — every candidate is compared against the
 * same denominator.
 */
function pickCentroidTitle(
  memberIndices: readonly number[],
  vectors: readonly Embedding[],
  texts: readonly (string | undefined)[],
): string | null {
  if (memberIndices.length === 0) return null;
  const dim = (vectors[memberIndices[0] as number] as Embedding).length;
  const centroid = new Float32Array(dim);
  for (const idx of memberIndices) {
    const v = vectors[idx] as Embedding;
    for (let d = 0; d < dim; d += 1) {
      centroid[d] = (centroid[d] as number) + (v[d] as number);
    }
  }
  // No need to divide by N — argmax(dot(v, centroid/N)) == argmax(dot(v, centroid)).

  let bestIdx = -1;
  let bestSim = -Infinity;
  for (const idx of memberIndices) {
    const text = texts[idx];
    if (typeof text !== 'string' || text.trim().length === 0) continue;
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

  if (bestIdx === -1) return null;
  const raw = (texts[bestIdx] as string).trim();
  if (raw.length <= CENTROID_TITLE_MAX_CHARS) return raw;
  // Truncate at the last word boundary inside the budget so we don't
  // end mid-word. The ellipsis costs one slot; reserve it from the
  // budget so the final string respects the cap.
  const sliceEnd = CENTROID_TITLE_MAX_CHARS - 1;
  const slice = raw.slice(0, sliceEnd);
  const lastSpace = slice.lastIndexOf(' ');
  // Only honor the word-boundary cut if it preserves at least 2/3 of
  // the slice — otherwise (very long single word, weird title) the
  // cut would amputate too aggressively and a hard slice reads better.
  const cut = lastSpace >= Math.floor(sliceEnd * 0.66) ? lastSpace : sliceEnd;
  return `${raw.slice(0, cut).trimEnd()}…`;
}

function dot(a: Embedding, b: Embedding): number {
  let s = 0;
  const len = a.length;
  for (let i = 0; i < len; i += 1) {
    s += (a[i] as number) * (b[i] as number);
  }
  return s;
}

interface AgglomCluster {
  memberIdx: number[];
  /** Frontier similarity with every other active cluster, keyed by that
   *  cluster's stable id in the `clusters` array. Refreshed after each
   *  merge. */
}

/**
 * Complete-linkage agglomerative clustering over unit-length vectors.
 * Stops when the best cluster pair's min-pair similarity drops below
 * `threshold`. Returns arrays of input-index lists.
 */
function completeLinkageClusters(
  vectors: readonly Embedding[],
  threshold: number,
): number[][] {
  const n = vectors.length;
  if (n === 0) return [];

  // Pairwise similarity matrix, upper-triangular flattened. Fast access
  // via a helper; stays resident for the whole clustering pass. At 1000
  // docs × 384 dims this is 4 MB — small enough to keep hot.
  const simKey = (i: number, j: number): number => (i < j ? i * n + j : j * n + i);
  const sim = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const s = dot(vectors[i] as Embedding, vectors[j] as Embedding);
      sim[simKey(i, j)] = s;
    }
  }

  // Active clusters — initialize one per doc.
  const clusters: AgglomCluster[] = [];
  const activeIds: number[] = [];
  for (let i = 0; i < n; i += 1) {
    clusters.push({ memberIdx: [i] });
    activeIds.push(i);
  }
  // Min-pair similarity cache between active cluster ids.
  const linkSim = new Map<string, number>();
  const linkKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

  function computeLink(a: number, b: number): number {
    const ma = clusters[a]!.memberIdx;
    const mb = clusters[b]!.memberIdx;
    let minSim = Infinity;
    for (const x of ma) {
      for (const y of mb) {
        const s = sim[simKey(x, y)]!;
        if (s < minSim) minSim = s;
      }
    }
    return minSim;
  }

  // Seed the cache with pairwise (singleton) similarities.
  for (let a = 0; a < activeIds.length; a += 1) {
    for (let b = a + 1; b < activeIds.length; b += 1) {
      const idA = activeIds[a]!;
      const idB = activeIds[b]!;
      linkSim.set(linkKey(idA, idB), sim[simKey(idA, idB)]!);
    }
  }

  while (true) {
    // Find the best active pair.
    let bestSim = -Infinity;
    let bestA = -1;
    let bestB = -1;
    for (let a = 0; a < activeIds.length; a += 1) {
      for (let b = a + 1; b < activeIds.length; b += 1) {
        const idA = activeIds[a]!;
        const idB = activeIds[b]!;
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
    const merged: AgglomCluster = {
      memberIdx: [...clusters[bestA]!.memberIdx, ...clusters[bestB]!.memberIdx],
    };
    clusters[bestA] = merged;
    clusters[bestB] = { memberIdx: [] }; // mark emptied
    activeIds.splice(activeIds.indexOf(bestB), 1);

    // Invalidate linkSim entries that touched A or B. Recompute for A
    // against every remaining active cluster. B's entries are stale
    // and just get skipped (absent → treated as "no merge possible").
    for (let k = 0; k < activeIds.length; k += 1) {
      const idK = activeIds[k]!;
      if (idK === bestA) continue;
      linkSim.delete(linkKey(bestA, idK));
      linkSim.delete(linkKey(bestB, idK));
      linkSim.set(linkKey(bestA, idK), computeLink(bestA, idK));
    }
  }

  return activeIds.map((id) => clusters[id]!.memberIdx);
}

/**
 * Pick the top `k` most-distinctive tokens across a cluster's members
 * using TF-IDF weighting. `df` is the corpus-wide document-frequency
 * map so rare-in-corpus / frequent-in-cluster terms rank highest.
 *
 * Exported separately from `discoverClusters` so callers can reuse the
 * labeling heuristic on pre-existing cluster sets (e.g. the seed-based
 * classifier's "UNKNOWN" bucket if we ever sub-cluster it).
 */
export function pickDistinctiveTerms(
  memberTokenSets: readonly ReadonlySet<string>[],
  df: ReadonlyMap<string, number>,
  corpusSize: number,
  k: number = DEFAULT_LABEL_TERM_COUNT,
): string[] {
  const scores = new Map<string, number>();
  for (const set of memberTokenSets) {
    for (const t of set) {
      const docs = df.get(t) ?? 1;
      const idf = Math.log(corpusSize / docs);
      scores.set(t, (scores.get(t) ?? 0) + idf);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([t]) => t);
}

/**
 * Deterministic cluster id from its sorted member ids. Used so UI state
 * (expanded panels, route hashes) keyed on cluster id stays stable
 * across re-classification runs over the same corpus.
 *
 * Keeps complexity inside the module rather than importing a hash
 * function from @noble/hashes here — the bundle is browser-side and we
 * want `@chat-arch/analysis` to stay lean. A simple FNV-1a over sorted
 * ids is enough: collisions are astronomically unlikely given the short
 * id space (<10k clusters per session) and we don't rely on the id for
 * security.
 */
function clusterIdFromMembers(memberIds: readonly string[]): string {
  const sorted = [...memberIds].sort();
  let h = 2166136261 >>> 0;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i += 1) {
      h ^= id.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    // separator so ['a','bc'] and ['ab','c'] don't collide
    h ^= 0x7c;
  }
  return `cl-${h.toString(16).padStart(8, '0')}`;
}

/**
 * Main entry. Takes a list of documents (id + vector + tokens) and
 * returns the surfaced clusters with TF-IDF-derived labels.
 */
export function discoverClusters(
  docs: readonly ClusterInput[],
  options: DiscoverOptions = {},
): DiscoveredCluster[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const k = options.labelTermCount ?? DEFAULT_LABEL_TERM_COUNT;
  const labelStrategy = options.labelStrategy ?? 'tfidf';

  if (docs.length === 0) return [];

  // Document-frequency map over the full input set.
  const df = new Map<string, number>();
  const tokenSets: ReadonlySet<string>[] = docs.map((d) => {
    const set = new Set(d.tokens);
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    return set;
  });

  const vectors = docs.map((d) => d.vector);
  const texts = docs.map((d) => d.text);
  const clusterIndexGroups = completeLinkageClusters(vectors, threshold);

  const out: DiscoveredCluster[] = [];
  for (const group of clusterIndexGroups) {
    if (group.length < minSize) continue;
    const memberIds = group.map((idx) => (docs[idx] as ClusterInput).id);
    const memberTokenSets = group.map((idx) => tokenSets[idx] as ReadonlySet<string>);
    const labelTerms = pickDistinctiveTerms(memberTokenSets, df, docs.length, k);
    // Strategy fork for the rendered label string. `labelTerms` (the
    // TF-IDF picks) is always populated for downstream tooltips and
    // debugging — only the user-visible `label` field switches.
    //
    // Centroid-title path: pick the cluster member closest to the
    // mean vector and use its conversation title (truncated). When
    // no member has usable text, fall through to TF-IDF for that
    // one cluster — this keeps the strategy switch resilient to the
    // small fraction of conversations with empty / placeholder titles.
    //
    // TF-IDF path: alpha-sort top-k tokens before joining so two
    // clusters with the same token set (in different score orders)
    // render as the same chip in the UI — the downstream label-id is
    // `~${label}`, so identical labels collapse to one filter pill,
    // collecting members of both clusters under one heading. (Real-
    // data symptom this fixed: `~failures + backend + fixing 20` and
    // `~failures + fixing + backend 5` were the same conceptual topic
    // split by complete-linkage's strict pairwise floor.)
    let label: string;
    if (labelStrategy === 'centroid-title') {
      const t = pickCentroidTitle(group, vectors, texts);
      label = t !== null ? t : [...labelTerms].sort().join(' + ');
    } else {
      label = [...labelTerms].sort().join(' + ');
    }
    out.push({
      id: clusterIdFromMembers(memberIds),
      memberIds,
      labelTerms,
      label,
      threshold,
    });
  }

  // Sort by size desc so the UI surfaces the largest clusters first.
  out.sort((a, b) => b.memberIds.length - a.memberIds.length);
  return out;
}

/**
 * Cooperative-yield variant of `completeLinkageClusters`. Functionally
 * identical to the sync version, but yields to the caller's scheduler
 * whenever CPU time since the last yield exceeds `YIELD_BUDGET_MS`.
 * Use when the input set is large enough that the sync version would
 * freeze the UI — calibrated during the 1041-session regression where
 * the sync version blocked the main thread for 10-60s and made the
 * browser appear unresponsive.
 *
 * Time-budget yielding (vs. iteration-count) is self-tuning: on a
 * fast machine more iterations fit in each 30ms window; on a slow
 * machine fewer do; both maintain ~30 FPS responsiveness regardless
 * of corpus size or machine speed.
 *
 * The yield callback is caller-provided so this module stays free of
 * scheduler dependencies (setTimeout / requestIdleCallback / etc.).
 * Typical browser usage: `() => new Promise(r => setTimeout(r, 0))`.
 */
// Maximum CPU budget between yields, in milliseconds. 30ms ≈ one
// 30-FPS frame, which is the perceptual threshold for "responsive"
// interaction. Iteration-count-based yielding (e.g. "yield every N
// merges") doesn't scale: on n=50 it yields too often and drowns in
// setTimeout overhead; on n=1000 it yields too rarely and still
// locks the UI. A time-budget check is self-tuning — fast machines
// do more iterations between yields, slow machines do fewer, both
// stay at ~30 FPS.
const YIELD_BUDGET_MS = 30;

async function completeLinkageClustersAsync(
  vectors: readonly Embedding[],
  threshold: number,
  yieldFn: () => Promise<void>,
  onProgress?: (fraction: number) => void,
): Promise<number[][]> {
  const n = vectors.length;
  if (n === 0) return [];

  // Wall-clock budget for yields. Reset on every yield so the next
  // chunk of work gets a fresh ~30ms window before relinquishing
  // control again.
  let lastYield = performance.now();
  const maybeYield = async (progress: number): Promise<void> => {
    if (performance.now() - lastYield < YIELD_BUDGET_MS) return;
    onProgress?.(progress);
    await yieldFn();
    lastYield = performance.now();
  };

  const simKey = (i: number, j: number): number => (i < j ? i * n + j : j * n + i);
  const sim = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const s = dot(vectors[i] as Embedding, vectors[j] as Embedding);
      sim[simKey(i, j)] = s;
    }
    // First half of total work is the sim matrix; scale to 0..0.5.
    await maybeYield((i / n) * 0.5);
  }
  onProgress?.(0.5);

  const clusters: AgglomCluster[] = [];
  const activeIds: number[] = [];
  for (let i = 0; i < n; i += 1) {
    clusters.push({ memberIdx: [i] });
    activeIds.push(i);
  }
  const linkSim = new Map<string, number>();
  const linkKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

  function computeLink(a: number, b: number): number {
    const ma = clusters[a]!.memberIdx;
    const mb = clusters[b]!.memberIdx;
    let minSim = Infinity;
    for (const x of ma) {
      for (const y of mb) {
        const s = sim[simKey(x, y)]!;
        if (s < minSim) minSim = s;
      }
    }
    return minSim;
  }

  for (let a = 0; a < activeIds.length; a += 1) {
    for (let b = a + 1; b < activeIds.length; b += 1) {
      const idA = activeIds[a]!;
      const idB = activeIds[b]!;
      linkSim.set(linkKey(idA, idB), sim[simKey(idA, idB)]!);
    }
  }

  // Track the initial active-cluster count so we can report progress
  // as a fraction of "work expected" — O(n) merges at most, so
  // `(n - activeIds.length) / n` is a reasonable 0..1 signal.
  const initialActive = activeIds.length;

  while (true) {
    let bestSim = -Infinity;
    let bestA = -1;
    let bestB = -1;
    for (let a = 0; a < activeIds.length; a += 1) {
      for (let b = a + 1; b < activeIds.length; b += 1) {
        const idA = activeIds[a]!;
        const idB = activeIds[b]!;
        const s = linkSim.get(linkKey(idA, idB));
        if (s !== undefined && s > bestSim) {
          bestSim = s;
          bestA = idA;
          bestB = idB;
        }
      }
      // Yield inside the best-pair scan too — on large n the scan
      // itself is O(k²) and can eat the entire budget by itself,
      // leaving the event loop starved. Checking the budget here
      // keeps the UI responsive even during a single merge's scan.
      const mergedSoFar = initialActive - activeIds.length;
      const frac = 0.5 + 0.5 * (mergedSoFar / Math.max(1, initialActive));
      await maybeYield(Math.min(1, frac));
    }

    if (bestSim < threshold || bestA === -1) break;

    const merged: AgglomCluster = {
      memberIdx: [...clusters[bestA]!.memberIdx, ...clusters[bestB]!.memberIdx],
    };
    clusters[bestA] = merged;
    clusters[bestB] = { memberIdx: [] };
    activeIds.splice(activeIds.indexOf(bestB), 1);

    for (let k = 0; k < activeIds.length; k += 1) {
      const idK = activeIds[k]!;
      if (idK === bestA) continue;
      linkSim.delete(linkKey(bestA, idK));
      linkSim.delete(linkKey(bestB, idK));
      linkSim.set(linkKey(bestA, idK), computeLink(bestA, idK));
    }
  }

  onProgress?.(1);
  return activeIds.map((id) => clusters[id]!.memberIdx);
}

/**
 * Async variant of `discoverClusters` — same API + output, but runs
 * the expensive O(n²) similarity matrix and O(n³)-worst-case merge
 * loop in a cooperatively-yielding scheduler so the UI thread can
 * still flush React updates, process input, and tick the activity
 * log while clustering runs. Use for browser-side clustering of
 * non-trivial corpora (rule of thumb: n > ~200).
 *
 * The synchronous `discoverClusters` stays the canonical function
 * for tests + Node spikes where determinism and straight-line
 * execution are preferred. Both produce identical cluster output
 * for the same input.
 */
export async function discoverClustersAsync(
  docs: readonly ClusterInput[],
  options: DiscoverOptionsAsync,
): Promise<DiscoveredCluster[]> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
  const k = options.labelTermCount ?? DEFAULT_LABEL_TERM_COUNT;
  const labelStrategy = options.labelStrategy ?? 'tfidf';

  if (docs.length === 0) return [];

  const df = new Map<string, number>();
  const tokenSets: ReadonlySet<string>[] = docs.map((d) => {
    const set = new Set(d.tokens);
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    return set;
  });

  const vectors = docs.map((d) => d.vector);
  const texts = docs.map((d) => d.text);
  const clusterIndexGroups = await completeLinkageClustersAsync(
    vectors,
    threshold,
    options.yield,
    options.onProgress,
  );

  const out: DiscoveredCluster[] = [];
  for (const group of clusterIndexGroups) {
    if (group.length < minSize) continue;
    const memberIds = group.map((idx) => (docs[idx] as ClusterInput).id);
    const memberTokenSets = group.map((idx) => tokenSets[idx] as ReadonlySet<string>);
    const labelTerms = pickDistinctiveTerms(memberTokenSets, df, docs.length, k);
    // Strategy fork — see the sync `discoverClusters` for the full
    // reasoning; this branch must stay byte-identical so callers using
    // the async variant see the same labels.
    let label: string;
    if (labelStrategy === 'centroid-title') {
      const t = pickCentroidTitle(group, vectors, texts);
      label = t !== null ? t : [...labelTerms].sort().join(' + ');
    } else {
      label = [...labelTerms].sort().join(' + ');
    }
    out.push({
      id: clusterIdFromMembers(memberIds),
      memberIds,
      labelTerms,
      label,
      threshold,
    });
  }

  out.sort((a, b) => b.memberIds.length - a.memberIds.length);
  return out;
}
