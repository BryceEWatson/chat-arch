# Phase 1 implementation plan — BGE-small swap + reduceOutliers

**Status.** Derived from the revised `research/clustering-upgrade.md` after
three rounds of adversarial re-review. Locked-in concerns (pooling swap,
query-prefix caveat, IDF-scope gotcha, discover-threshold direction) are
addressed inline below.

**Goal.** Replace `Xenova/all-MiniLM-L6-v2` with `Xenova/bge-small-en-v1.5`,
add a `reduceOutliers()` post-processing pass, bump the persisted-labels
bundle version from 2 → 3. Same-dim model (384), so the surrounding
pipeline geometry (sim matrix size, vector storage, cosine math) doesn't
change. τ moves for classify only; discover τ stays at 0.50.

**Branch.** `feature/phase-1-bge-reduce-outliers`

**Non-goals.** UMAP. k-means. Jina. Any Phase 2/3 work.

---

## Touch list

| File                                                         | Change                                                                                                                | Risk                                                                        |
|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| `packages/viewer/src/data/embedWorker.ts`                    | Bump `MODEL_ID`. Change `pooling: 'mean'` → `pooling: 'cls'` at the extractor call. Update top-of-file docstring to reference BGE-small + size. | Silent-wrong-data if pooling is missed. Verified by the worker diagnostic `console.log` referencing MODEL_ID. |
| `packages/viewer/src/data/semanticClassify.ts`               | Bump comment-metadata `MODEL_ID`. Drop `DEFAULT_THRESHOLD` 0.40 → 0.38. **Keep `DISCOVER_THRESHOLD` at 0.50.** Add `reduceOutliers()` pass. Change `version: 2` literal type on `SemanticLabelsBundle` → `version: 3` (two object-literal sites at lines 669 / 734 both flip). | Literal-type ripple must be atomic. |
| `packages/viewer/src/data/semanticLabelsStore.ts`            | `isSemanticLabelsBundle`: change `o['version'] !== 2` → `o['version'] !== 3`. Update docstring about v1/v2 to note v3. | Trivial. Existing persisted v2 bundles become "absent" — silent drop, re-run on next Analyze click (accepted per memo §7). |
| `packages/viewer/src/ChatArchViewer.tsx`                     | `flush()` inside `runSemanticAnalysis` hard-codes `modelId: 'Xenova/all-MiniLM-L6-v2'` (line 950 today). Change to BGE. | If missed, in-flight snapshot records the wrong model. |
| `packages/viewer/src/components/AnalysisLauncher.tsx`        | Line 215: `'~30 MB · MiniLM-L6-v2 (Xenova port) · ...'` → `'~36 MB · BGE-small-en-v1.5 (Xenova port) · ...'`. 384-dim lines at 222–228 stay (BGE-small is also 384-dim). | Cosmetic. |
| `packages/analysis/src/reduceOutliers.ts` (new, ~80 LoC)     | c-TF-IDF outlier reassignment. Exported from `packages/analysis/src/index.ts`. IDF built from unfiltered corpus tokens (not `DISCOVER_MIN_TOKEN_COUNT`-filtered). Threshold 0.30. | New module — needs tests. |
| `packages/analysis/src/reduceOutliers.test.ts` (new)         | Boundary cases: empty unlabeled pool, no clusters formed, all unlabeled above threshold, all below, single-cluster corpus. | New tests — must pass. |
| `packages/analysis/src/index.ts`                             | Re-export `reduceOutliers` + its types.                                                                                | Trivial. |

**Deliberately NOT touched in Phase 1:**

- `packages/analysis/src/discoverClusters.ts` — discover τ stays 0.50; no
  algorithm change.
- `packages/analysis/src/classifyByEmbedding.ts` — same API.
- `EMBED_BATCH_SIZE = 32` — MiniLM-tuned but not demonstrably wrong for
  BGE; leave until first real-corpus run signals otherwise.
- `MAX_CHARS_PER_CHUNK = 1800` — both MiniLM and BGE-small have 512-token
  context windows, so the existing rationale still applies verbatim.
- `AnalysisLauncher.tsx` line 228's "~256 tokens each" copy — this was
  already wrong in the MiniLM era (MiniLM's window is 512), unrelated to
  the model swap. Flagged as a separate fix, out-of-scope here.
- Worker/main-thread cascade logic in `ChatArchViewer.tsx:803–907` —
  runtime-detected and model-agnostic; no change needed.
- `semanticClassify.ts` discover branch (`MIN_DISCOVER_INPUTS = 30`,
  `minSize: 4`, `labelStrategy: 'centroid-title'`, `labelTermCount: 3`)
  — all orthogonal to the embedder swap.

---

## Diff sketches

### `embedWorker.ts`

```ts
// line 183
- const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
+ const MODEL_ID = 'Xenova/bge-small-en-v1.5';

// line 759 (inside handleEmbed)
- const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
+ // BGE-small-en-v1.5 was trained with CLS pooling
+ // (1_Pooling/config.json: pooling_mode_cls_token=true). Mean pooling
+ // here would produce vectors at a different geometry than the one
+ // MTEB measures, silently degrading classification.
+ const tensor = await extractor(batch, { pooling: 'cls', normalize: true });
```

Docstring update at file top: bump the "Approx speeds on 1041 docs" line if
numbers are known post-benchmark (leave as-is for now — MiniLM and
BGE-small have comparable ONNX size and same dim, so order-of-magnitude
is unchanged).

Also: the "~28 MB q4f16, ~86 MB fp32, or ~22 MB q8 for WASM" line in the
docstring becomes "~36 MB q4f16, ~133 MB fp32, ~23 MB q8 for WASM" for
BGE per verified HF file sizes.

### `semanticClassify.ts`

```ts
// line 79 (inside SemanticLabelsBundle)
- version: 2;
+ /**
+  * History:
+  *   v1 — first-human-message only, single vector per session
+  *   v2 — allHumanText chunked ≤1800 chars, max-sim across chunks
+  *   v3 — embedder swap to Xenova/bge-small-en-v1.5 with CLS pooling.
+  *        Cosine distribution differs from v2; numbers not comparable,
+  *        so v2 bundles are invalidated.
+  */
+ version: 3;

// line 153
- const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
+ const MODEL_ID = 'Xenova/bge-small-en-v1.5';

// line 154
- const DEFAULT_THRESHOLD = 0.4;
+ // BGE-small's contrastively-trained cosine distribution sits tighter
+ // than MiniLM's — initial lower-bound of 0.38 is an educated starting
+ // point; recalibrate on the first real-corpus run.
+ const DEFAULT_THRESHOLD = 0.38;

// DISCOVER_THRESHOLD unchanged at 0.50 — see clustering-upgrade.md §3
// for why lowering it was wrong-directional.

// lines 669 and 734 (two `return { version: 2, ... }` sites)
- version: 2,
+ version: 3,
```

Add `reduceOutliers` call inside the classify branch, after the emergent-
cluster member-assignment loop (line ~665) and before the `return` at
line 668:

```ts
// Outlier reassignment (c-TF-IDF). Rescues sessions that classify
// abstained on AND discovery filtered out or didn't admit. Uses the
// full (pre-DISCOVER_MIN_TOKEN_COUNT-filter) corpus token set for IDF
// so short-title sessions aren't under-weighted.
const outlierAssignments = reduceOutliers({
  labels,
  allSessionTokens, // full map, built earlier in this function
  clusterTokens,    // per-cluster c-TF-IDF vocabulary
  threshold: 0.3,
});
for (const [sessionId, newLabel] of outlierAssignments) {
  labels.set(sessionId, newLabel);
  options.onLabel?.(sessionId, newLabel);
}
```

The `allSessionTokens` map needs to be built earlier in
`classifyUploadedSessions` (where session tokens are computed for the
discover input — at line ~587), but captured unfiltered (every session
regardless of `DISCOVER_MIN_TOKEN_COUNT`).

### `semanticLabelsStore.ts`

```ts
// line 62
- if (o['version'] !== 2) return false;
+ if (o['version'] !== 3) return false;
```

Docstring lines 54–61 extended with the v3 rationale (embedder swap +
pooling swap both invalidate v2 vectors).

### `ChatArchViewer.tsx`

```ts
// line 950 (inside flush() call)
- modelId: 'Xenova/all-MiniLM-L6-v2',
+ modelId: 'Xenova/bge-small-en-v1.5',
```

### `AnalysisLauncher.tsx`

```ts
// line 215
- '~30 MB · MiniLM-L6-v2 (Xenova port) · cached in the browser after the first run',
+ '~36 MB · BGE-small-en-v1.5 (Xenova port) · cached in the browser after the first run',
```

### `reduceOutliers.ts` (new)

Signature:

```ts
export interface ReduceOutliersOptions {
  /** Current label map — sessions with projectId === null are candidates. */
  readonly labels: ReadonlyMap<string, { projectId: string | null; similarity: number }>;
  /** Full corpus tokens, keyed by sessionId. Unfiltered. Used for IDF. */
  readonly allSessionTokens: ReadonlyMap<string, readonly string[]>;
  /** Per-existing-cluster token bag, keyed by cluster label (including `~` prefix). */
  readonly clusterTokens: ReadonlyMap<string, readonly string[]>;
  /** Cosine threshold for reassignment. Default 0.3. Below → stay unlabeled. */
  readonly threshold?: number;
}

export type ReduceOutliersResult = Map<
  string,
  { projectId: string; similarity: number }
>;

export function reduceOutliers(
  opts: ReduceOutliersOptions,
): ReduceOutliersResult;
```

Algorithm:

1. Compute document frequency `df[tok]` over the full
   `allSessionTokens` population.
2. For each cluster, build a c-TF-IDF vector: `tf[tok] * log(N / df[tok])`.
   L2-normalize.
3. For each session where `labels.get(sid)?.projectId === null`:
   - Build the session's c-TF-IDF vector from `allSessionTokens.get(sid)`.
     Skip if empty (no tokens at all).
   - Cosine-similarity against every cluster's centroid.
   - If the best cluster ≥ `threshold`, emit
     `{ projectId: clusterLabel, similarity: bestSim }`.
4. Return the sparse assignment map.

### `reduceOutliers.test.ts`

Boundary cases:

1. **Empty unlabeled pool** — every session has a projectId already.
   Assert the returned map is empty, no crash.
2. **No clusters formed** — `clusterTokens.size === 0`. Assert empty map
   for all unlabeled sessions.
3. **All unlabeled above threshold** — unlabeled sessions match
   single-cluster c-TF-IDF strongly. Assert all get assigned.
4. **All unlabeled below threshold** — unlabeled sessions' tokens overlap
   nothing. Assert all stay unlabeled.
5. **Session with zero tokens** — `allSessionTokens.get(sid) === []`.
   Assert it stays unlabeled (no zero-vector similarity fabricated).
6. **Single-token session against multi-token cluster** — small-N IDF
   behaves sanely (no divide-by-zero, log(N/df) returns a finite value
   even for df=N).

---

## Test changes

- 285 existing tests must still pass unchanged. Only added-file tests are
  new; no modifications to existing test files are planned.
- New test file: `packages/analysis/src/reduceOutliers.test.ts` — 6
  boundary cases above. Target: +6 tests, all pass.
- Existing tests that might be fragile to inspect:
  - `packages/analysis/src/discoverClusters.test.ts` — discover τ didn't
    move. Should be untouched.
  - `packages/analysis/src/classifyByEmbedding.test.ts` — classify math
    didn't change, threshold is injected at call time.
  - `packages/viewer/src/data/*.test.ts` — none touch the embedder
    directly; the store tests might import `SemanticLabelsBundle` but
    don't construct one with a literal `version: 2` (would fail if they
    did — flag on first `pnpm -w test` run).

### Expected lint / build output

- `pnpm lint` — clean.
- `pnpm build` — clean. The only type-system risk is the `version: 2 | 3`
  literal ripple; by changing the literal to exactly `3` and flipping
  both construction sites in lockstep, TS has a single-narrow-type
  correctness check.
- No new `console.log` / `console.warn` in shipped code. The existing
  worker diagnostic logs (worker-init, probe success) stay unchanged.

---

## Verification plan

1. `pnpm -w test` → 285 pass + 6 new = 291 pass.
2. `pnpm -w lint` → clean.
3. `pnpm build` → clean.
4. Browser preview:
   - `preview_start` on the Astro app.
   - Load the demo fixture (there's one mounted by default at the
     Viewer's empty-state CTA).
   - Trigger Analyze.
   - In the activity log, confirm:
     - a) "Downloading BGE-small-en-v1.5 …" (or equivalent)
     - b) non-zero topic count appears
     - c) no red-state errors
   - `preview_console_logs` — confirm no `Error` / `Warn` entries apart
     from the single worker-init `console.log` line.
5. Purge the IDB label cache (`caches.delete` via `preview_eval` is fine
   — ephemeral). Re-run to confirm the v2 → v3 silent drop path works on
   an already-persisted bundle.

---

## Rollback plan

The rollback surface is intentionally thin:

1. Revert `MODEL_ID` in `embedWorker.ts:183` and `semanticClassify.ts:153`
   back to `'Xenova/all-MiniLM-L6-v2'`.
2. Revert `pooling: 'cls'` → `pooling: 'mean'` in `embedWorker.ts:759`.
3. Revert `DEFAULT_THRESHOLD` 0.38 → 0.40 in `semanticClassify.ts:154`.
4. Flip `SemanticLabelsBundle.version` back to `2` in the type + both
   construction sites. Bundle store's guard flips back to `!== 2`.
5. Revert `flush()` modelId in `ChatArchViewer.tsx:950`.
6. Revert `AnalysisLauncher.tsx:215` copy.
7. Keep `reduceOutliers.ts` or remove — it's independent; keeping it
   behind an unused export doesn't break anything, but for full revert
   delete the file and its re-export from `packages/analysis/src/index.ts`.

Rollback takes ≤ 10 minutes, ~7 mechanical edits, no data migration
(v3 bundles on users' disks get silently dropped by a reverted v2 guard
— same shape as the forward migration).

---

## Definition of done

- 291/291 tests pass.
- Build + lint clean.
- Browser preview shows BGE-small downloading, embedding, classifying,
  discovering, and outlier-reassigning with no errors.
- The activity log shows a non-zero classified count, a non-zero emergent
  count, and a non-zero outlier-reassigned count on the demo fixture.
- `console.log` output on the viewer is limited to the worker-init
  diagnostic and the Chat Archaeologist's existing log lines.
- The v3 bundle persists across a page reload and re-hydrates without
  re-running.
- A pre-existing v2 bundle (simulated via manual IDB write) gets silently
  dropped on load and the UI returns to the Analyze CTA.

---

## Open calibration questions (defer to first real-corpus run)

- Is `DEFAULT_THRESHOLD = 0.38` the right anchor for BGE's CLS-pooled
  cosine distribution? If classified% undershoots 70%, try 0.36. If
  overshoots (too many false positives pulled in), try 0.42.
- Does adding a query prefix (`"Represent this sentence for searching
  relevant passages: "`) to the session side (not the centroid side)
  lift classified%? 20-LoC follow-up if yes.
- Does `reduceOutliers` at τ=0.30 rescue the right ~10–15% of unlabeled,
  or does it bleed into the wrong clusters? The BERTopic Best Practices
  suggests a secondary 0.3 cosine floor; tune up to 0.35 if empirical
  noise is high.

None of these block Phase 1 ship — they are first-real-run calibration
knobs.
