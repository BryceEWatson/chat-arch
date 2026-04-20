# Benchmark harness — design doc

**Goal.** Let the user run the §6-promised side-by-side evaluation of
(embedder × clusterer × post-processing) combos against their own
1,010-conversation corpus without leaving the browser. Output: a CSV
the user can paste into Sheets for the recommendation memo.

**Non-goal.** Replace the production classifier. The harness is a
diagnostic route, not a feature.

---

## 1. Architecture

One Astro page at `apps/standalone/src/pages/bench.astro` that mounts
a new React component `<BenchmarkRunner>`. **Gating is a frontmatter
`Astro.redirect`:**

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import { BenchmarkRunner } from '@chat-arch/viewer';
if (!import.meta.env.DEV) {
  return Astro.redirect('/');
}
---
<BaseLayout title="Chat Archaeologist — benchmark">
  <main><BenchmarkRunner client:load /></main>
</BaseLayout>
```

An earlier draft proposed the `_bench.astro` underscore-prefix
exclusion (which Astro documents for "don't route this file"). That
form works for prod (no route emitted) but ALSO hides the file from
the dev server, making the harness un-testable without build-tooling
surgery (you'd have to add a dev-only Astro integration or hand-edit
the config). The redirect pattern is the pragmatic compromise:

- In `astro build` the page emits, but the redirect shell is ~500
  bytes — no BenchmarkRunner bundle, no JS island, no access.
- In `astro dev` the redirect short-circuits to `DEV === true` and
  renders the harness at `/bench`.

The tiny prod emission is acceptable. If absolute zero production
surface is required later, the path forward is an Astro integration
that `injectRoute`s conditionally on `dev`.

The runner:

1. Reads the persisted `UploadedCloudData` out of IndexedDB (existing
   `uploadStore.ts`) so no re-upload is needed.
2. Iterates a hard-coded matrix of configs (see §2).
3. For each config: calls `spawnCascadedEmbedClient(modelId, pooling)`
   — a shared helper (see §7) that both `runSemanticAnalysis` and the
   harness use — so a config which needs WebGPU → fp32 → WASM fallback
   gracefully degrades instead of hard-failing.
4. Streams embed + cluster progress to an on-page log.
5. Writes a row to an in-memory results buffer, persisted to a
   dedicated IDB database `chat-arch-bench-results` (separate from
   the production `chat-arch-semantic-labels` — see §9).
6. At the end, triggers a download of `bench-results-<timestamp>.csv`.
7. Logs a **sample block** per config (see §5 for the layout — not a
   single 270-line `<details>`; a config-selector + 10-title grid).

**Total runtime budget:** plan for 30–45 min on WebGPU for a v1 sweep
at 1,010 conversations (previous "15–20 min" underestimate assumed
all configs hit WebGPU q4f16 cleanly; in practice the cascade costs
extra seconds per row and two of the three embedders lack q4f16, so
budget more). On WASM the sweep is 3–5× that. The runner must expose
a per-row SKIP button and a global STOP button — the latter calls
`client.dispose()` between configs to free worker threads cleanly.

---

## 2. Config matrix (v1)

```ts
interface BenchConfig {
  embedder: string;
  /**
   * Which pooling strategy to pass to the feature-extraction pipeline.
   * MUST match the model's training recipe — mismatched pooling
   * produces silently wrong vectors whose cosine distribution is off
   * the model's published MTEB numbers. There is no sane default to
   * fall back to per modelId — mean-pool on a CLS-trained model is
   * the exact bug Phase 1 just escaped. Required, no default.
   */
  pooling: 'cls' | 'mean';
  cluster: ClusterKind;
  postproc: PostprocKind;
}

const MATRIX: BenchConfig[] = [
  // --- embedder sweep, fixed clusterer/postproc ---
  // Pooling value verified against each model's 1_Pooling/config.json
  // on HF on plan-revision day; re-verify if adding a new row.
  { embedder: 'Xenova/all-MiniLM-L6-v2',             pooling: 'mean', cluster: 'complete-linkage', postproc: 'none' },
  { embedder: 'Xenova/bge-small-en-v1.5',            pooling: 'cls',  cluster: 'complete-linkage', postproc: 'none' },
  // Snowflake/snowflake-arctic-embed-xs uses CLS pooling per the
  // sentence-transformers config on HF (pooling_mode_cls_token=true).
  // If verifying afresh turns up a different pooling, drop the row
  // rather than guess — same rule as Jina below.
  { embedder: 'Snowflake/snowflake-arctic-embed-xs', pooling: 'cls',  cluster: 'complete-linkage', postproc: 'none' },
  // Jina v2-small is excluded from v1: upstream HF repo ships no onnx/
  // subfolder, so transformers.js 3.x can't load a quantized variant.
  // Add back once a Xenova/jina-embeddings-v2-small-en mirror ships
  // AND its pooling is verified (Jina's v2 family uses mean pooling
  // per the model card, but re-check before committing).

  // --- clusterer sweep, fixed embedder (whichever won embedder sweep) ---
  // `<winner>` is substituted with the embedder + pooling pair — both
  // carry over from the winning row, not just the modelId.
  { embedder: '<winner>', pooling: '<winner-pool>', cluster: 'complete-linkage',       postproc: 'none' },
  { embedder: '<winner>', pooling: '<winner-pool>', cluster: 'umap+complete-linkage',  postproc: 'none' },
  { embedder: '<winner>', pooling: '<winner-pool>', cluster: 'umap+kmeans',            postproc: 'none' },

  // --- postproc sweep, fixed embedder+clusterer ---
  { embedder: '<winner>', pooling: '<winner-pool>', cluster: 'umap+complete-linkage', postproc: 'none' },
  { embedder: '<winner>', pooling: '<winner-pool>', cluster: 'umap+complete-linkage', postproc: 'reduce-outliers' },
  { embedder: '<winner>', pooling: '<winner-pool>', cluster: 'umap+complete-linkage', postproc: 'reduce-outliers+centroid-title' },
];
```

The `<winner>` entries are filled in manually between the embedder
sweep and the clusterer sweep — the user kicks off round 2 after
eyeballing round 1. This keeps the total runtime sane and gives the
user a decision point.

**Post-Jina note.** With Jina v2-small excluded from v1 (no
transformers.js-compatible ONNX layout upstream, per §6 blocker), the
embedder sweep shrinks to three candidates. This makes "one winner"
thinner than originally framed; consider running the clusterer sweep
on the **top two** embedders instead of the single winner (6 rows
instead of 3). The extra ~10–15 min of runtime is cheap insurance
against picking the wrong winner from a three-way tie.

---

## 3. Metrics computed per config

| Column                 | Definition                                                                 |
|------------------------|----------------------------------------------------------------------------|
| `classified_pct`       | % sessions with a projectId that matches a real project in `projects.json` |
| `emergent_pct`         | % sessions with a projectId starting with `~`                              |
| `unlabeled_pct`        | % sessions with `projectId === null`                                       |
| `n_topics`             | Count of distinct projectId values (including `~…` labels)                 |
| `mean_cluster_size`    | Mean size of `~…` clusters                                                 |
| `median_cluster_size`  | Median size of `~…` clusters                                               |
| `largest_cluster`      | Size of the biggest `~…` cluster (sanity-check against run-away chaining)  |
| `download_s`           | Wall-clock from `worker spawn` to `worker ready` — model-download time, ~0 on warm cache |
| `embed_runtime_s`      | Wall-clock from `worker ready` to final vector — the actual embed work, independent of download |
| `cluster_runtime_s`    | Wall-clock time for the clusterer                                          |
| `postproc_runtime_s`   | Wall-clock time for the post-processing pass (may be 0)                    |
| `download_mb`          | Reported model size (first run only; subsequent runs = 0)                  |
| `device`               | `webgpu` / `wasm` (which runtime the pipeline landed on)                   |
| `dtype`                | `q4f16` / `fp16` / `fp32` / `q8` (which dtype actually loaded)             |
| `cascade_steps`        | How many respawn attempts the cascade took to succeed (0 = first try)      |
| `umass_coherence`      | Topic coherence — see §4                                                   |

### Why these columns

- **Three % columns must sum to 100.** Cheap sanity check — if not, the
  row is broken.
- **n_topics + mean_cluster_size** are the shape check. A run with 200
  topics and mean cluster size 2 is over-fragmented; a run with 5
  topics and mean size 200 is over-merged.
- **largest_cluster** catches single-linkage-style chaining (a bug we
  already saw on this corpus — 65 % of the corpus collapsed into one
  cluster at τ=0.4 with single-linkage).
- **runtime decomposition** shows which stage is the bottleneck — matters
  for the Phase-3 FASTopic discussion (is the merge loop really the
  hot path, or is it the embed?).

### Pre-warm to make embed_runtime_s comparable

The Cache API persists model weights across configs within a session.
Running MiniLM first (row 1) leaves its weights cached; a later row
that reuses the winner model pays zero download when it spawns. But
the first MiniLM row pays the full ~28 MB download before its timer
starts, while a later BGE-small row (row 2) pays ~36 MB fresh, and
Snowflake (row 3) pays whatever its q8 size is.

To make `embed_runtime_s` strictly comparable, the runner performs a
**pre-warm pass** before the timed sweep: for each distinct embedder
in the matrix, spawn a worker, call `client.ready()`, then dispose
it. This forces the model into the Cache API so every subsequent
timed run sees a warm download. The pre-warm itself is timed into
the per-config `download_s` column (first row of the sweep records
the real download time; subsequent rows that reuse the same model
record `download_s ≈ 0`). That way:

- `download_s` accurately answers "how much did this model cost to
  first-download?" (reported once per unique modelId).
- `embed_runtime_s` answers "given a warm model, how fast does it
  embed 1010 sessions on this hardware?" — the thing the user
  actually cares about for a winner-picking decision.

Skipping the pre-warm isn't catastrophic but makes the runtime
columns harder to read across cold/warm runs.

---

## 4. Topic coherence — UMass

Used by BERTopic's FAQ as the canonical single-number quality metric.
Formula:

```
UMass(topic) = sum_{i<j} log[(D(w_i, w_j) + 1) / D(w_i)]
```

where `D(w)` is document frequency of token `w` in the corpus and
`D(w_i, w_j)` is co-document frequency. Top-N=10 per topic, averaged
across topics.

**Implementation:** ~40 LoC in `packages/analysis/src/coherence.ts`.
Input: cluster-to-tokens map (we already have this from
`CLUSTER_STOPWORDS`-filtered tokens per cluster input), and the
per-token `df` map (already computed in `discoverClusters` for
TF-IDF scoring — can return it as part of the output).

Higher = better. Typical range on short text: -2 to -20 (yes, negative —
it's a log ratio, not a probability). Deltas of 1+ between configs
are meaningful; 0.3 is noise.

**Caveat:** UMass on ~50-token short titles is a very rough signal.
The human-scan sample block (§5) is the more trustworthy quality
check on this corpus.

---

## 5. Sample block — human-scan

For each config, surface 3 `~…` clusters per config. Do NOT dump all
of them to a single `<details>` panel — with 9 configs × 3 clusters
× 10 titles that's 270 lines and no practical way to compare two
configs side-by-side. Instead:

- Render a **config selector** (segmented control across the top) —
  one chip per completed config row.
- Under the selector, a **three-column grid** (one column per sampled
  cluster) with the cluster's label + size + 10 member titles stacked.
- Picking a different config swaps the columns in place, so the eye
  compares the same spatial positions across configs. This is what
  the user actually cares about: "does ~git + commit + review look
  cleaner under BGE than under MiniLM?"

Cluster selection within a config: the 3 largest, OR a random sample
seeded by `hash(config)` (same configs on rerun show the same
samples — lets the user A/B themselves without remembering "was I
looking at cluster 7 or cluster 12 last time?").

The spatial comparison is the single highest-signal quality metric
and takes ~90 s of user time for the full matrix.

---

## 6. Implementation scope

**New files:**

- `apps/standalone/src/pages/bench.astro` — the page shell. Frontmatter
  `if (!import.meta.env.DEV) return Astro.redirect('/')` gates prod.
- `packages/viewer/src/components/BenchmarkRunner.tsx` — the driver UI.
  Owns the config selector, log pane, sample block, and the stop /
  skip controls.
- `packages/analysis/src/coherence.ts` — UMass coherence. Rebuilds `df`
  internally from the `allSessionTokens` map (same pattern
  `reduceOutliers` uses — `discoverClusters` does not export `df`).
- `packages/analysis/src/umapProject.ts` — UMAP wrapper. Uses
  `umap-js`'s `fitAsync(X, callback)` (async progress, not
  `fit` sync) and passes a seeded `random` function so the
  projection is deterministic across reloads.
- `packages/analysis/src/kmeansCluster.ts` — `ml-kmeans` wrapper that
  conforms to the `DiscoveredCluster[]` output shape (`{id,
  memberIds, labelTerms, label, threshold}` — see
  `packages/analysis/src/discoverClusters.ts`) so the metric pipeline
  is clusterer-agnostic.
- `packages/viewer/src/data/benchResultsStore.ts` — idb-keyval wrapper
  over a **new, dedicated** database `chat-arch-bench-results` so
  the harness never touches the production `chat-arch-semantic-labels`
  DB. Keyed by `${modelId}:${pooling}:${clusterConfig}:${postproc}`.
- `packages/viewer/src/data/spawnCascadedEmbedClient.ts` — extracted
  from the main-thread respawn cascade currently inline in
  `ChatArchViewer.tsx:797-924`. Signature:
  `(modelId, pooling, { onStep, saveDevicePref, readDevicePref }) => Promise<EmbedClient>`.
  Harness passes **both** `saveDevicePref: false` AND
  `readDevicePref: false`. The read side matters as much as the
  write side:
  - `saveDevicePref: false` — don't let a harness run overwrite
    production's `(device, dtype)` memo at
    `chat-arch:embed-device-pref-v1`.
  - `readDevicePref: false` — ignore whatever the user's prior
    production run memoized. The inline cascade at
    `ChatArchViewer.tsx:797` reads the memo and uses it to slice
    q4f16/fp16 off the front of the ladder when the memo's dtype
    is fp32 (or to skip WebGPU entirely when the memo is WASM).
    If the harness inherits that slice, every config starts at the
    memoized rung — not the top — and the `dtype` and
    `cascade_steps` columns report the memo's rung, not the model
    under test's actual capability. Cross-config comparison would
    then be meaningless.

  Production callers (`runSemanticAnalysis`) pass
  `saveDevicePref: true, readDevicePref: true` (today's behavior,
  unchanged).

**Modified files:**

- `packages/viewer/src/data/embedWorker.ts` — take `modelId` AND
  `pooling` via the init message rather than baking them into
  constants. Defaults to `Xenova/bge-small-en-v1.5` + `'cls'` (the
  Phase-1 values) for backward compat with the production caller,
  which doesn't pass them yet.
- `packages/viewer/src/data/embedClient.ts` — forward `modelId` and
  `pooling` in the init payload; expose both on `EmbedInitError` so
  the cascade helper sees which pair was attempted.
- `packages/viewer/src/data/semanticClassify.ts` — accept optional
  `modelId` + `pooling` overrides in `ClassifySessionsOptions` and
  thread them into `client.ready()` / the init payload.
- `packages/viewer/src/ChatArchViewer.tsx` — replace the inline
  respawn ladder with a call to `spawnCascadedEmbedClient` so the
  harness and production share one implementation.

**Dependencies to add:**

- `umap-js` 1.4.0 — MIT. ~102 KB minified, ~27 KB gzipped
  (bundlephobia, verified 2026-04-20). Types bundled (`types:
  dist/index.d.ts` in package.json — no `@types/umap-js` needed).
- `ml-kmeans` 7.0.0 — MIT, mljs org. ~75 KB minified, ~19 KB gzipped
  (bundlephobia, verified 2026-04-20). **No `types` field in
  package.json** — TS build may need a `declare module 'ml-kmeans'`
  shim in `packages/analysis/src/types.d.ts` if the consumer package
  doesn't auto-detect `lib/`'s types. Verify on first build.

Both are pure-JS, no native deps, no WASM. Combined bundle impact ≈ 46 KB
gzipped. Safe to ship for a dev-only page.

**Progress-event extension.** `ClassifyProgress.phase` in
`semanticClassify.ts` is currently a closed union of six string
literals. The harness adds at least two new phases (`'projecting
(umap)'`, `'grouping (kmeans)'`) and optionally a third
(`'computing coherence'`). Two options: (a) widen the union to
include the new strings, or (b) introduce a separate
`BenchmarkProgress` type that the harness uses internally while the
embedded production flow keeps its tight union. (b) is the safer
default — no production-code churn.

**Known blocker for the Jina row.** The upstream
`jinaai/jina-embeddings-v2-small-en` HF repo does NOT ship `onnx/`-layout
variants (only root-level `model.onnx` fp32 at 130 MB). Transformers.js
3.x's dtype loader won't find q4f16/fp16. Either (a) skip the Jina row in
v1, (b) wait for a `Xenova/…` mirror, or (c) point the harness at a
self-hosted converted model. Pick (a) for v1 and add a TODO to revisit.

---

## 7. Estimated effort

- Harness page + runner: 1 day.
- Metrics library (`coherence.ts`, `umapProject.ts`, `kmeansCluster.ts`):
  1 day.
- Cascade extraction + `modelId`/`pooling` plumbing through worker,
  client, semanticClassify: 0.75 day. The cascade extraction is the
  biggest lift — the current ladder is 100+ LoC of main-thread state
  machine inline in `ChatArchViewer.runSemanticAnalysis`, and it
  writes the device-pref memo as a side effect (now guarded behind
  a `saveDevicePref: boolean` flag so the harness doesn't pollute it).
- Testing on the real corpus + writing up results: 0.5 day.

**Total: 3.25 days.** Scope-cut paths if needed:

- Drop UMAP + k-Means from v1 (leaves agglomerative-only sweep).
  Saves the `kmeansCluster.ts` day.
- Drop UMass coherence, rely on human-scan only. Saves half a day.
- Drop the cascade extraction — harness uses a bare client. Saves
  0.5 day but means any config that would need WebGPU → fp32 → WASM
  fallback hard-fails, which on the user's NVIDIA + D3D12 + ORT-1.22
  combo is the exact failure the cascade was built for. Do NOT
  scope-cut this.

---

## 8. Out of scope for v1

- Comparing WebGPU vs WASM cold-start times systematically — the
  cascade ladder already logs this to console on every run, and the
  numbers don't vary per embedder choice.
- Multi-run statistical significance — one run per config is enough
  for a "which is best" decision; the between-config deltas are
  much larger than within-config variance.
- Automated "winner" selection — the metric column isn't rich enough
  to make this decision automatically. The user reads the table + the
  human-scan and decides.

---

## 9. Open questions (resolved)

- **Should the harness persist results to IDB across sessions?** Yes.
  Dedicated `chat-arch-bench-results` database — NOT shared with
  `chat-arch-semantic-labels`. Sharing would clobber the production
  bundle's singleton `KEY='active'` slot and idb-keyval can't add a
  new store to an existing v1 DB without a schema-upgrade dance that
  isn't exposed (see `semanticLabelsStore.ts` docblock). Key:
  `${modelId}:${pooling}:${clusterConfig}:${postproc}`.
- **Should it surface a "reset model cache" button?** Yes — pair it
  with a "reset harness results" button. Both use the Cache API /
  idb-keyval `del` APIs, no-op if absent. Keep these scoped to the
  harness DB + `transformers-cache`; do NOT let them touch
  `chat-arch-semantic-labels` or `chat-arch-uploads`.
- **Ordering of the matrix.** Run the fastest configs first (MiniLM +
  complete-linkage is ~60 s end-to-end) so the user sees early signal
  while the longer configs run.
- **Should the harness restore the production device-pref memo on
  exit?** Yes — pass `saveDevicePref: false` into
  `spawnCascadedEmbedClient` so the harness never writes the memo in
  the first place. Snapshot/restore would be more complex and
  error-prone on forced-reload.

## 10. Non-obvious invariants the implementer must preserve

1. `bench.astro`'s frontmatter redirect is the gating in dev builds.
   Prod emits a ~500-byte redirect shell, not the harness UI. An
   earlier draft proposed the `_bench.astro` underscore-prefix
   exclusion; that works for prod but hides the page from the dev
   server too, making the harness un-testable locally.
2. `ClassifyProgress.phase` in `semanticClassify.ts` is a closed
   string-literal union. The harness uses its own `BenchmarkProgress`
   type; do NOT widen `ClassifyProgress` to accommodate UMAP/kmeans
   phases or production callers get typing surprises.
3. UMap-js's default PRNG is `Math.random`. Pass an explicit
   `random: mulberry32(42)` (or equivalent) or the cluster set varies
   across reloads and the harness samples become non-reproducible.
4. ml-kmeans 7 doesn't declare TS types in `package.json`. Expect the
   first build to fail with "Could not find a declaration file for
   module 'ml-kmeans'" and resolve via a two-line `declare module`
   shim — don't go down a rabbit hole of transpile or resolve config.
5. `POOLING` is now a per-model correctness knob (Phase 1 introduced
   it). Threading `modelId` without threading `pooling` produces
   silently-wrong vectors on any model not trained with CLS pooling.
6. The cascade helper MUST NOT read OR write the device-pref memo on
   behalf of a harness run. Both matter — read pollution collapses
   the cascade to whatever rung the user's prior production run
   landed on (see §6 for the full argument), and write pollution
   overwrites the production memo. Existing inline ladder does both
   unconditionally (`ChatArchViewer.tsx:797, 913-918`); extraction
   needs `saveDevicePref` AND `readDevicePref` flags from day one.
   Production callers keep today's behavior by passing both `true`;
   harness passes both `false`.
7. `BenchConfig` is required-pooling. Do NOT add a
   `derivePoolingFromModelId(id): 'cls' | 'mean'` helper — that was
   exactly the lookup table Phase 1's fresh-eyes reviewer caught us
   needing. The model card / `1_Pooling/config.json` is the source
   of truth; the MATRIX row encodes it explicitly. If a future
   embedder's pooling can't be verified from primary sources, the
   row gets dropped like Jina, not defaulted.
