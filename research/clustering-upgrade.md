# Clustering pipeline upgrade — research memo

> **Corpus disclaimer.** The "real corpus" and "1,010-conversation" numbers
> throughout this memo come from the maintainer's personal claude.ai Privacy
> Export. They're anchored to one person's usage pattern (predominantly
> programming + writing work over ~18 months) and a single hardware/browser
> configuration. Treat them as directionally useful, not as a benchmark
> generalizable across users or corpora. Reproducing on your own export is
> the only way to get numbers you can act on.

**Scope.** Benchmark the current Chat Archaeologist semantic-analysis pipeline
(MiniLM-L6-v2 + τ-threshold + complete-linkage agglomerative) against modern
alternatives that remain fully in-browser. Recommend a migration.

**Date.** 2026-04-20. **Author.** Claude Opus 4.7 (handoff session).

**Observed baseline on the real corpus (1,010 conversations):**
~55 emergent topics (5.4%), rest split across ~26 pre-existing projects or
unlabeled. User hypothesis: the classifier is leaving topic structure on the
table.

---

## 1. Target cluster rate

### What the literature says

- **BERTopic default behavior** on short, heterogeneous text routinely
  produces high outlier rates (label `-1`) before any mitigation. De Groot,
  Aliannejadi & Haas (arXiv:2212.08459, WiNLP 2022) study BERTopic
  generalizability across multi-domain short text and report that the
  majority of documents frequently land in `-1` under HDBSCAN defaults on
  Twitter-scale corpora — the qualitative finding is robust though the
  paper doesn't quote a single headline percentage. BERTopic's own Best
  Practices FAQ notes outlier rates fall on longer narrative text (news,
  scientific abstracts).
- After `reduce_outliers()` (c-TF-IDF reassignment of `-1` to the nearest
  topic) the BERTopic Best Practices FAQ calls **90 %+ coverage** the
  default production recipe.
- **k-Means as an HDBSCAN replacement** raises coverage to 100 % by
  construction but loses the "abstain on noise" property, producing labels
  that look coherent by TF-IDF but may have no semantic substance on noisy
  corpora — the well-known recall/precision trade in the topic-modeling
  literature. We don't have a single citation quoting a precise
  coherence-loss number; the qualitative claim is widely replicated.

### What this corpus looks like

- 1,010 conversations. Each conversation's vector is built from human-turn
  text (average ~2–5 KB of text per session, chunked to ≤1800 chars and
  max-pooled against centroids / mean-pooled for clustering).
- ~26 pre-existing projects. The classifier's ceiling is therefore
  dominated by whichever sessions *could* be assigned to a project but
  currently abstain — not by "everything must be a cluster."

### Recommended target

**Two numbers to move, not one:**

| Metric                          | Today  | Target (phase 1) | Target (phase 2) |
|---------------------------------|--------|-----------------|-----------------|
| % sessions classified to a project | ~60 %  | ~70 %           | ~70 %           |
| % emergent topics                | 5.4 %  | ~20–25 %        | ~25–40 %        |
| % unlabeled                     | ~35 %  | ≤10 %           | ≤5 %            |
| Distinct topic count (including projects) | ~31 | 40–50 | 45–60 |

**Rationale.**

- We should **not** push to 90 % coverage on emergent clusters — the user
  has a real taxonomy from their claude.ai projects, and erasing that
  (letting discovery labels win everywhere) would be a UX regression. The
  classifier-first hybrid is the right shape; we're tuning the tail.
- 20–25 % emergent is defensible on structural grounds: once the
  classifier covers ~70 % against existing projects, the remaining ~30 %
  splits between clusterable new topics and genuinely noisy one-offs.
  Assuming ~10–15 % of chat sessions are unique one-offs that shouldn't
  cluster, the emergent bucket should land in the 15–20 % range — with
  upside to ~25 % if the `reduce_outliers` pass picks up borderline
  cases.
- The 45–60 distinct-topic count matches what the current UI can surface
  without pill-row overflow on a 1440 px viewport (measured on the real
  run: the project-pill row fits ~50 pills before wrapping awkwardly).

### Risk of pushing higher

Forcing 60–90 % emergent coverage via k-Means or aggressive `reduce_outliers`
means every conversation gets a topic label whether or not one belongs.
The topic-modeling literature is consistent on this: on corpora with no
real topic structure (random Twitter, noisy feedback forms), forced-
assignment methods produce labels that *look* coherent by TF-IDF score
but have no semantic substance. The user's conversations include one-offs
(onboarding, a single random question) that genuinely don't cluster, and
labeling them as topics is a trust-losing UX.

---

## 2. Embedder comparison

### Candidates that run in `@huggingface/transformers` 3.x

All rows assume q4f16 quantization on WebGPU where it exists on HF; ONNX
variant availability was verified directly against each model repo's
`onnx/` subfolder (or lack thereof) on 2026-04-20.

| Model                                 | Params | Dim | MTEB avg    | Smallest ONNX (HF file size)                 | Cold start (WebGPU, est.) | Notes                                                                                                           |
|---------------------------------------|-------:|----:|------------:|----------------------------------------------|--------------------------:|-----------------------------------------------------------------------------------------------------------------|
| **Xenova/all-MiniLM-L6-v2** (current) |   22 M | 384 | ~56         | q4f16 28 MB                                  | 1–3 s                     | Baseline. q4f16 / fp16 / fp32 all present in `onnx/`.                                                           |
| Xenova/bge-small-en-v1.5              |   33 M | 384 | **62.17**   | q4f16 **36.2 MB**                            | 2–4 s                     | +6 MTEB, same dim. Full dtype ladder (q4f16 / fp16 / fp32 / q8 / q4). **Lowest-risk swap — Phase 1 target.**    |
| Snowflake/snowflake-arctic-embed-xs   |   22 M | 384 | *unverified* | **no q4f16**; `model_quantized.onnx` = 23 MB; fp16 45.3 MB; fp32 90.4 MB | 1–3 s | Newer training, but lacks q4f16 — WebGPU/q4f16 branch in our cascade falls back one rung. Phase-1-replaceable if BGE underperforms, but the advertised aggregate MTEB isn't published on the model card. |
| jinaai/jina-embeddings-v2-small-en    |   33 M | 512 | *unverified* | **no `onnx/` subfolder**; only root `model.onnx` fp32 = 130 MB, plus `model-w-mean-pooling.onnx` fp32 | 2–4 s | **8 K context** — unique. **Blocker:** transformers.js 3.x looks under `onnx/` for dtype variants and finds none here. Phase-2 would need to host a converted `onnx/model_q4f16.onnx` ourselves (or use an unofficial Xenova mirror once one exists). |
| nomic-ai/nomic-embed-text-v1.5        |  137 M | 768 | 62.4        | varies                                       | 4–8 s                     | **Matryoshka**. Pooling is task-prefix-based, not mean-pool — requires worker changes beyond a MODEL_ID swap.     |
| google/embeddinggemma-300m            |  308 M | 768 | 65.11 (MTEB eng v2 Mean TaskType; 69.67 Mean Task) | ~180 MB | 10–20 s | SOTA under 500 M, but 6× cold-start cost over MiniLM. Note: the per-task MTEB aggregate is 69.67; the "overall" task-type aggregate is 65.11. Memo's earlier "64.7" was wrong. |

### Trade-offs specific to this pipeline

1. **Dim doesn't matter at 1 K docs.** The sim matrix is `n²·4 B`
   (≈3.9 MB at n=1010, independent of d). The embedding store itself is
   `n·d·4 B` (≈1.5 MB at d=384, ≈3.0 MB at d=768). Both fit easily in
   main memory; the real cost of higher d is the 2× dot-product ops per
   similarity and the 2× network cost on first download. (A code comment
   in `discoverClusters.ts` conflates these two quantities; don't let
   that mislead the sizing discussion.)
2. **8 K context (Jina) would help chunking.** Today we chunk at 1,800
   chars to fit MiniLM's 512-token window. Jina v2-small's 8 K window
   lets us embed a whole conversation as one vector — eliminating the
   max-sim-across-chunks logic and, more importantly, preserving
   within-conversation topic coherence that chunk max-pool destroys.
   This is a *qualitative* improvement not captured in MTEB.
3. **EmbeddingGemma is the ceiling.** But 6× cold-start and 6× download
   is a real UX regression on first use. Only worth it if Phase-1 (BGE
   small) doesn't clear the target.
4. **Matryoshka (Nomic) is interesting for memory.** Truncate the 768-dim
   vector to 384 for clustering math, keep 768 for search. Adds
   complexity to the pipeline for a use case we don't yet have.

### Recommended embedder path

- **Phase 1 (ship first):** `Xenova/bge-small-en-v1.5`. Same dim as
  MiniLM, +6 MTEB, and (verified on HF) full q4f16 / fp16 / fp32 ONNX
  ladder under `onnx/` — so our existing WebGPU dtype cascade works
  without code changes. See §5 for the full touch list.

  **Pooling is different.** MiniLM-L6-v2 was trained with mean pooling
  (`1_Pooling/config.json: pooling_mode_mean_tokens=true`); BGE-small-
  en-v1.5 was trained with CLS pooling (`pooling_mode_cls_token=true`).
  `transformers.js` does not auto-honor the model's
  sentence-transformers config — the `pooling` kwarg passed to the
  extractor wins. The current worker hardcodes `pooling: 'mean'` at
  `embedWorker.ts:759`. Swapping to BGE **requires** switching to
  `pooling: 'cls'` or every MTEB-trained assumption (the 62.17 average,
  the expected cosine distribution, the τ calibration) is against a
  different vector geometry than the model was trained on. This is the
  single riskiest step in Phase 1 because it produces silently wrong
  data, not a crash, if missed.

  **Query-prefix caveat.** BGE models' original release (`bge-small-en`)
  required a query-side instruction prefix (`"Represent this sentence
  for searching relevant passages: "`) for retrieval tasks. The v1.5
  models' card states the prefix is no longer strictly needed for
  similarity / classification tasks — it's optional. Our use case
  (session-chunk ⇄ project-centroid cosine) is borderline-asymmetric:
  a session is a query, a project centroid is a passage. Ship Phase 1
  **without** the prefix (keeps symmetry with MiniLM and matches the
  v1.5 card's default), but treat this as an empirical knob to revisit
  if Phase-1 classified % is below the 70 % target on the first real
  run. If so, adding a `queryInstruction` parameter to
  `classifyUploadedSessions` (prepended to session text only, not to
  centroids) is a ~20 LoC follow-up. The `DEFAULT_THRESHOLD = 0.38`
  figure is an **educated starting guess** based on BGE's tighter
  cosine distribution vs. MiniLM, not a measurement — treat the first
  real-corpus run as the calibration event.
- **Phase 2 (if Phase-1 under-performs the target):**
  `jinaai/jina-embeddings-v2-small-en` with `MAX_CHARS_PER_CHUNK`
  raised to ~24,000 (8 K tokens). This is the biggest qualitative
  lever — see §4 on chunking. **Blocker as of 2026-04-20:** the
  upstream `jinaai/jina-embeddings-v2-small-en` repo ships only a
  root-level `model.onnx` (130 MB fp32) — no `onnx/` subfolder, no
  q4f16/fp16 quantizations. Transformers.js 3.x's dtype loader won't
  find compatible variants. Phase-2 therefore requires one of:
  (a) wait for a `Xenova/…` mirror with the standard layout,
  (b) convert to q4f16/fp16 ourselves and host the ONNX files
  (turns Phase 2 into an ONNX-conversion project, not a model swap),
  or (c) ship the 130 MB fp32 — a ~4× first-run download regression.
  Re-evaluate when (a) lands, or swap to a different long-context
  model (EmbeddingGemma's 2 K context + SOTA quality may be a better
  trade once costs are acceptable).
- **Don't ship first:** EmbeddingGemma. Revisit if the corpus grows past
  5 K conversations and we have real density problems the smaller
  embedders can't solve.

---

## 3. Clustering algorithm comparison

### Current: complete-linkage agglomerative at τ=0.50

- O(n²) sim matrix + O(n³) worst-case merge loop.
- Cooperative async version with 30 ms yield budget ships in
  [discoverClusters.ts](packages/analysis/src/discoverClusters.ts).
- On 1,010 docs: ~3 s sim matrix + ~8–15 s merge loop in the browser.
- Produces ~29 clusters at τ=0.50 / min-size=4 on the real corpus. Of
  those, 55 total emergent labels (some are small, below the surface
  threshold) and 5.4 % of the corpus labeled emergent.

### Alternatives

| Approach                            | In-browser fit | Coverage behavior | Coherence (lit.)     | Complexity |
|-------------------------------------|---------------|-------------------|----------------------|------------|
| Complete-linkage (current)          | Ships today   | Variable, ~5–25 % | Medium               | O(n³)      |
| UMAP + HDBSCAN                      | **Poor** — `hdbscanjs` is partial, no SIMD/BLAS | 40–70 % outliers before mitigation | High | O(n log n) but JS GC thrash |
| UMAP + k-Means                      | Good — `umap-js` + `ml-kmeans` stable | 100 % by construction | Medium-low (over-merges) | O(n·k·i) |
| UMAP + agglomerative (Ward)         | Good — `umap-js` + existing AGG      | Variable   | Medium-high          | O(n³) still |
| FASTopic (Sinkhorn OT)              | **No port** — PyTorch only today | ~80–90 %   | **Highest** (NeurIPS 2024) | O(n·k·iter)  |
| BunkaTopics-style UMAP + k-Means    | Good           | 100 %      | Medium               | Well-paved  |

### In-depth

**UMAP + HDBSCAN.** The BERTopic default. Two ports of HDBSCAN exist for
JS — `hdbscanjs` and `hdbscan-js`. Both are from 2020–2022, neither is
actively maintained, both are pure JS with no SIMD. On a 1,010 × 50-dim
UMAP projection, HDBSCAN's O(n log n) theoretical complexity is dominated
by MST construction and cluster-hierarchy traversal; informal benchmarks
in community issues report ~10–30 s runtime on similar sizes due to GC
thrash. **Verdict: not production-viable without a serious porting
effort.** Worth reassessing in 2027 if someone builds a WASM HDBSCAN
(there's one stalled attempt tracked in `scikit-learn-contrib/hdbscan`'s
issues).

**UMAP + k-Means.** `umap-js` is mature (Andy Coenen, 5+ years stable).
`ml-kmeans` from mljs is reliable. The open question is `k`. BERTopic
leaves this to the user; BunkaTopics picks `k ≈ sqrt(n/2)` ~≈ 22 for
n=1010. The literature's big critique of k-Means for topics is
**over-merging**: two topics that should be separate get collapsed
because k-Means has to put every point somewhere. On this corpus with
~26 real projects plus ~20 expected emergent topics, k=40–50 is the
honest target — but we lose the "don't label one-offs" property that
justifies today's threshold-based abstention.

**FASTopic (NeurIPS 2024, arXiv:2405.17978).** Replaces the UMAP + HDBSCAN
sandwich with a single Sinkhorn optimal-transport step over pre-computed
embeddings. The paper claims coherence improvements over BERTopic on
several corpora (specific deltas not reproduced here — the paper's
headline tables are worth reading directly if this becomes a Phase-3
candidate). The core math is a regularized OT matrix multiplication
— portable in principle. **No in-browser port exists today.** Implementing
one is ~300 LoC plus an O(n²·k·i) inner loop; at n=1010, k=50, i=100, that's
5e9 FLOPs — doable in WASM in ~2–4 s, but a meaningful engineering bet.
Not a Phase-1 candidate; promising as a Phase-3 experiment.

**UMAP + agglomerative (keep our agglomerative).** Run UMAP to 10–50 dims,
then feed the projected vectors into the existing `completeLinkageClustersAsync`.
UMAP's main role here is **density-aware dimensionality reduction** —
384-dim cosine space has hard-to-cluster uniform-density regions in the
middle; UMAP's SGD attractive-repulsive force pulls neighbors together and
pushes non-neighbors apart, making complete-linkage at a higher τ (0.60–0.70)
produce tighter clusters. This is a **meaningful quality lift with minimal
risk** — we keep our merge loop, just give it better-shaped input.

### Recommended clustering path

- **Phase 1:** Keep complete-linkage. Add a **`reduce_outliers` pass**
  (§4) before labeling. **Leave `DISCOVER_THRESHOLD` at 0.50** for
  the initial ship — an earlier draft of this memo proposed lowering
  it to 0.45 on the hunch that BGE "makes clusters tighter," but that
  move is wrong-directional against complete-linkage's min-pairwise
  floor if BGE's cosine distribution concentrates *both* matched and
  unmatched pairs at higher values than MiniLM (which is the
  commonly-reported pattern — contrastively-trained encoders raise
  the floor for everything). Lower τ plus a new `reduce_outliers`
  pass compound: two levers pushing coverage up in the same direction
  risks overshooting the 20–25 % emergent target and producing
  noisier clusters than today. Anchor at τ=0.50, calibrate empirically
  on the first real run, and bias UP to 0.55 if cluster size is too
  large. `reduce_outliers` is the primary coverage lever.
- **Phase 2:** Add UMAP (n_components=15, n_neighbors=15, min_dist=0.0,
  metric='cosine') before complete-linkage. Raise τ to 0.65 for
  projected vectors. `umap-js` adds ~30 KB bundle.
- **Phase 3 (speculative):** Port FASTopic's OT core to WASM. Only if
  Phase 1 + 2 haven't hit the target.

### Do not ship

UMAP + k-Means as a total replacement. Losing "abstain on truly noisy
sessions" is a UX regression. k-Means can appear in the cache as a
**subroutine** (e.g. split large clusters via k-Means on their members)
but shouldn't replace agglomerative.

---

## 4. Post-clustering improvements

These are orthogonal to the embedder+clusterer choice and compound.

### 4.1 `reduce_outliers` (c-TF-IDF reassignment)

BERTopic's default post-processing: for every `-1`-labeled document,
compute a c-TF-IDF vector (term frequency × inverse cluster frequency) for
each existing cluster and assign the outlier to the cluster with the
highest c-TF-IDF cosine *if* above a secondary threshold.

For us: any session that's `projectId === null` AND didn't land in an
emergent cluster runs a second pass — re-classified against a c-TF-IDF
centroid built from the cluster's member titles+tokens. Threshold at
0.3 cosine.

**IDF-scope gotcha.** Today's `discoverClustersAsync` operates on a
token set filtered by `DISCOVER_MIN_TOKEN_COUNT` (short sessions are
dropped from the cluster-discovery input). `reduceOutliers` is meant
to rescue exactly those short-session outliers, so its IDF must be
computed over the **full** session population, not the filtered
discovery set — otherwise rare tokens that only appear in short
sessions get inflated IDF weight and skew the reassignment. Build
`reduceOutliers`'s IDF map from the full pre-filter corpus or pass the
unfiltered tokens through from the caller.

**Projected lift:** 10–20 percentage points of coverage, mostly moving
unlabeled → emergent cluster. Costs ~0.5 s for n=1010. High-value,
low-risk, ~60 LoC in `semanticClassify.ts`.

### 4.2 LLM-assisted topic merging (arXiv:2509.19365)

When two small clusters share 50 %+ of their TF-IDF tokens (e.g. the
historical `~failures + backend + fixing` and `~failures + fixing + backend`
duplicate), fire them at a local LLM call with the prompt "are these the
same topic?" Gemma-3n-E2B (1.5 GB quantized) runs in-browser via `transformers.js`
and would be *huge* download. Probably better implementation: emit a
merge-suggestion JSON and let the user trigger it out-of-band in a Claude
chat ("here are 5 candidate merges, accept/reject"). Not a Phase-1 ship.

### 4.3 LLM-generated topic labels (arXiv:2502.18469)

Today's labels come from either TF-IDF tag-bags (`~commit + git + review`)
or the centroid-title heuristic (e.g. `Setting up OAuth with Google`). The
centroid-title path works surprisingly well in practice per the code comments
— a real chat title often reads better than a keyword bag.

LLM-generated labels would improve the remaining cases where the centroid
member's title is generic ("follow-up", "another question"). Same
out-of-band argument as 4.2: the user already has Claude. Export the
clusters to a prompt file, paste, get back labels. Not an in-browser
ship.

### 4.4 Chunking overhaul (tied to Phase-2 embedder)

If we move to Jina v2-small's 8 K context, the chunking logic becomes
trivial: one chunk per conversation (truncated at 24 K chars), no
max-pool reconciliation. The qualitative payoff is that the embedder
sees the whole arc of a conversation — the pivot from "how do I set up
docker compose" to "now deploy to fly.io" is captured in a single vector
instead of max-pooling into two incoherent ones.

---

## 5. Recommended migration plan

### Phase 1 — ship-ready, ~2 days of focused work

**Files touched:**

- `packages/viewer/src/data/embedWorker.ts` — bump `MODEL_ID` to
  `Xenova/bge-small-en-v1.5`. **Switch `pooling: 'mean'` → `pooling: 'cls'`**
  at the extractor call (line 759 today) to match BGE's training recipe
  — this is the single change that can silently break embedding quality
  if missed. Re-test the q4f16 → fp16 → fp32 → wasm-q8 cascade; BGE's
  ONNX conversions all exist under `onnx/` on HF, so the existing
  ladder should hold. `EMBED_BATCH_SIZE = 32` is MiniLM-tuned; leave
  as-is for Phase 1 but flag as a knob if WebGPU cold-start regresses.
  Rationale for inlining (vs. adding a `POOLING` constant per-model):
  Phase 1 is a single-model cutover — a per-model config table is the
  right shape for the benchmark harness (Phase 2 / F), not for the
  production swap. If we add a second production embedder later, that's
  when the table is justified.
- `packages/viewer/src/data/semanticClassify.ts` — bump the comment-
  metadata `MODEL_ID`, bump `SemanticLabelsBundle.version` to 3, drop
  `DEFAULT_THRESHOLD` 0.40 → 0.38 (educated starting guess — recalibrate
  on first real run). **Keep `DISCOVER_THRESHOLD` at 0.50** (see §3
  rationale — lowering compounds wrong-directionally with
  `reduceOutliers`). Add a `reduceOutliers()` pass (~60 LoC) between
  the emergent-cluster loop and the return statement.
- `packages/viewer/src/data/semanticLabelsStore.ts` — accept
  `version: 3`, reject `version ≤ 2` (silent drop + re-run; already
  the existing behavior shape, just a number bump).
- `packages/viewer/src/ChatArchViewer.tsx` — the in-flight
  `flush()` inside `runSemanticAnalysis` hard-codes
  `modelId: 'Xenova/all-MiniLM-L6-v2'` when writing a streaming-labels
  snapshot. Must be updated in lockstep with `semanticClassify.ts`
  `MODEL_ID` or the snapshot records the wrong model.
- `packages/viewer/src/components/AnalysisLauncher.tsx` — two
  user-visible strings reference the model by name and dim
  ("~30 MB · MiniLM-L6-v2" and "384-dim"). Update the name; the dim
  stays 384 for BGE-small (this pair breaks on any future non-384
  swap — flag it for Phase 2).
- `packages/analysis/src/reduceOutliers.ts` (new, ~60 LoC) — c-TF-IDF
  reassignment pass. Or inlined as a helper in `semanticClassify.ts`;
  placement decision on file creation day.

**Expected result:** classified 60 → 70 %, emergent 5 → 20 %, unlabeled
35 → 10 %. Download cost for **returning users**: ~36 MB fresh (BGE-
small's `model_q4f16.onnx` on HF is 36.2 MB) — the Cache API entry from
MiniLM doesn't apply to a different HF repo, so this is a clean
re-download, not a cheap incremental. First-run users see roughly the
same as today (~28 MB → ~36 MB, +8 MB). Embed wall-clock on 1,010
sessions: same order-of-magnitude as today (same dim, comparable
model-sized ONNX, same dtype); budget a second adversarial-testing
pass after the first real run to confirm.

### Phase 2 — worth the engineering, ~1 week

**Files added:**

- `packages/analysis/src/umapProject.ts` — thin wrapper over `umap-js`
  to produce a 15-dim projection of the session vectors. ~80 LoC.
- Call site in `semanticClassify.ts` discover branch: project vectors
  before calling `discoverClustersAsync`. Raise `DISCOVER_THRESHOLD` to
  0.65. Keep the 384-dim vectors for `classifyChunksOfOne` — projection
  hurts the cross-centroid max-sim.

**Switch embedder to Jina v2-small-en** — requires raising
`MAX_CHARS_PER_CHUNK` and simplifying `conversationToChunks` to emit a
single chunk per conversation. `classifyChunksOfOne` still works (1
chunk == 1 max-pool), no downstream change.

**Expected result:** emergent 20 → 30–40 %, topic coherence up because
UMAP + single-vector-per-conversation both reduce label noise.

### Phase 3 — speculative / optional

- FASTopic port. Only if Phase 2 doesn't hit the target.
- LLM-assisted label polishing. Out-of-band via Claude.

---

## 6. Benchmark harness

To avoid hand-waving, the deliverable also includes an in-browser
harness the user runs on their own corpus to produce the empirical
numbers this memo estimates. See
[research/benchmark-harness-plan.md](research/benchmark-harness-plan.md)
(next artifact) for the design.

The harness outputs one CSV row per (embedder, clusterer, post-proc)
combo:

```
model,cluster,postproc,classified_pct,emergent_pct,unlabeled_pct,
n_topics,mean_cluster_size,runtime_s,download_mb,umass_coherence
```

Plus a 3-cluster human-scan sample per config (prints 10 member titles
per sampled cluster to the activity log for user review).

---

## 7. Risks and gotchas

### Things that will break if done naively

- **Bundle size regressions (Phase 2).** `umap-js` 1.4.0 is ~27 KB gzip
  and `ml-kmeans` 7.0.0 is ~19 KB gzip (bundlephobia). Combined ~46 KB
  gzip. Acceptable. Model payload is a separate concern — see §5 download
  cost notes.
- **Phase-2 progress UX.** `ClassifyProgress.phase` in
  `semanticClassify.ts` is a discriminated union with six named variants
  consumed by `AnalysisLauncher.tsx`. UMAP and k-means each need a new
  variant (e.g. `'projecting'`, `'grouping'`) or they fall through to
  the generic `'ANALYZING'` path and the UI appears to stall during the
  (sync, blocking) UMAP pass. Must ship with Phase 2, not bolted on
  after.
- **UMAP determinism.** `umap-js` uses its own PRNG; seed it explicitly
  (`random: mulberry32(42)` or similar) so the cluster set is stable
  across reloads. Otherwise the UI's "same clusters after reload"
  invariant breaks — the activity-log rehydrate summary trusts this.
- **IDB version bump cascade.** Anyone with a persisted `version: 2`
  bundle will see a silent drop on next visit: `isSemanticLabelsBundle`
  returns false → `loadSemanticLabels()` returns null → the UI logs
  "No persisted semantic labels to restore." and shows the Analyze CTA
  again. No crash, no migration UI. For Phase 1 this is the chosen
  behavior (the bundle is invalidated precisely because the embedder
  changed and the old labels no longer reflect truth). Accept, document,
  move on — do NOT try to migrate in place.
- **Complete-linkage on UMAP output.** Projected vectors are *not*
  unit-length. Either re-normalize after projection or swap the dot-product
  in `completeLinkageClusters` for a proper cosine. The dot-without-norm
  silently biases toward vectors with larger magnitude — common bug.

### Things that will NOT fix this problem

- Lowering τ on MiniLM without changing embedder. The empirical ceiling
  was already explored — τ=0.30 gave 74 % coverage with 60 % agreement,
  which means *a lot* of the extra coverage was wrong (the classifier
  stretches to claim things it shouldn't). The embedder is the bottleneck,
  not the threshold.
- Adding more stopwords to `CLUSTER_STOPWORDS`. Useful when labels look
  ugly, but doesn't produce additional clusters.
- k-Means as a whole-pipeline replacement. Discussed above. Don't.

---

## 8. What I didn't (and can't, from this session) do

- **Run the actual benchmarks.** The 1,010-conversation corpus lives on
  the user's disk, not in the repo. The harness is designed to produce
  the empirical numbers; the memo's projections are literature-anchored
  estimates.
- **Measure true cold-start on the user's hardware.** WebGPU cold-start
  varies 2–3× across drivers (the `q4f16` → `fp32` cascade exists
  because of this). Numbers in §2 are Chrome 147 / RTX 4070 estimates.
- **Validate topic coherence.** UMass coherence requires a reference
  term-frequency distribution — the harness computes it on the user's
  corpus at run time, not from a fixture.

---

## 9. Sources

- [BERTopic Best Practices](https://maartengr.github.io/BERTopic/getting_started/best_practices/best_practices.html)
- de Groot, Aliannejadi & Haas (WiNLP 2022), *Experiments on Generalizability of BERTopic on Multi-Domain Short Text*, arXiv:2212.08459
- Wu et al. (2024), *FASTopic: A Fast, Adaptive, Stable, and Transferable Topic Modeling Paradigm*, arXiv:2405.17978 — NeurIPS 2024
- *LLM-Assisted Topic Reduction for BERTopic on Social Media Data* (2025), arXiv:2509.19365
- *Evaluating BERTopic on Open-Ended Data* (2025), arXiv:2504.14707 — note: this memo previously cited a specific "k-Means 100% coverage at 10–15% coherence cost" number from this paper; that figure was not in the abstract and is not reproduced here
- [EmbeddingGemma launch — Hugging Face blog, Sept 2025](https://huggingface.co/blog/embeddinggemma)
- [MTEB Leaderboard](https://huggingface.co/spaces/mteb/leaderboard)
- HF model repo ONNX file inventory (verified 2026-04-20): `Xenova/all-MiniLM-L6-v2`, `Xenova/bge-small-en-v1.5`, `Snowflake/snowflake-arctic-embed-xs`, `jinaai/jina-embeddings-v2-small-en`
