/**
 * Semantic project classification — orchestration layer.
 *
 * Ties the embed worker to the uploaded data + claude.ai projects list +
 * classification math. One-shot async pipeline:
 *
 *   1. Build centroid texts from each project's name + description +
 *      prompt_template. One string per project.
 *   2. Build document texts from each cloud session's title + summary +
 *      first human message. One string per session.
 *   3. Stream both through the embed worker (batched in the worker).
 *   4. Classify each document against the centroids with
 *      `classifyByEmbedding` — pure math, ~50ms for the whole corpus.
 *   5. Return a map of sessionId → label so the viewer can merge it into
 *      its render path without mutating `UnifiedSessionEntry`.
 *
 * Why the result is a sidecar map (not written back onto entries): the
 * semantic classifier is an *enrichment* layer, not a source of truth.
 * Keeping it separate means:
 *
 *   - `UnifiedSessionEntry` shape is unchanged — Node exporter output
 *     stays byte-identical to schemaVersion 2
 *   - The user can toggle τ or turn off semantic labels without
 *     reprocessing the uploaded archive
 *   - Persisted-upload migration is a no-op: older IDB entries just
 *     miss the sidecar until re-classified
 */

import type { CloudConversation, CloudProject } from '@chat-arch/schema';
import {
  allHumanText,
  classifyChunksOfOne,
  discoverClusters,
  discoverClustersAsync,
  firstHumanText,
  reduceOutliers,
  type ClassifyOptions,
  type ClusterInput,
  type DiscoveredCluster,
  type ProjectCentroid,
} from '@chat-arch/analysis';
import type { EmbedClient } from './embedClient.js';
import type { UploadedCloudData } from '../types.js';

/**
 * Per-session label produced by the classifier. `projectId === null`
 * means the best match was below threshold or inside the margin — i.e.
 * we abstained. The similarity score is still retained for UI
 * transparency (hover tooltip, debug panel).
 */
export interface SemanticLabel {
  /** Chosen project id (== displayName from `projects.json`) or null. */
  projectId: string | null;
  /** Cosine similarity of the best match, regardless of assignment. */
  similarity: number;
}

/**
 * How the label set was produced. Drives the UI readout ("~ 426
 * INFERRED" vs. "~ 221 GROUPED") and dictates whether the `projectId`
 * values are known project names (classification mode) or synthesized
 * cluster terms like `~git + commit + changes` (discovery mode).
 */
export type SemanticMode = 'classify' | 'discover';

export interface SemanticLabelsBundle {
  /**
   * Schema version for the persisted sidecar. Bumped whenever the
   * embedding pipeline changes in a way that invalidates cached vectors
   * (model swap, tokenizer change, pooling change). When the persisted
   * version doesn't match the current code's version, the viewer discards
   * the cache and re-runs classification.
   *
   * History:
   *   v1 — firstHumanText + title + summary, single vector per session
   *   v2 — allHumanText chunked to ≤1800 chars, max-sim across chunks
   *        per centroid. Strictly more coverage; v1 bundles invalidated
   *        because their "similarity" numbers aren't comparable.
   *   v3 — embedder swap to Xenova/bge-small-en-v1.5 with CLS pooling
   *        (MiniLM used mean pooling). Cosine distribution sits on a
   *        different manifold; v2's numbers aren't comparable. Also
   *        adds the c-TF-IDF outlier-reassignment pass — so v2 bundles
   *        have gaps v3 would have filled even at the same embedder.
   *   v4 — adds `analyzedSessionIds` (the set of session ids the run
   *        considered, regardless of outcome) so the UI can tell
   *        "bundle is stale because NEW sessions arrived" apart from
   *        "bundle is complete; some sessions legitimately got no
   *        label because they had no embed-able content." v3 bundles
   *        lack this field — treated as stale on first load so the
   *        user re-runs once and gets an honest staleness signal
   *        afterward.
   */
  version: 4;
  /** Which model produced these embeddings — e.g. `Xenova/bge-small-en-v1.5`. */
  modelId: string;
  /**
   * How the labels were produced:
   *   - `classify`: seed-based nearest-project assignment; `projectId`
   *     values are real claude.ai project names from projects.json.
   *   - `discover`: unsupervised complete-linkage clustering over the
   *     corpus; `projectId` values are synthesized cluster labels of the
   *     form `~term1 + term2 + term3`.
   */
  mode: SemanticMode;
  /** Threshold τ and margin used at classification time. */
  options: Required<Pick<ClassifyOptions, 'threshold' | 'margin'>>;
  /** ms-since-epoch. Used to decide whether to re-classify on new uploads. */
  generatedAt: number;
  /** Per-session classification outcome. Keyed by session.id. */
  labels: Map<string, SemanticLabel>;
  /**
   * The set of session ids this classification run *considered* —
   * regardless of whether the session ended up with a non-null label.
   * Superset of `labels.keys()`: a session that entered the pipeline
   * but had no embed-able content (empty chunks, assistant-only, etc.)
   * is recorded here but absent from `labels`.
   *
   * The AnalysisLauncher uses this to distinguish two states that
   * used to collapse into "STALE":
   *   1. The corpus grew since this bundle was built — genuinely
   *      stale; re-run will label the new sessions.
   *   2. The classifier already looked at every current session but
   *      some had no embed-able content — NOT stale; re-run won't
   *      help.
   *
   * Comparing `currentSessionIds \ analyzedSessionIds` isolates case (1).
   */
  analyzedSessionIds: ReadonlySet<string>;
  /** Which runtime the worker actually used; surfaced in the UI for honesty. */
  device: 'webgpu' | 'wasm';
}

export interface ClassifyProgress {
  /**
   * Human-readable phase: what the UI should display right now.
   *
   * `finding emergent topics` is the hybrid-mode tail pass that runs
   * after classify completes: any session that didn't beat τ against
   * any named project centroid goes through unsupervised clustering
   * so we can surface emergent themes (labeled `~term + term + term`)
   * inside what would otherwise stay "UNKNOWN". Only fires in
   * `classify` mode when there are enough unknowns to form clusters.
   */
  phase:
    | 'downloading model'
    | 'embedding projects'
    | 'embedding sessions'
    | 'classifying'
    | 'finding emergent topics'
    | 'clustering';
  /** 0..1 progress within the current phase, or null when indeterminate. */
  fraction: number | null;
}

export interface ClassifySessionsOptions extends ClassifyOptions {
  /** Callback for UI progress updates. Optional; defaults to no-op. */
  onProgress?: (p: ClassifyProgress) => void;
  /**
   * Called as each session's chunks finish embedding and the session
   * gets classified. Fires zero or more times *during* the embed pass
   * (not after), in session-complete order (which roughly follows
   * corpus order because chunks are embedded in batch-of-32 forward
   * order). The final bundle returned by the Promise still contains
   * every label; this callback is for live UI updates that don't want
   * to wait for the full embed to resolve.
   *
   * Only fires in `classify` mode (when projects.json is present).
   * Discovery mode doesn't stream because clustering is a global
   * operation that can't commit to a label per-session until it's
   * seen the whole corpus.
   */
  onLabel?: (sessionId: string, label: SemanticLabel) => void;
  /**
   * Called once per emergent cluster as discovery produces it. Fires
   * only during the hybrid tail pass (classify mode with the emergent
   * topics phase). The callback receives the final `~term + term`
   * label string and the cluster's member count so a log UI can show
   * topics as they land ("Discovered ~git + commit + review
   * (15 sessions)") instead of only seeing the aggregate summary at
   * run end.
   */
  onCluster?: (label: string, memberCount: number) => void;
  /**
   * Override which modelId is recorded in the output
   * `SemanticLabelsBundle.modelId` field. Does NOT change the
   * embedder — that's baked into the `client` handle the caller
   * constructs via `createEmbedClient({ modelId, pooling })`. This
   * override exists so the bundle metadata matches the client's
   * actual model (the benchmark harness needs per-row accuracy;
   * the production caller passes nothing and the module constant
   * wins).
   */
  modelId?: string;
}

const MODEL_ID = 'Xenova/bge-small-en-v1.5';
/**
 * Minimum cosine similarity for classification against a project centroid.
 *
 * BGE-small-en-v1.5's contrastively-trained cosine distribution sits
 * tighter than MiniLM-L6-v2's — matched pairs score higher, and the
 * abstain/accept boundary shifts. 0.38 is an educated lower-bound to
 * start with; recalibrate on the first real-corpus run (bias down to
 * 0.36 if classified% undershoots 70%, up to 0.42 if false-positives
 * dominate). Kept as close to MiniLM's 0.40 as reasonable so the UX
 * posture ("classifier is conservative; discovery fills the tail")
 * stays intact.
 */
const DEFAULT_THRESHOLD = 0.38;
const DEFAULT_MARGIN = 0.02;
/**
 * Discovery-mode threshold. Complete-linkage clustering — every pair of
 * documents in a merged cluster must exceed this cosine similarity.
 * Tuned on the real chat-arch corpus under MiniLM: τ=0.50 produces ~29
 * coherent clusters covering ~25% of the distinctive-content docs.
 * Tighter values over-fragment; looser values readmit the single-
 * linkage chain effect.
 *
 * Left at 0.50 for the BGE swap — BGE concentrates both matched and
 * unmatched pairs at higher cosine, so lowering τ here would compound
 * with the new reduceOutliers pass and risk overshooting the 20-25%
 * emergent target with noisy clusters. If empirically under-clustered
 * after the swap, bias UP to 0.52-0.55 rather than down.
 */
const DISCOVER_THRESHOLD = 0.5;

/**
 * Default minimum token count for a document to participate in
 * clustering. Conversations with fewer distinctive tokens (empty
 * titles, one-word summaries) drag cluster quality down without
 * contributing a coherent label of their own.
 */
const DISCOVER_MIN_TOKEN_COUNT = 3;

/** Tokens we strip before TF-IDF weighting. Calibrated on real chat-arch
 *  conversation text: generic claude.ai / project / programming boilerplate
 *  that would dominate scores if not excluded.
 *
 *  When you spot a useless emergent label like
 *  `~observations + throughout + taking 4` after a real run, add the
 *  offending generic word here rather than bumping cluster thresholds —
 *  the label, not the cluster, is usually the problem.
 */
const CLUSTER_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'are', 'not', 'can', 'was',
  'has', 'have', 'will', 'would', 'could', 'should', 'they', 'their', 'them', 'its', 'but',
  'also', 'using', 'about', 'into', 'out', 'any', 'all', 'our', 'your', 'his', 'her',
  'more', 'less', 'most', 'when', 'where', 'who', 'been', 'being', 'had', 'did', 'does',
  'doing', 'get', 'got', 'let', 'make', 'made', 'ask', 'said', 'say', 'see', 'know',
  'think', 'specifically', 'actually', 'really', 'just', 'very', 'quite', 'rather',
  'still', 'already', 'another', 'several', 'many', 'much', 'good', 'better', 'best',
  'well', 'often', 'sometimes', 'always', 'never', 'then', 'now', 'here', 'there',
  'because', 'since', 'although', 'however', 'therefore', 'thus', 'while', 'after',
  'before', 'during', 'through', 'over', 'under', 'each', 'both', 'either', 'same',
  'different', 'various', 'certain', 'want', 'need', 'feel', 'look', 'looked', 'looking',
  'current', 'currently', 'recent', 'recently', 'build', 'building', 'built', 'create',
  'creating', 'created', 'update', 'updated', 'work', 'works', 'worked', 'setting',
  'add', 'adds', 'added', 'code', 'codebase', 'project', 'projects', 'application',
  'app', 'apps', 'file', 'files', 'data', 'function', 'functions', 'method', 'methods',
  'check', 'checking', 'reviewing', 'reviewed', 'implement', 'implementing', 'implemented',
  'comprehensive', 'detailed', 'complete', 'full', 'simple', 'complex', 'important',
  'based', 'approach', 'approaches', 'strategy', 'strategies', 'overview', 'summary',
  'solution', 'solutions', 'problem', 'problems', 'issue', 'issues', 'task', 'tasks',
  'process', 'processes', 'system', 'systems', 'design', 'designing', 'designed',
  'development', 'developing', 'test', 'testing', 'tested', 'document', 'documents',
  'documentation', 'description', 'conversation', 'user', 'assistant', 'claude', 'chat',
  // Added 2026-04-19 after the first real run produced labels like
  // `~observations + throughout + taking 4` and `~steps + next + review 1` —
  // all generic process / progress / meta words that were never going to
  // be filter targets. Heuristic: if this word would never end a
  // sentence like "I want to filter on…", it's a stopword.
  'observations', 'observation', 'throughout', 'taking', 'note', 'notes', 'noted',
  'floating', 'years', 'highest', 'priorities', 'priority', 'integrating', 'integration',
  'hiding', 'warnings', 'warning', 'steps', 'step', 'review', 'reviews', 'scalable',
  'finalizing', 'finalize', 'progress', 'progressing', 'automating', 'automate',
  'exploring', 'explore', 'organizing', 'organize', 'generate', 'generating', 'generated',
  'optimizing', 'optimize', 'optimized', 'runtime', 'reusability', 'corrupted',
  'sequential', 'opportunity', 'mitigation', 'analyzed', 'adaptation', 'crafting',
  'capture', 'recogniti', 'getting', 'started', 'continuing', 'redirect', 'managed',
  'managing', 'manag', 'collapse', 'mv', 'mvp',
]);
const WORD_RE = /[a-z][a-z]{2,}/g;

function tokenizeForClustering(raw: string): string[] {
  const matches = raw.toLowerCase().match(WORD_RE);
  if (!matches) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of matches) {
    if (CLUSTER_STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Build a centroid embedding text for a project. Concatenates the fields
 * that carry the most semantic signal about what the project is about —
 * name (distinctive token), description (user-authored explanation),
 * prompt_template (Claude's system prompt, often rich with domain terms).
 *
 * Cap at ~2000 chars so the tokenizer's 512-token window doesn't get
 * stressed (both MiniLM-L6-v2 and BGE-small-en-v1.5 use a 512-token
 * input window); the first ~2000 chars of a description are always
 * dominated by the useful signal.
 */
function projectToText(p: CloudProject): string {
  const name = typeof p.name === 'string' ? p.name : '';
  const desc = typeof p.description === 'string' ? p.description : '';
  const tmpl = typeof p.prompt_template === 'string' ? p.prompt_template : '';
  return [name, desc, tmpl].filter((x) => x.length > 0).join('\n').slice(0, 2000);
}

/**
 * Both MiniLM-L6-v2 and BGE-small-en-v1.5 have a 512-token input window.
 * In the typical 1 token ≈ 4 char regime of English + code that's ~2000
 * chars; we leave a small safety margin at 1800 so rare high-density
 * bursts (emoji, CJK, base64) don't silently truncate inside the
 * tokenizer. Worth tuning per-model if we swap to a longer-context
 * embedder (e.g. Jina v2-small's 8K tokens → ~24,000 chars).
 */
const MAX_CHARS_PER_CHUNK = 1800;

/**
 * Break one cloud conversation into an array of chunks, each ≤
 * `MAX_CHARS_PER_CHUNK`. Built to feed the embedder fuller context per
 * session than the legacy "first human message only" approach.
 *
 * Ordering: `[title+summary, ...humanTurn0, ...humanTurn1, …]`. The
 * title+summary always goes first as its own chunk (unless empty) so
 * every session has *some* contextual anchor even when the human
 * messages are sparse or empty. Subsequent chunks come from each human
 * message in conversation order; messages longer than the limit get
 * split on whitespace boundaries.
 *
 * Why whitespace splits (not hard char-slice): MiniLM's tokenizer does
 * reasonable work when it sees whole words but struggles when a chunk
 * starts / ends mid-token — a stray partial-word can dominate the
 * chunk's pooled vector. This isn't pretty at every sentence boundary
 * but it's strictly better than hard slicing.
 *
 * Why we skip assistant / tool / thinking content: conversations often
 * include long code blocks in assistant responses. Including them would
 * swamp the human asks with generic "here is the code, let me explain"
 * text, hurting precision. The user's side is the topic signal.
 */
function conversationToChunks(conv: CloudConversation): string[] {
  const chunks: string[] = [];
  const title = typeof conv.name === 'string' ? conv.name : '';
  const summary = typeof conv.summary === 'string' ? conv.summary : '';
  const head = [title, summary].filter((x) => x.length > 0).join('\n');
  if (head.length > 0) {
    // A long title+summary combination is rare; if it happens,
    // truncate — the overflow carries little topic signal that the
    // human-turn chunks don't already cover.
    chunks.push(head.slice(0, MAX_CHARS_PER_CHUNK));
  }

  for (const turn of allHumanText(conv.chat_messages)) {
    if (turn.length <= MAX_CHARS_PER_CHUNK) {
      chunks.push(turn);
      continue;
    }
    // Split on whitespace boundaries. The regex eats the boundary so
    // emitted words don't carry trailing spaces; we re-introduce single
    // spaces at emit time. Words longer than the chunk limit (e.g. a
    // single base64 blob) fall through to a hard char-slice — the
    // worst case for a rare input.
    const words = turn.split(/\s+/);
    let buf = '';
    for (const w of words) {
      if (w.length === 0) continue;
      if (w.length > MAX_CHARS_PER_CHUNK) {
        if (buf.length > 0) {
          chunks.push(buf);
          buf = '';
        }
        for (let i = 0; i < w.length; i += MAX_CHARS_PER_CHUNK) {
          chunks.push(w.slice(i, i + MAX_CHARS_PER_CHUNK));
        }
        continue;
      }
      if (buf.length + 1 + w.length > MAX_CHARS_PER_CHUNK) {
        chunks.push(buf);
        buf = w;
      } else {
        buf = buf.length === 0 ? w : `${buf} ${w}`;
      }
    }
    if (buf.length > 0) chunks.push(buf);
  }

  // Safety net: if a conversation had neither title/summary nor any
  // usable human text, fall back to firstHumanText's legacy behavior
  // so we still produce *some* signal rather than skipping the session
  // entirely. Very rare in practice — mostly synthetic test fixtures.
  if (chunks.length === 0) {
    const hum = firstHumanText(conv.chat_messages);
    if (typeof hum === 'string' && hum.length > 0) {
      chunks.push(hum.slice(0, MAX_CHARS_PER_CHUNK));
    }
  }

  return chunks;
}

/**
 * Run the full classification pipeline. Returns a bundle suitable for
 * caching in IndexedDB + threading into the viewer's render layer.
 *
 * Throws if the upload has no `projects` list — callers should check
 * `uploaded.projects !== undefined` before invoking. (The viewer surfaces
 * that condition in the UI rather than triggering a surprise error.)
 */
export async function classifyUploadedSessions(
  uploaded: UploadedCloudData,
  client: EmbedClient,
  options: ClassifySessionsOptions = {},
): Promise<SemanticLabelsBundle> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const bundleModelId = options.modelId ?? MODEL_ID;
  const onProgress = options.onProgress;
  const hasProjects =
    uploaded.projects !== undefined && uploaded.projects.length > 0;

  onProgress?.({ phase: 'downloading model', fraction: null });
  const { device } = await client.ready();

  // -- Build document chunk texts (shared between both modes) --
  //
  // Only embed cloud sessions — local sessions already have authoritative
  // project labels from cwd. Each session fans out to 1..N chunks via
  // `conversationToChunks` (all human text split at whitespace
  // boundaries under the embedder's 512-token window — same for both
  // MiniLM-L6-v2 and BGE-small-en-v1.5). We flatten everything
  // into one `embedTexts` array so the worker sees one big batched
  // call and tracks a `chunkRanges[i] = [start, end)` index into the
  // flat result vector array per session — that's how we reassemble
  // per-session chunk groups after the embed call returns.
  const sessions = uploaded.manifest.sessions;
  const embedIds: string[] = [];
  /** `chunkRanges[i]` = half-open `[start, end)` into `sessionChunkVectors`. */
  const chunkRanges: Array<[number, number]> = [];
  const embedTexts: string[] = [];
  /**
   * The set of session ids this run considered — every cloud session
   * we iterated, regardless of whether it made it into `embedIds`.
   * A session skipped below (no conversation, no chunks) is still
   * "analyzed" by this run in the sense that re-running won't help
   * it. The bundle stores this so staleness detection can compare
   * corpus-then vs. corpus-now instead of comparing label count
   * (which under-counts by exactly the "skipped silently" set).
   */
  const analyzedSessionIds = new Set<string>();
  for (const s of sessions) {
    if (s.source !== 'cloud') continue;
    analyzedSessionIds.add(s.id);
    const conv = uploaded.conversationsById.get(s.id);
    if (conv === undefined) continue;
    const chunks = conversationToChunks(conv);
    if (chunks.length === 0) continue; // nothing to embed — skip silently
    const start = embedTexts.length;
    embedTexts.push(...chunks);
    const end = embedTexts.length;
    embedIds.push(s.id);
    chunkRanges.push([start, end]);
  }

  // -- Centroid embeddings (classify mode only) --
  let centroids: ProjectCentroid[] = [];
  if (hasProjects) {
    const projects = uploaded.projects as readonly CloudProject[];
    onProgress?.({ phase: 'embedding projects', fraction: 0 });
    const projectTexts = projects.map(projectToText);
    const projectVectors = await client.embed(projectTexts, {
      // Forward per-batch progress from the worker so the chip animates
      // during the embed call. Without this the UI sits at 0% until the
      // whole call resolves, which with WASM on a cold graph looks
      // identical to a hang. `total` is the same as `projectTexts.length`
      // but we take it from the worker message so any off-by-one between
      // batch size and total count is self-correcting.
      onProgress: (p) => {
        onProgress?.({
          phase: 'embedding projects',
          fraction: p.total > 0 ? p.loaded / p.total : null,
        });
      },
    });
    centroids = projectVectors
      .map((vector, i) => {
        const name = projects[i]?.name;
        if (typeof name !== 'string' || name.length === 0) return null;
        return { id: name, vector };
      })
      .filter((c): c is ProjectCentroid => c !== null);
    onProgress?.({ phase: 'embedding projects', fraction: 1 });
  }

  // -- Session chunk embeddings --
  //
  // The worker sees a single flat batch: all chunks for all sessions.
  // Progress fractions therefore count chunks (not sessions) — a 1041-
  // session corpus averaging ~3 chunks each is ~3000 embedding calls,
  // chunked internally by the worker into batches of 32. The loaded/
  // total values arrive straight from the worker so the UI fraction is
  // honest even if our averages are off.
  //
  // In classify mode, we also stream per-session labels as each
  // session's chunks finish embedding (see `onBatch` below). That
  // means the UI's filter pills and project counts start filling in
  // partway through the embed instead of flashing to final state all
  // at once at the end.
  onProgress?.({ phase: 'embedding sessions', fraction: 0 });
  const labels = new Map<string, SemanticLabel>();

  /**
   * For incremental classification we need to know, each time a batch
   * of chunk vectors arrives, which sessions' ranges are now fully
   * populated. We pre-compute a reverse index and a marker of
   * `chunksReadyCumulative` as batches come in, then sweep sessions
   * in order emitting labels for any whose `end` offset has been
   * covered.
   *
   * We only attempt this in classify mode because discovery mode
   * needs the full corpus before any single session can be labeled.
   */
  /**
   * Local mirror of the embed accumulator. We fill this ourselves as
   * `onBatch` callbacks arrive so we don't have to reach into the
   * embed client's private state to read in-progress vectors. The
   * client's own accumulator is eventually returned from the Promise
   * and assigned to `chunkVectors` — at that point this local mirror
   * should be identical.
   */
  const streamedVectors = new Array<Float32Array>(embedTexts.length);
  let classifyCursor = 0;
  const chunkSeen = new Uint8Array(embedTexts.length);

  const chunkVectors = await client.embed(embedTexts, {
    onProgress: (p) => {
      onProgress?.({
        phase: 'embedding sessions',
        fraction: p.total > 0 ? p.loaded / p.total : null,
      });
    },
    ...(hasProjects && options.onLabel
      ? {
          onBatch: (b): void => {
            // Fill the local mirror and the `seen` bitmap. Using a
            // Uint8Array marker + cursor sweep keeps the hot path
            // allocation-free despite firing on every worker batch.
            for (let k = 0; k < b.vectors.length; k += 1) {
              const idx = b.offset + k;
              streamedVectors[idx] = b.vectors[k] as Float32Array;
              chunkSeen[idx] = 1;
            }
            // Walk sessions forward from where we left off. If every
            // chunk offset in [start, end) has been seen, classify
            // the session and emit. Stop at the first session whose
            // range hasn't fully arrived yet — further sessions
            // haven't either, because the worker processes chunks in
            // forward order (`handleEmbed` iterates i += BATCH).
            while (classifyCursor < embedIds.length) {
              const range = chunkRanges[classifyCursor];
              if (!range) break;
              const [start, end] = range;
              // Defensive: an empty range (start === end) would pass
              // the `allIn` check trivially and hand an empty chunk
              // slice to `classifyChunksOfOne`, which correctly
              // returns `{projectId: null, similarity: 0}` — but it
              // would also do so *before* the session's chunks
              // arrived, falsely reporting "unlabeled". The session-
              // registration loop already filters empty chunk lists
              // (`continue` at chunks.length === 0), so this branch
              // is unreachable today. Kept as a latent-bug trap.
              if (end <= start) {
                classifyCursor += 1;
                continue;
              }
              let allIn = true;
              for (let c = start; c < end; c += 1) {
                if (chunkSeen[c] !== 1) {
                  allIn = false;
                  break;
                }
              }
              if (!allIn) break;
              const id = embedIds[classifyCursor] as string;
              const myChunks = streamedVectors.slice(start, end);
              const r = classifyChunksOfOne(myChunks, centroids, { threshold, margin });
              const label: SemanticLabel = {
                projectId: r.projectId,
                similarity: r.similarity,
              };
              labels.set(id, label);
              options.onLabel?.(id, label);
              classifyCursor += 1;
            }
          },
        }
      : {}),
  });
  onProgress?.({ phase: 'embedding sessions', fraction: 1 });

  if (hasProjects) {
    // -- Classify any sessions not already emitted via streaming --
    //
    // In normal operation the streaming pass above labels every
    // session before the embed Promise resolves. But: if the caller
    // didn't provide `onLabel` we skipped the onBatch path entirely
    // and nothing is labeled yet. Either way, this final sweep is
    // authoritative — it labels every session using the now-complete
    // `chunkVectors` buffer and fills any gaps (e.g. if the worker
    // ever delivered batches out of order).
    onProgress?.({ phase: 'classifying', fraction: 0 });
    for (let i = 0; i < embedIds.length; i += 1) {
      const id = embedIds[i] as string;
      if (labels.has(id)) continue; // already streamed
      const range = chunkRanges[i];
      if (!range) continue;
      const [start, end] = range;
      const myChunks = chunkVectors.slice(start, end);
      const r = classifyChunksOfOne(myChunks, centroids, { threshold, margin });
      labels.set(id, { projectId: r.projectId, similarity: r.similarity });
    }
    onProgress?.({ phase: 'classifying', fraction: 1 });

    // -- Hybrid tail pass: discover emergent topics over ALL sessions --
    //
    // Classify mode's ceiling is N = |projects.json| AND it only works
    // well when the user actually maintains rich descriptions /
    // prompt_templates for each project. In practice many users
    // don't — their real taxonomy lives in conversation titles and
    // content intent, not in project metadata. So we run discovery
    // clustering over **every** session's embedding (not just the
    // classify-abstained ones) and let topic structure emerge from
    // the full semantic space. The clustering input benefits from
    // the broader signal: denser neighborhoods form when all related
    // vectors are present, not just the subset that couldn't find a
    // centroid.
    //
    // When assigning the resulting `~term + term + term` labels,
    // though, we still prefer an existing classify label if one
    // landed — so a session string-matched or centroid-matched to
    // "PetConnect" stays "PetConnect". The discover label only
    // populates sessions where classify abstained (label.projectId
    // is null), which in practice is the large UNKNOWN bucket for
    // users with sparse projects.json.
    onProgress?.({ phase: 'finding emergent topics', fraction: 0 });
    const discoverInputs: ClusterInput[] = [];
    // Unfiltered per-session tokens — captured for every session the
    // classifier saw, even those below DISCOVER_MIN_TOKEN_COUNT. The
    // reduceOutliers pass below uses this as its full corpus for IDF;
    // filtering here would inflate rare-token weights against short
    // sessions, which are the exact population reduceOutliers aims
    // to rescue.
    const allSessionTokens = new Map<string, readonly string[]>();
    for (let i = 0; i < embedIds.length; i += 1) {
      const id = embedIds[i] as string;
      const range = chunkRanges[i];
      if (!range) continue;
      const [start, end] = range;
      const session = sessions.find((s) => s.id === id);
      const conv = uploaded.conversationsById.get(id);
      if (!session || !conv) continue;
      const labelText = `${session.title}\n${typeof conv.summary === 'string' ? conv.summary : ''}`;
      const tokens = tokenizeForClustering(labelText);
      allSessionTokens.set(id, tokens);
      if (tokens.length < DISCOVER_MIN_TOKEN_COUNT) continue;
      const sessionVector = meanPoolNormalized(chunkVectors.slice(start, end));
      if (sessionVector === null) continue;
      // `text` here is the conversation title verbatim — it's what
      // `labelStrategy: 'centroid-title'` uses to label the cluster
      // with the centroid member's actual chat title (e.g. "Setting
      // up OAuth with Google") instead of a tag bag like
      // `~google + oauth + sign`. Tokens still feed the TF-IDF
      // fallback for clusters whose centroid member has no title.
      discoverInputs.push({ id, vector: sessionVector, tokens, text: session.title });
    }

    // Collected during the discovery loop below — one entry per emergent
    // cluster that was formed, keyed by the cluster's final `~...` label.
    // The stored array is the concatenation of every member session's
    // unfiltered tokens. Consumed by reduceOutliers after the loop to
    // rescue classify+discover-orphaned sessions via c-TF-IDF cosine.
    const clusterTokens = new Map<string, readonly string[]>();

    // Only run clustering when there's enough signal to form groups.
    // With minSize=3 and 384-dim vectors at τ=0.50, fewer than ~30
    // inputs will mostly produce singletons/noise and waste the
    // user's time.
    const MIN_DISCOVER_INPUTS = 30;
    if (discoverInputs.length >= MIN_DISCOVER_INPUTS) {
      // Use the cooperative async variant for browser-side runs. The
      // sync version is O(n³) worst-case in the merge loop and locks
      // the main thread for tens of seconds on a 1041-doc corpus,
      // freezing the browser tab — observed as a user-reported
      // "browser is frozen" bug. The async variant yields to the
      // event loop every 16 merges / 64 sim rows, which is enough
      // for React to flush the streaming pills and the activity log
      // to tick its 250ms interval while clustering runs.
      const emergent = await discoverClustersAsync(discoverInputs, {
        threshold: DISCOVER_THRESHOLD,
        // minSize=4 (was 3) drops triplet-and-smaller clusters that
        // produced 30+ noise pills in the real-data run on 2026-04-19.
        // A 3-member cluster is too small for a useful filter target —
        // users want to ask "show me all my X chats" where X has at
        // least a handful of members. Triplets fall back into UNKNOWN
        // where they're at least honest about being unclassified.
        minSize: 4,
        labelTermCount: 3,
        // Real-sentence labels from the centroid member's title beat
        // TF-IDF tag-bags for filterability — users recognize a topic
        // by its title shape ("Setting up OAuth with Google") far
        // faster than by its keyword shape (`~google + oauth + sign`).
        // Falls back to TF-IDF per-cluster when the centroid member
        // has no usable title.
        labelStrategy: 'centroid-title',
        yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        onProgress: (f) => {
          onProgress?.({ phase: 'finding emergent topics', fraction: f });
        },
      });
      for (const c of emergent) {
        const labelId = `~${c.label}`;
        // Collect this cluster's aggregated token bag for the
        // reduceOutliers pass below. Each member's unfiltered tokens
        // get concatenated — repeated tokens contribute to in-cluster
        // TF.
        const bag: string[] = [];
        for (const memberId of c.memberIds) {
          const mtoks = allSessionTokens.get(memberId);
          if (mtoks !== undefined && mtoks.length > 0) bag.push(...mtoks);
        }
        if (bag.length > 0) clusterTokens.set(labelId, bag);

        // Fire cluster-level callback before assigning member labels
        // so a log UI sees "cluster discovered" preceding the per-
        // session pill count it produces. The count we pass is the
        // raw cluster size, not post-classify-wins filter — users
        // care about the cluster's actual reach, not how many of its
        // members ended up with the label after preference rules.
        options.onCluster?.(labelId, c.memberIds.length);
        for (const memberId of c.memberIds) {
          // Classify wins: if this session already has a real project
          // label from the classify pass (or string-matching upstream),
          // don't overwrite it. The discover label only fills
          // abstentions — which is precisely the UNKNOWN bucket users
          // want to see broken apart into emergent themes.
          const existing = labels.get(memberId);
          if (existing && existing.projectId !== null) continue;
          const newLabel: SemanticLabel = {
            projectId: labelId,
            similarity: c.threshold,
          };
          labels.set(memberId, newLabel);
          // Stream the emergent label out to any live consumer so
          // the UI picks up the tail of ~{term+term} pills without
          // waiting for the Promise to resolve — same streaming
          // contract as the classify phase above.
          options.onLabel?.(memberId, newLabel);
        }
      }
    }
    onProgress?.({ phase: 'finding emergent topics', fraction: 1 });

    // Outlier reassignment. Sessions that (a) abstained from every
    // project centroid AND (b) didn't get pulled into an emergent
    // cluster — a subset that includes both short-titled sessions
    // dropped by DISCOVER_MIN_TOKEN_COUNT and sessions whose embedding
    // landed in a sparse neighborhood — get a second chance via
    // c-TF-IDF cosine against each emergent cluster's aggregate token
    // bag. IDF is computed over the full `allSessionTokens` map (not
    // the DISCOVER_MIN_TOKEN_COUNT-filtered input) so the rescue
    // doesn't quietly penalize the population it's meant to rescue.
    // Below-threshold sessions stay unlabeled rather than get forced
    // onto a bad cluster.
    if (clusterTokens.size > 0) {
      const rescued = reduceOutliers({
        labels,
        allSessionTokens,
        clusterTokens,
      });
      for (const [sid, rescueAssignment] of rescued) {
        const newLabel: SemanticLabel = {
          projectId: rescueAssignment.projectId,
          similarity: rescueAssignment.similarity,
        };
        labels.set(sid, newLabel);
        options.onLabel?.(sid, newLabel);
      }
    }

    return {
      version: 4,
      modelId: bundleModelId,
      mode: 'classify',
      options: { threshold, margin },
      generatedAt: Date.now(),
      labels,
      analyzedSessionIds,
      device,
    };
  }

  // -- Discover clusters (no projects.json available) --
  //
  // Discovery still operates at the *session* granularity (one vector
  // per session), not at the chunk level — complete-linkage clustering
  // over thousands of chunk nodes would be cubic and produce noisy
  // labels. We collapse each session's chunks into a single
  // representative vector by element-wise mean + L2-renormalize
  // (mean-of-unit-vectors ≠ unit, so normalization is load-bearing
  // for downstream cosine comparisons).
  onProgress?.({ phase: 'clustering', fraction: 0 });
  const clusterInputs: ClusterInput[] = [];
  for (let i = 0; i < embedIds.length; i += 1) {
    const id = embedIds[i] as string;
    const range = chunkRanges[i];
    if (!range) continue;
    const [start, end] = range;
    const session = sessions.find((s) => s.id === id);
    const conv = uploaded.conversationsById.get(id);
    if (!session || !conv) continue;
    const labelText = `${session.title}\n${typeof conv.summary === 'string' ? conv.summary : ''}`;
    const tokens = tokenizeForClustering(labelText);
    if (tokens.length < DISCOVER_MIN_TOKEN_COUNT) continue;
    const sessionVector = meanPoolNormalized(chunkVectors.slice(start, end));
    if (sessionVector === null) continue;
    clusterInputs.push({
      id,
      vector: sessionVector,
      tokens,
      // Mirror the classify-mode discover branch above — pass the
      // session title so `labelStrategy: 'centroid-title'` can use it.
      text: session.title,
    });
  }

  const clusters: DiscoveredCluster[] = discoverClusters(clusterInputs, {
    threshold: DISCOVER_THRESHOLD,
    // Match the classify-mode minSize bump (see comment at the
    // discoverClustersAsync call above) so both paths produce the
    // same noise floor.
    minSize: 4,
    labelTermCount: 3,
    // Mirror the classify-mode label strategy so chips read
    // identically regardless of whether projects.json was provided.
    labelStrategy: 'centroid-title',
  });

  for (const c of clusters) {
    const labelId = `~${c.label}`;
    for (const memberId of c.memberIds) {
      labels.set(memberId, { projectId: labelId, similarity: c.threshold });
    }
  }
  onProgress?.({ phase: 'clustering', fraction: 1 });

  return {
    version: 4,
    modelId: bundleModelId,
    mode: 'discover',
    options: { threshold: DISCOVER_THRESHOLD, margin: 0 },
    generatedAt: Date.now(),
    labels,
    analyzedSessionIds,
    device,
  };
}

/**
 * Element-wise mean of a list of same-dimension vectors, then L2-
 * renormalized to unit length so the result is a valid input to
 * `cosineSimilarityNormalized`. Returns null when the input is empty
 * or all-zero (a zero vector has no meaningful direction to compare
 * against, so the caller should skip that session rather than pretend).
 */
function meanPoolNormalized(vectors: readonly Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = (vectors[0] as Float32Array).length;
  const acc = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) acc[i] = (acc[i] as number) + (v[i] as number);
  }
  let sq = 0;
  for (let i = 0; i < dim; i += 1) {
    acc[i] = (acc[i] as number) / vectors.length;
    sq += (acc[i] as number) * (acc[i] as number);
  }
  if (sq === 0) return null;
  const inv = 1 / Math.sqrt(sq);
  for (let i = 0; i < dim; i += 1) acc[i] = (acc[i] as number) * inv;
  return acc;
}
