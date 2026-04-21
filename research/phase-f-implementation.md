# Phase F implementation plan — benchmark harness

**Status.** Derived from the revised `research/benchmark-harness-plan.md`
after three rounds of adversarial re-review. Locked-in concerns
(underscore-prefix page, required `pooling` on `BenchConfig`,
`saveDevicePref`+`readDevicePref` flags on the cascade helper,
dedicated IDB, separate `BenchmarkProgress` type, pre-warm pass) are
addressed inline.

**Goal.** Build the in-browser benchmark harness that runs the
(embedder × clusterer × postproc) sweep described in §2 of the memo
against the user's persisted corpus, producing a CSV download + a
side-by-side human-scan panel. Dev-only; zero production surface area.

**Branch.** Same branch as Phase 1 (`feature/phase-1-bge-reduce-outliers`)
because committing Phase 1 first requires user approval. At final
commit time we'll split cleanly into two commits or ask about shape.

**Non-goals.** Running the actual sweep. The harness is *delivered*
here; the *results* come from the user running it locally.

---

## Touch list

### New files

| File | Approx LoC | Purpose |
|---|---:|---|
| `apps/standalone/src/pages/bench.astro` | 40 | Page shell. Frontmatter `if (!import.meta.env.DEV) return Astro.redirect('/')` hides the runner from production. (Initial plan used `_bench.astro` underscore prefix; that gates prod but also hides from the dev server — untestable.) |
| `packages/viewer/src/components/BenchmarkRunner.tsx` | 400 | Driver UI. Config selector, log pane, sample-block grid, stop/skip buttons, download-CSV, reset-cache buttons. |
| `packages/analysis/src/coherence.ts` | 90 | UMass coherence. Rebuilds `df` from `allSessionTokens` (same pattern as `reduceOutliers`). |
| `packages/analysis/src/coherence.test.ts` | 80 | Boundary cases: empty corpus, singleton cluster, all-same-token cluster, no co-occurrences. |
| `packages/analysis/src/umapProject.ts` | 70 | `umap-js` wrapper. Uses `fitAsync` + seeded PRNG (mulberry32 closure). |
| `packages/analysis/src/kmeansCluster.ts` | 90 | `ml-kmeans` wrapper conforming to `DiscoveredCluster[]` shape. Seeded init. |
| `packages/viewer/src/data/benchResultsStore.ts` | 80 | idb-keyval over dedicated `chat-arch-bench-results` DB. Keyed by `${modelId}:${pooling}:${cluster}:${postproc}`. |
| `packages/viewer/src/data/spawnCascadedEmbedClient.ts` | 150 | Extracted cascade from `ChatArchViewer.tsx:797-924`. Takes `saveDevicePref` + `readDevicePref` options. |
| `packages/analysis/src/types.d.ts` | 5 | `declare module 'ml-kmeans'` shim (first build likely fails without it since ml-kmeans 7.0 has no `types` field). Confirm at build time; if auto-detection from `lib/` works, delete. |

### Modified files

| File | Change |
|---|---|
| `packages/viewer/src/data/embedWorker.ts` | Accept `modelId?: string` and `pooling?: 'cls' \| 'mean'` on `InitMessage`. Read both in `ensurePipeline`. Defaults match Phase 1 values (BGE + CLS) when omitted, so production `runSemanticAnalysis` doesn't need to change unless it wants to customize. |
| `packages/viewer/src/data/embedClient.ts` | Add `modelId?: string` and `pooling?: 'cls' \| 'mean'` to `EmbedClientOptions`; forward in `initPayload`. Add optional `modelId`+`pooling` to `EmbedInitError` for harness row accounting. |
| `packages/viewer/src/data/semanticClassify.ts` | Accept optional `modelId`+`pooling` overrides in `ClassifySessionsOptions` and thread them into the `client` handle. (Production callers pass nothing; harness passes per-config.) |
| `packages/viewer/src/ChatArchViewer.tsx` | Replace the inline cascade at `:797-924` with a call to `spawnCascadedEmbedClient(MODEL_ID, POOLING, {saveDevicePref: true, readDevicePref: true, onStep: log, onSpawn: spawnClient})`. Behavior-preserving. |

### Dependencies

`pnpm add -w -F @chat-arch/analysis umap-js@1.4.0 ml-kmeans@7.0.0`

Verify bundle impact post-install via `pnpm build`.

---

## Implementation order

This is big. Recommended slice order, with each slice shippable independently:

1. **Cascade extraction** (unblocks everything). Pull the inline ladder
   in `ChatArchViewer.tsx:797-924` into `spawnCascadedEmbedClient.ts`;
   update the caller. Tests: existing `ChatArchViewer.test.tsx` covers
   the behavior implicitly — no regressions.

2. **Worker + client + semanticClassify config plumbing.** Add
   `modelId` + `pooling` threading with sane defaults. Tests: existing
   Phase-1 tests still pass with zero-caller changes.

3. **Analysis kernels.** Install deps. Add `umapProject`,
   `kmeansCluster`, `coherence` with unit tests. Tests: 10+ new tests
   across the three files.

4. **`benchResultsStore`.** Write/read/delete/list — minimal surface.
   Tests: 4-5 basic CRUD cases.

5. **`BenchmarkRunner.tsx` + `bench.astro`.** UI glue. No new unit
   tests (it's a dev-only component — the matrix + its outputs are
   the "tests").

Each slice keeps the project shippable. If time gets tight, 1-4 give
us the pieces; 5 is the user-facing deliverable.

---

## Critical invariants (copied from memo §10)

1. `bench.astro` frontmatter redirect is the gating.
2. `ClassifyProgress.phase` stays a closed union. Harness uses its own
   `BenchmarkProgress`.
3. `umapProject` seeds `random: mulberry32(42)` (or a named seed
   constant) so the reduction is deterministic.
4. `ml-kmeans` may need a `declare module` shim.
5. `POOLING` threaded alongside `modelId`.
6. `spawnCascadedEmbedClient` honors BOTH `saveDevicePref: false` AND
   `readDevicePref: false` for harness calls — production keeps both
   true to preserve today's "skip doomed rungs next time" behavior.
7. `BenchConfig.pooling` is required — no `deriveFromModelId` helper.

---

## Test matrix

| Package | New tests | Total target |
|---|---:|---:|
| `@chat-arch/analysis` | coherence (4), umapProject (2), kmeansCluster (3) | 105 → ~114 |
| `@chat-arch/viewer` | benchResultsStore (4), spawnCascadedEmbedClient (3) | 285 → ~292 |

Plus: 0 regressions in existing tests.

---

## Rollback plan

Each slice is independently revertible:

1. Slice 1 (cascade extraction): revert the extracted helper file,
   re-inline the code in `ChatArchViewer.tsx`. ~15 min.
2. Slice 2 (config plumbing): revert the additions to
   `EmbedClientOptions`, `InitMessage`, and `ClassifySessionsOptions`.
   All additions are optional fields — callers that didn't set them
   are unaffected. ~5 min.
3. Slice 3 (analysis kernels): delete files, uninstall deps. No other
   code imports them until slice 5.
4. Slice 4 (benchResultsStore): delete file. No other code imports.
5. Slice 5 (runner + astro page): delete files. Astro auto-detects.

---

## Definition of done

- Tests: 499 + new (~16) = ~515 pass.
- `pnpm lint` clean (0 new warnings).
- `pnpm build` clean for `@chat-arch/analysis` and `@chat-arch/viewer`.
  `apps/standalone` build still fails on pre-existing `clear.ts`; same
  posture as Phase 1.
- Browser smoke test: loading `/bench` in dev renders the runner UI,
  shows the config matrix, and the **Stop** button aborts the loop
  cleanly. No running sweep needed to verify this.
- The production `runSemanticAnalysis` flow still works end-to-end:
  source-level fetch of served files shows the cascade helper in use;
  a dev-trigger of the AnalysisLauncher (if I can rig one) completes
  without regression.

---

## Open calibration question deferred to a real run

- Is `mulberry32(42)` a good enough seed for UMAP determinism across
  user machines, or does it need to be a per-run randomness source
  written into the CSV? First run will tell.
