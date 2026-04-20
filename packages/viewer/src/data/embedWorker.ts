/// <reference lib="webworker" />
/**
 * Embedding Web Worker.
 *
 * Runs `Xenova/bge-small-en-v1.5` in an isolated worker thread so the model
 * download, WebGPU warm-up, and batched inference never block the main
 * thread. The worker is intentionally minimal — no application state, no
 * classification logic. It takes text arrays in, emits Float32Array vectors
 * out. All classification thresholds + label resolution stay on the main
 * thread where they can be re-run cheaply when the user adjusts `τ`
 * without paying the ~36 MB model download twice.
 *
 * Device + dtype selection:
 *
 *   A worker instance commits to ONE (device, dtype) pair — the `prefer`
 *   and `webgpuDtype` fields in the init message pick them, or the
 *   worker auto-picks "fastest available" when omitted (WebGPU + q4f16
 *   when navigator.gpu + shader-f16, else WebGPU + fp32, else WASM).
 *   If init fails, the worker tags its error reply with both the
 *   attempted device AND attempted dtype so the main thread can pick
 *   the cheapest possible recovery. This is the only way to survive
 *   transformers.js's `wasmInitPromise` singleton caching a rejected
 *   init — an in-worker fallback would just replay the first error.
 *
 *   Approx speeds on 1041 docs: WebGPU q4f16 / fp32 ~15-30s, WASM q8 ~2-3 min.
 *   (Same dim as MiniLM at 384, and comparable ONNX size — order of
 *   magnitude unchanged after the BGE-small swap. Recalibrate post-run
 *   if we see meaningful regression.)
 *
 * Diagnostic findings (2026-04-19, Chrome 147 / NVIDIA RTX 4070 / D3D12):
 *
 *   The opaque heap-pointer abort (e.g. `35752920`) at pipeline-init
 *   time is NOT a generic WebGPU failure. We isolated it via a
 *   minimal CDN-loaded repro at `apps/standalone/public/webgpu-repro.html`:
 *
 *     - Adapter probe (main + worker context): all four powerPreference
 *       strategies return an adapter with shader-f16, requestDevice OK.
 *     - WASM control: ✅ pipeline ready in ~250ms.
 *     - WebGPU + fp32: ✅ pipeline ready in ~180ms.
 *     - WebGPU + q4f16: ❌ aborts with heap pointer at instantiation.
 *
 *   So shader-f16 *availability* doesn't imply ORT-jsep's q4f16 *op*
 *   works on every driver path. The viewer's main-thread respawn
 *   ladder (in ChatArchViewer.runSemanticAnalysis) handles this by
 *   stepping q4f16 → fp32 → wasm rather than q4f16 → wasm directly.
 *
 *   Things ALREADY ruled out — don't re-investigate without new evidence:
 *     - COOP/COEP headers (verified: `crossOriginIsolated === true`,
 *       `SharedArrayBuffer` available — see apps/standalone/src/middleware.ts).
 *     - Self-hosted /ort-wasm/ wiring (md5 matches local node_modules
 *       ORT 1.22.0-dev dist; preflight HEAD returns 200 + application/wasm).
 *     - Adapter probe coverage (4 strategies tried; all succeed when
 *       the GPU is healthy, none of them surface the q4f16 issue
 *       because the abort is downstream of requestDevice).
 *     - Multi-threaded WASM (broken for separate reasons; we ship with
 *       numThreads=1 unconditionally — see comment near `wasmThreads`).
 *     - chrome://flags/#enable-unsafe-webgpu (not required on D3D12-
 *       capable hardware; the user above has it Disabled and WebGPU
 *       fp32 still works fine).
 *
 *   Open follow-up worth investigating if q4f16 keeps biting users:
 *     - Upgrade transformers.js 3.8.1 → 4.x. The 4.0 release (March 2026)
 *       ships a completely rewritten WebGPU runtime in C++ via a new
 *       ORT 1.26-dev. The bundled jsep might handle q4f16 ops on more
 *       drivers. Major version bump — verify the pipeline() option
 *       shape and env config are still compatible before swapping.
 *
 * Model cache:
 *
 *   Transformers.js uses the browser's Cache API by default, which keeps
 *   the weights across tabs + visits. First analysis pays the download
 *   (~36 MB q4f16, ~133 MB fp32, or ~23 MB q8 for WASM with BGE-small-
 *   en-v1.5); subsequent runs are local-only. Each variant is a distinct
 *   cache entry. Note: a pre-existing MiniLM cache entry from earlier
 *   builds does NOT help here — BGE is a separate HF repo, so returning
 *   users pay a fresh download on the upgrade.
 *
 * Message protocol:
 *
 *   → {type:'init', prefer?, webgpuDtype?}
 *                          load model, report progress, reply {type:'ready',device}
 *   → {type:'embed', id, texts}
 *                          embed text array, reply {type:'embedded', id, vectors}
 *   ← {type:'progress', stage, loaded, total}  model-download progress
 *   ← {type:'partial', id, offset, vectors}    streamed batch output
 *   ← {type:'embedded', id, total}             completion marker
 *   ← {type:'error', message, device?, dtype?} fatal error, abort
 */

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

// Anthropic's Privacy Export is content-only, so we never send conversation
// text back to HuggingFace. The *model weights* come from the HF CDN on
// first run and get cached locally — no telemetry, no content upload.
env.allowLocalModels = false;
env.allowRemoteModels = true;

// Force single-threaded WASM. ORT Web's multi-threaded path spawns
// pthread sub-workers from the `.mjs` glue code (Emscripten pthreads
// → `new Worker(import.meta.url, { type: 'module' })`), and those
// nested workers have to satisfy the same COEP + same-origin checks
// as the outer worker. In practice this fails on many deployments:
// the nested Worker can throw at instantiation, and because the
// failure happens inside the WASM runtime's startup code, ORT
// surfaces it as a raw heap pointer ("69987680") instead of a
// readable message. We tried `min(4, hardwareConcurrency)` in an
// earlier iteration and it broke the WASM fallback on a fresh run
// where the sync path had worked before. Sticking with 1 for
// reliability; the real speedup lever is WebGPU (5-15×) which is
// tried first in `ensurePipeline` anyway.
//
// The `as any` cast is because the env type tree has a 30-way union
// over backends that TS 5.6 can't keep straight at access time; this
// property exists and is documented, we just skip the overload dance.
/* eslint-disable @typescript-eslint/no-explicit-any */
const wasmThreads = 1;
(env as any).backends.onnx.wasm.numThreads = wasmThreads;

// Point ORT at a same-origin location for its WASM binaries. Default
// Transformers.js behavior is to fetch them from cdn.jsdelivr.net
// (`https://cdn.jsdelivr.net/npm/@huggingface/transformers@.../dist/`),
// which has two practical problems:
//
//   1. Ad/content blockers and privacy extensions regularly intercept
//      the jsdelivr domain and serve a blank / 204 response. ORT then
//      gets an empty buffer from `WebAssembly.instantiateStreaming` and
//      aborts at module instantiation with an opaque heap-pointer
//      error (the `69491688` symptom users actually hit).
//   2. `Cross-Origin-Embedder-Policy: credentialless` is supposed to
//      allow cross-origin no-credentials fetches, but some CDN
//      configurations + browser versions still get rejected at the
//      fetch layer.
//
// Same-origin sidesteps both. The standalone app copies the wasm+mjs
// files into `public/ort-wasm/` during build; the worker reads them
// from there. Consumers who embed `@chat-arch/viewer` into their own
// app need to make sure the equivalent path is served from their
// static host (mirror our structure or set the `wasmPaths` env var
// via a pre-load hook).
//
// Use the explicit `{ mjs, wasm }` object form (new in ORT 1.22) rather
// than the string-base-URL form. The object form disambiguates which
// file ORT fetches for the JS glue vs. the binary, and it's what ORT's
// internal path-resolution prefers when both are present — avoiding a
// subtle bug where the string form only sets the `.wasm` path and the
// `.mjs` import still falls through to `import.meta.url`-relative
// resolution (which in a Vite-bundled worker resolves to the Vite
// chunk URL, not our self-hosted path).
let resolvedWasmPaths: string | null = null;
try {
  const self_ = self as unknown as { location?: { origin?: string } };
  const origin = self_.location?.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    const base = `${origin}/ort-wasm/`;
    (env as any).backends.onnx.wasm.wasmPaths = {
      mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`,
      wasm: `${base}ort-wasm-simd-threaded.jsep.wasm`,
    };
    resolvedWasmPaths = base;
  }
} catch {
  // fall back to the default jsdelivr path if `self.location` isn't
  // available for some reason (very old worker runtimes). Won't break
  // the common case.
}

// Belt-and-braces: disable the WASM proxy worker. Transformers' onnx.js
// already does this (proxy=false) but it lives in module-init code and
// could be undone by future transformers versions. Explicit here.
(env as any).backends.onnx.wasm.proxy = false;

// Log the final env wiring once, synchronously at worker init, so we
// can confirm in DevTools Console that our overrides landed *before*
// any ORT session-create or pipeline() call tries to resolve paths.
// If this log is missing from a debugging session, the worker didn't
// boot — the error is upstream of here. If the log is present but
// `wasmPaths` looks wrong (e.g. still the jsdelivr string), then
// transformers overrode us after our assignment, which would be the
// bug to investigate next.
// eslint-disable-next-line no-console
console.log('chat-arch embed-worker: ORT env wired', {
  wasmPaths: (env as any).backends.onnx.wasm.wasmPaths,
  numThreads: (env as any).backends.onnx.wasm.numThreads,
  proxy: (env as any).backends.onnx.wasm.proxy,
  transformersVersion: (env as { version?: string }).version,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Default production model + pooling. Callers (main-thread or
 * benchmark harness) can override both per-init via the `modelId` +
 * `pooling` fields on InitMessage. The defaults match the production
 * Phase-1 cutover (BGE-small-en-v1.5 with CLS pooling).
 *
 * Pooling is a per-model correctness knob. Different sentence-embedding
 * models are trained with different pooling; using the wrong one
 * produces silently-degraded vectors whose cosine distribution no
 * longer matches the model's published benchmarks.
 *
 *   - `all-MiniLM-L6-v2` → mean pooling (pooling_mode_mean_tokens=true)
 *   - `bge-small-en-v1.5` → CLS pooling (pooling_mode_cls_token=true)
 *   - `snowflake-arctic-embed-xs` → CLS pooling
 *
 * No safe default-from-modelId heuristic exists — the harness passes
 * the pair explicitly per matrix row; if you add a model, verify its
 * 1_Pooling/config.json on HF before threading it through.
 */
const DEFAULT_MODEL_ID = 'Xenova/bge-small-en-v1.5';
const DEFAULT_POOLING: 'cls' | 'mean' = 'cls';

const EMBED_BATCH_SIZE = 32;

interface InitMessage {
  type: 'init';
  /**
   * Which execution backend to attempt. `undefined` (the default on a
   * fresh worker) means "try the fastest available" — currently WebGPU
   * when navigator.gpu is present. When the main thread needs to retry
   * after a WebGPU init failure it respawns this worker and passes
   * `'wasm'` to skip the WebGPU path (transformers.js caches the
   * first session's rejected Promise and a second attempt within the
   * same worker can never succeed — see `ensurePipeline`).
   */
  prefer?: 'webgpu' | 'wasm';
  /**
   * Override the WebGPU dtype auto-pick. When omitted (default), the
   * worker chooses `q4f16` if the adapter exposes shader-f16 and `fp32`
   * otherwise. When set, the explicit value is used unconditionally.
   *
   * Shipped specifically to recover from a NVIDIA + D3D12 + ORT 1.22-dev
   * combination where the q4f16 path aborts at pipeline-init with an
   * opaque heap-pointer error, even though the adapter advertises
   * shader-f16. The viewer's main-thread respawn ladder uses this to
   * try `fp32` after a `q4f16` failure before falling all the way back
   * to WASM. fp32 model is ~3× larger (86 MB vs 28 MB) but cached after
   * first download; WebGPU still ~5-10× faster than single-threaded WASM.
   * Has no effect when prefer === 'wasm'.
   */
  webgpuDtype?: 'q4f16' | 'fp16' | 'fp32';
  /**
   * Which HF model to load. Defaults to `Xenova/bge-small-en-v1.5`
   * (production Phase-1 cutover). The benchmark harness overrides per
   * matrix row so it can compare embedders without rebuilding the
   * worker. Any model passed here must publish ONNX weights under
   * the transformers.js-expected `onnx/` layout on HF; there is no
   * hub allowlist, but a model with the wrong layout will fail in
   * `pipelineFn` at init time rather than silently work.
   */
  modelId?: string;
  /**
   * Which pooling strategy to pass to the feature-extraction
   * pipeline. Defaults to `'cls'` (matches the default
   * `bge-small-en-v1.5`). CRITICAL: this value MUST match the
   * model's training recipe — mismatched pooling produces silently
   * wrong vectors on any model trained with a different strategy,
   * and there is no safe default for a caller-chosen modelId. The
   * benchmark harness passes both fields together per config row.
   */
  pooling?: 'cls' | 'mean';
}

interface EmbedMessage {
  type: 'embed';
  /** Request id echoed on the response so the main thread can correlate. */
  id: string;
  texts: readonly string[];
}

type InboundMessage = InitMessage | EmbedMessage;

interface ReadyReply {
  type: 'ready';
  /** Which runtime the pipeline actually picked. Surfaced in the UI for honesty. */
  device: 'webgpu' | 'wasm';
  /**
   * Which dtype the pipeline actually used. Lets the main thread
   * memorize the working (device, dtype) tuple in localStorage so a
   * future analysis can skip directly to the known-good combo —
   * avoiding the ~1-2s wasted on the doomed q4f16 attempt for users
   * whose hardware only works with fp16 or fp32. Possible values
   * track the dtype space we use: 'q4f16' / 'fp16' / 'fp32' for
   * WebGPU, 'q8' for WASM.
   */
  dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8';
}
interface ProgressReply {
  type: 'progress';
  /** 'download' while weights stream; 'embed' while batches run. */
  stage: 'download' | 'embed';
  loaded: number;
  total: number;
  /** On embed-stage, the id of the in-flight request; omitted on download. */
  requestId?: string;
}
interface PartialReply {
  type: 'partial';
  /** Request id this batch belongs to. */
  id: string;
  /**
   * Index of the first vector in this batch within the original `texts`
   * array. Client reassembles `[offset, offset+vectors.length)` into its
   * aggregate buffer. Offset + vectors-length is guaranteed not to run
   * past `texts.length`; no overlap between partials for the same id.
   */
  offset: number;
  /**
   * This batch's output vectors, pre-mean-pooled and L2-normalized.
   * Transferred (zero-copy) — the worker releases ownership.
   */
  vectors: Float32Array[];
}
interface EmbeddedReply {
  type: 'embedded';
  id: string;
  /**
   * Total number of vectors produced across all partials for this id.
   * Client uses this to validate it received the full set — any gap
   * means a batch was dropped, which should never happen but is worth
   * guarding against. No vector payload on this message; all vectors
   * were already shipped via `partial` events.
   */
  total: number;
}
interface ErrorReply {
  type: 'error';
  /** Optional correlation id — set when the error is for a specific embed request. */
  id?: string;
  message: string;
  /**
   * When set, the device whose init the worker was attempting at the
   * time of the error. Lets the main thread decide to respawn with a
   * different `prefer` setting (the classic case: WebGPU poisoned
   * transformers' wasmInitPromise, so respawn with `prefer: 'wasm'`).
   * Only populated for init-phase errors, not mid-embed throws.
   */
  device?: 'webgpu' | 'wasm';
  /**
   * The dtype the worker was attempting when init failed. Lets the main
   * thread distinguish "WebGPU q4f16 broken" from "WebGPU fp32 broken"
   * so it can choose between respawning with a different dtype (cheaper)
   * vs. falling all the way back to WASM (last resort). Only populated
   * alongside `device` for init-phase errors. Possible values track the
   * dtype space we actually use: 'q4f16' / 'fp32' for WebGPU, 'q8' for
   * WASM.
   */
  dtype?: 'q4f16' | 'fp16' | 'fp32' | 'q8';
}

type OutboundReply = ReadyReply | ProgressReply | PartialReply | EmbeddedReply | ErrorReply;

// The worker global `self` is a DedicatedWorkerGlobalScope at runtime; cast
// once to avoid repeating the assertion at each postMessage.
const workerSelf = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Last preflight diagnostics for error messages. Populated during the
 * first `ensurePipeline` call when we HEAD-fetch the wasm/mjs files to
 * confirm they're reachable. When ORT then throws its heap-pointer
 * exception we include this context so the user (or bug report) sees
 * whether the files are where they should be.
 */
let preflight: {
  mjsStatus?: number;
  mjsType?: string | null;
  wasmStatus?: number;
  wasmType?: string | null;
  wasmBytes?: string | null;
  error?: string;
} | null = null;

/**
 * Produce a useful error string even when ORT/WASM throws something
 * that stringifies to a raw heap pointer (all digits, no whitespace).
 * Symptom: before this helper, users saw an "ANALYZE FAILED" chip with
 * a tooltip like "69491688" — technically a pointer into the WASM
 * emscripten heap where the real error string lives, but meaningless
 * to anyone reading the UI.
 *
 * Appends runtime diagnostics (SAB availability, cross-origin
 * isolation, WebGPU presence, wasmPaths target, preflight HEAD
 * results) so the persistent error banner gives a user enough
 * information to report a bug or self-diagnose without needing
 * DevTools access.
 */
function formatWorkerError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const pf = preflight
    ? ` pf-mjs=${preflight.mjsStatus ?? '?'}/${preflight.mjsType ?? '?'}` +
      ` pf-wasm=${preflight.wasmStatus ?? '?'}/${preflight.wasmType ?? '?'}` +
      (preflight.wasmBytes ? `/${preflight.wasmBytes}B` : '') +
      (preflight.error ? ` pf-err=${preflight.error}` : '')
    : '';
  // Device tag so "WebGPU init failed" doesn't get mislabeled "WASM
  // init failed". `initAttemptingDevice` is set in ensurePipeline
  // before the pipeline() call that can throw.
  const deviceTag = initAttemptingDevice ? initAttemptingDevice.toUpperCase() : 'Pipeline';
  const diag =
    `[diag: SAB=${typeof SharedArrayBuffer !== 'undefined'}, ` +
    `COI=${(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true}, ` +
    `WebGPU=${typeof navigator !== 'undefined' && typeof (navigator as { gpu?: unknown }).gpu !== 'undefined'}, ` +
    `device=${initAttemptingDevice ?? 'unknown'}, ` +
    `wasmPaths=${resolvedWasmPaths ?? 'default'}${pf}]`;

  if (/^\d+$/.test(raw.trim())) {
    // ORT heap-pointer masquerading as a message. Keep the pointer for
    // developer grep-ability but prepend a human-legible cause tuned
    // to whichever device was being attempted — the likely causes for
    // WebGPU-jsep vs pure-WASM init failures are different.
    if (initAttemptingDevice === 'webgpu') {
      return (
        `WebGPU init failed (ONNX Runtime threw heap pointer ${raw} ` +
        `during JSEP bring-up). Most common causes: (1) the GPU ` +
        `adapter doesn't expose the shader-f16 feature required by ` +
        `q4f16 — we try to detect this before pipeline init but a ` +
        `driver lie can slip through; (2) the adapter returned null ` +
        `inside the worker even though navigator.gpu exists on the ` +
        `main thread; (3) a browser extension or sandbox is blocking ` +
        `the WebGPU context creation. The main thread should have ` +
        `respawned with preferDevice='wasm' — check the activity log. ` +
        diag
      );
    }
    return (
      `WASM init failed (ONNX Runtime threw heap pointer ${raw} instead of ` +
      `a readable message — the underlying WASM module aborted at ` +
      `instantiation). Most common causes: (1) the .wasm file isn't ` +
      `reachable from the wasmPaths above — verify in DevTools Network ` +
      `that the file loads 200; (2) an extension / content blocker is ` +
      `intercepting the fetch; (3) multi-threaded pthread sub-workers ` +
      `failed to spawn (COEP or CSP on the worker URL). ` +
      diag
    );
  }
  return `${deviceTag} init: ${raw} ${diag}`;
}

/**
 * Best-effort HEAD fetch of the wasm+mjs files so we can tell, when ORT
 * later throws an opaque pointer exception, whether the files were
 * reachable at all. Populates module-scoped `preflight` (used by
 * `formatWorkerError`). Never throws — a broken preflight is still
 * useful signal ("no response, probably blocked by extension").
 */
async function runPreflight(base: string): Promise<void> {
  const mjsUrl = `${base}ort-wasm-simd-threaded.jsep.mjs`;
  const wasmUrl = `${base}ort-wasm-simd-threaded.jsep.wasm`;
  try {
    const [m, w] = await Promise.all([
      fetch(mjsUrl, { method: 'HEAD' }),
      fetch(wasmUrl, { method: 'HEAD' }),
    ]);
    preflight = {
      mjsStatus: m.status,
      mjsType: m.headers.get('content-type'),
      wasmStatus: w.status,
      wasmType: w.headers.get('content-type'),
      wasmBytes: w.headers.get('content-length'),
    };
  } catch (e) {
    preflight = { error: e instanceof Error ? e.message : String(e) };
  }
  // eslint-disable-next-line no-console
  console.log('chat-arch embed-worker: ORT wasm preflight', {
    base,
    preflight,
  });
}

let pipelinePromise: Promise<{
  extractor: FeatureExtractionPipeline;
  device: 'webgpu' | 'wasm';
  dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8';
}> | null = null;

/**
 * Device preference for this worker instance, captured from the first
 * `init` message. Subsequent init messages don't change it — if the
 * main thread wants to switch strategies, it must respawn the worker
 * (which is the whole point of the preference flag).
 */
let workerPrefer: 'webgpu' | 'wasm' | undefined;
/**
 * Forced WebGPU dtype, captured from the first `init` message. When
 * set, overrides the auto-pick based on shader-f16 availability. The
 * main thread uses this to retry with `'fp32'` after a `'q4f16'`
 * failure (which transformers can't recover from in-worker due to
 * wasmInitPromise caching).
 */
let workerWebgpuDtype: 'q4f16' | 'fp16' | 'fp32' | undefined;
/**
 * HF modelId captured from the first `init` message, or the default
 * if omitted. Passed to `pipelineFn` when building the pipeline.
 * Once set for a given worker instance it's immutable — a different
 * model requires a fresh worker.
 */
let workerModelId: string = DEFAULT_MODEL_ID;
/**
 * Pooling strategy captured from the first `init` message. Must match
 * the training recipe of `workerModelId` — see the DEFAULT_POOLING
 * docblock above for the "no safe default from modelId" reasoning.
 * Used in `handleEmbed`'s extractor call.
 */
let workerPooling: 'cls' | 'mean' = DEFAULT_POOLING;
/**
 * Which device the pipeline is currently attempting to init. Used by
 * the error handler to tag the outbound error message so the main
 * thread knows whether respawning with a different `prefer` will help.
 */
let initAttemptingDevice: 'webgpu' | 'wasm' | undefined;
/**
 * Which dtype the pipeline is currently attempting to init. Paired with
 * `initAttemptingDevice` on outbound error replies so the main thread
 * can distinguish q4f16-broken from fp32-broken (the practical case is
 * NVIDIA + D3D12 + ORT 1.22-dev where q4f16 aborts but fp32 works).
 */
let initAttemptingDtype: 'q4f16' | 'fp16' | 'fp32' | 'q8' | undefined;

function post(reply: OutboundReply, transfer?: Transferable[]): void {
  // `postMessage` with transferables keeps Float32Array payloads zero-copy.
  // Without this, 1041 × 384 floats × 4 bytes = ~1.6 MB copies per batch.
  if (transfer && transfer.length > 0) {
    workerSelf.postMessage(reply, transfer);
  } else {
    workerSelf.postMessage(reply);
  }
}

/**
 * Lazily initialize the feature-extraction pipeline. On first call, picks
 * the best runtime (WASM first, WebGPU as fallback — see boot-order
 * comment below), starts weights download, streams progress back to the
 * main thread. Resolves to the ready pipeline; all subsequent `embed`
 * calls reuse the same instance.
 */
async function ensurePipeline(): Promise<{
  extractor: FeatureExtractionPipeline;
  device: 'webgpu' | 'wasm';
  dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8';
}> {
  if (pipelinePromise !== null) return pipelinePromise;

  pipelinePromise = (async () => {
    // Upfront feasibility gate: ONNX Runtime Web's WASM backend fails
    // opaquely (throws a raw heap-pointer number) when SharedArrayBuffer
    // is unavailable in this worker context. SAB requires the page to be
    // cross-origin-isolated (COOP + COEP headers). Detect this and throw
    // a legible error immediately rather than paying the ~30MB model
    // download only to fail at ORT session creation.
    //
    // The viewer ships an Astro middleware that sets the necessary
    // headers for its own dev + prod deployments. Static hosts (GitHub
    // Pages, Cloudflare Pages, Netlify) need equivalent headers at the
    // hosting layer. Embedded browser contexts (Electron previews,
    // in-app WebViews that strip SAB for security) simply can't run
    // this feature regardless of headers.
    const hasSAB = typeof SharedArrayBuffer !== 'undefined';
    const coi =
      (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    if (!hasSAB || !coi) {
      throw new Error(
        `Semantic analysis needs a cross-origin-isolated page context ` +
          `(SharedArrayBuffer available) to boot ONNX Runtime Web's WASM ` +
          `backend. This tab reports: crossOriginIsolated=${coi}, ` +
          `SharedArrayBuffer=${hasSAB}. Fix on static hosts: serve with ` +
          `'Cross-Origin-Opener-Policy: same-origin' + ` +
          `'Cross-Origin-Embedder-Policy: credentialless'. Embedded ` +
          `browser contexts (some Electron / WebView environments) strip ` +
          `SAB unconditionally and can't run this feature regardless of ` +
          `headers — use a regular browser tab instead.`,
      );
    }

    // Preflight the self-hosted wasm/mjs so the eventual error (if any)
    // carries useful context. Must run before `pipeline()` — once ORT
    // fails with a heap-pointer the original HTTP state is already gone
    // from the network log in most cases.
    if (resolvedWasmPaths !== null) {
      await runPreflight(resolvedWasmPaths);
    }

    // Feature-detect WebGPU. Present when navigator.gpu exists.
    const hasWebGPU =
      typeof navigator !== 'undefined' &&
      typeof (navigator as { gpu?: unknown }).gpu !== 'undefined';

    const progressCb = (progress: unknown): void => {
      if (progress === null || typeof progress !== 'object') return;
      const p = progress as { status?: string; loaded?: number; total?: number };
      if (p.status !== 'progress') return;
      if (typeof p.loaded !== 'number' || typeof p.total !== 'number') return;
      post({ type: 'progress', stage: 'download', loaded: p.loaded, total: p.total });
    };

    // Transformers.js's pipeline() options param is a 30-way
    // discriminated union that TS 5.6 chokes on ("TS2590: Expression
    // produces a union type that is too complex to represent"). Use
    // `Record<string, unknown>` locally — still type-safe at the
    // post-pipeline call site (the return is cast explicitly) and
    // avoids paying for the overload resolution twice.
    const pipelineFn = pipeline as unknown as (
      task: string,
      modelId: string,
      options: Record<string, unknown>,
    ) => Promise<FeatureExtractionPipeline>;

    // Device selection, driven by `workerPrefer`:
    //
    //   undefined (first-ever attempt): try WebGPU (5-15× faster on
    //     capable hardware). A worker instance only gets ONE attempt
    //     at any device — transformers.js caches the first
    //     `createInferenceSession` in a module-private rejected-
    //     Promise singleton on failure, so a WASM fallback inside the
    //     same worker would just replay the WebGPU error. The main
    //     thread handles failure by respawning a fresh worker with
    //     `prefer: 'wasm'`.
    //
    //   'webgpu': try WebGPU only, throw on failure.
    //   'wasm':   try WASM only, throw on failure. This is the
    //     retry-after-WebGPU-failed path triggered by the main thread.
    //
    // When `undefined` + no WebGPU available (navigator.gpu missing),
    // fall straight to WASM so we don't waste a whole worker instance
    // on a device we know can't work.
    let device: 'webgpu' | 'wasm' =
      workerPrefer === 'wasm'
        ? 'wasm'
        : workerPrefer === 'webgpu'
          ? 'webgpu'
          : hasWebGPU
            ? 'webgpu'
            : 'wasm';

    // -- WebGPU capability probe --
    //
    // Before calling pipeline() with device:'webgpu', directly test
    // that we can actually get a GPU adapter + device in this worker
    // context. Two reasons:
    //
    //   1. `navigator.gpu` being defined doesn't guarantee
    //      `requestAdapter()` returns a usable adapter inside a
    //      DedicatedWorkerGlobalScope. Some browsers expose the API
    //      but return null here (or the adapter's requestDevice fails
    //      silently). Calling pipeline() on that will surface as the
    //      opaque heap-pointer abort we keep debugging.
    //
    //   2. `dtype: 'q4f16'` specifically requires the adapter to
    //      expose `shader-f16`. Older iGPUs and some driver revs
    //      report support for WebGPU without shader-f16; q4f16 then
    //      aborts at instantiation. By probing adapter.features, we
    //      can pick the correct dtype (q4f16 vs fp32) or decline
    //      WebGPU entirely if no adapter at all.
    //
    // Throwing a clean "no-adapter" Error here is strictly better
    // than letting transformers.js fail — because we haven't called
    // createInferenceSession yet, no poisoned wasmInitPromise exists,
    // and the main thread's respawn-to-WASM is a perf optimization
    // rather than a necessary recovery.
    // WebGPU types aren't in the default TypeScript DOM lib (would
    // require @webgpu/types). Structural-type the bits we use inside
    // a locally-scoped interface so we don't have to pull a whole
    // package for a single probe. The runtime surface we touch here
    // is stable cross-browser.
    interface MinGPUAdapter {
      features: ReadonlySet<string>;
      requestDevice: (opts?: { requiredFeatures?: string[] }) => Promise<{ destroy?: () => void }>;
    }
    interface MinGPUAdapterOptions {
      powerPreference?: 'high-performance' | 'low-power';
      forceFallbackAdapter?: boolean;
    }
    interface MinGPU {
      requestAdapter: (opts?: MinGPUAdapterOptions) => Promise<MinGPUAdapter | null>;
    }

    /**
     * Try requestAdapter with a sequence of fallback strategies. Many
     * GPU/driver/OS combos succeed on one strategy but fail on others:
     *
     *   1. high-performance discrete GPU — preferred, fastest.
     *   2. low-power integrated GPU — dual-GPU laptops where the
     *      discrete GPU is power-gated off the worker context, or
     *      where the worker only sees the integrated side.
     *   3. no power preference — let Chrome pick; sometimes avoids
     *      driver paths that fail in either extreme.
     *   4. software fallback adapter — Dawn's SwiftShader-based
     *      software renderer. Slower than a real GPU but always
     *      available and still often faster than single-threaded
     *      WASM on a modest CPU.
     *
     * Return the first adapter that both `requestAdapter` returns
     * non-null for AND can successfully create a device. That second
     * check matters because some adapters happily return from
     * `requestAdapter` but then throw at `requestDevice` — exactly
     * the failure that caused the original heap-pointer error.
     */
    async function probeAdapter(
      gpu: MinGPU,
    ): Promise<{ adapter: MinGPUAdapter; strategy: string } | null> {
      const strategies: { name: string; opts?: MinGPUAdapterOptions }[] = [
        { name: 'high-performance', opts: { powerPreference: 'high-performance' } },
        { name: 'low-power', opts: { powerPreference: 'low-power' } },
        { name: 'default' },
        { name: 'fallback-software', opts: { forceFallbackAdapter: true } },
      ];
      for (const s of strategies) {
        try {
          const adapter = await gpu.requestAdapter(s.opts);
          if (!adapter) continue;
          // Verify the device actually creates — this is where most
          // "adapter returned but jsep aborts" failures manifest.
          const supportsF16Here = adapter.features.has('shader-f16');
          const dev = await adapter.requestDevice(
            supportsF16Here ? { requiredFeatures: ['shader-f16'] } : {},
          );
          dev.destroy?.();
          return { adapter, strategy: s.name };
        } catch (probeErr) {
          // eslint-disable-next-line no-console
          console.warn(`chat-arch embed-worker: WebGPU strategy '${s.name}' failed:`, probeErr);
          continue;
        }
      }
      return null;
    }

    let webgpuDtype: 'q4f16' | 'fp16' | 'fp32' = 'q4f16';
    if (device === 'webgpu') {
      const gpu = (navigator as unknown as { gpu?: MinGPU }).gpu;
      if (!gpu) {
        // eslint-disable-next-line no-console
        console.warn('chat-arch embed-worker: navigator.gpu undefined in worker; using WASM.');
        device = 'wasm';
      } else {
        const probe = await probeAdapter(gpu);
        if (probe === null) {
          // eslint-disable-next-line no-console
          console.warn(
            'chat-arch embed-worker: all WebGPU adapter strategies failed (high-perf, low-power, default, software). Falling back to WASM. ' +
              'If you expected WebGPU to work: enable chrome://flags/#enable-unsafe-webgpu and relaunch Chrome.',
          );
          device = 'wasm';
        } else {
          const supportsF16 = probe.adapter.features.has('shader-f16');
          // Dtype precedence: explicit override from the main thread
          // (set during a fp32-after-q4f16-failed respawn) wins over
          // the auto-pick. When auto-picking, q4f16 requires shader-f16
          // — without the feature, q4f16 aborts at instantiation; fall
          // through to fp32. WITH shader-f16, q4f16 still aborts on at
          // least one combo (NVIDIA + D3D12 + ORT 1.22-dev) — the main
          // thread's respawn ladder handles that by setting
          // `workerWebgpuDtype: 'fp32'` on the second attempt.
          if (workerWebgpuDtype !== undefined) {
            webgpuDtype = workerWebgpuDtype;
          } else {
            webgpuDtype = supportsF16 ? 'q4f16' : 'fp32';
          }
          // eslint-disable-next-line no-console
          console.log('chat-arch embed-worker: WebGPU probe OK', {
            strategy: probe.strategy,
            supportsF16,
            dtype: webgpuDtype,
            dtypeSource: workerWebgpuDtype !== undefined ? 'explicit override' : 'auto-pick',
            features: [...probe.adapter.features],
          });
        }
      }
    }

    initAttemptingDevice = device;
    initAttemptingDtype = device === 'webgpu' ? webgpuDtype : 'q8';

    try {
      const extractor = await pipelineFn('feature-extraction', workerModelId, {
        device,
        dtype: initAttemptingDtype,
        progress_callback: progressCb,
      });
      // eslint-disable-next-line no-console
      console.log(`chat-arch embed-worker: ${device.toUpperCase()} pipeline ready`, {
        hasWebGPU,
        wasmThreads,
        wasmPaths: resolvedWasmPaths,
        ...(device === 'webgpu' ? { dtype: webgpuDtype } : {}),
      });
      // initAttemptingDtype was set right before the throwable
      // pipelineFn() call above, so it reflects exactly what landed.
      return { extractor, device, dtype: initAttemptingDtype as 'q4f16' | 'fp16' | 'fp32' | 'q8' };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `chat-arch embed-worker: ${device.toUpperCase()} init failed. raw:`,
        err,
        'stringified:',
        formatWorkerError(err),
        'preflight:',
        preflight,
      );
      throw err;
    }
  })();

  return pipelinePromise;
}

async function handleEmbed(msg: EmbedMessage): Promise<void> {
  const { extractor } = await ensurePipeline();

  const total = msg.texts.length;
  let done = 0;

  // Stream vectors back per batch (as `partial` messages) so the main
  // thread can start classifying completed sessions while the rest of
  // the corpus is still embedding. We never accumulate the full output
  // array on the worker side — each batch is transferred (zero-copy)
  // the moment it's ready, freeing worker-side memory. The final
  // `embedded` message carries no vectors, just a total-count marker
  // so the client can validate it received the whole run.
  for (let i = 0; i < total; i += EMBED_BATCH_SIZE) {
    const batch = msg.texts.slice(i, i + EMBED_BATCH_SIZE);
    const tensor = await extractor(batch, { pooling: workerPooling, normalize: true });

    // The tensor is [B, D]. Extract per-row Float32Arrays. We `slice` to
    // detach each row into its own buffer so we can transfer it to the
    // main thread without the rest of the batch tagging along.
    const flat = tensor.data as Float32Array;
    const dim = (tensor.dims as readonly number[])[1]!;
    const batchVectors: Float32Array[] = new Array<Float32Array>(batch.length);
    for (let j = 0; j < batch.length; j += 1) {
      const start = j * dim;
      const end = start + dim;
      // Copy via `slice` — the underlying buffer of the tensor is reused
      // by ORT for the next batch, so we can't hold references to it.
      batchVectors[j] = flat.slice(start, end);
    }

    // Ship this batch immediately. Transfer the underlying buffers so
    // the main thread gets ownership with no copy.
    post(
      { type: 'partial', id: msg.id, offset: i, vectors: batchVectors },
      batchVectors.map((v) => v.buffer),
    );

    done += batch.length;
    post({
      type: 'progress',
      stage: 'embed',
      loaded: done,
      total,
      requestId: msg.id,
    });
  }

  // Completion marker. Client resolves the pending Promise when this
  // arrives and validates `total` matches its accumulated partial count.
  post({ type: 'embedded', id: msg.id, total });
}

workerSelf.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  (async () => {
    try {
      if (msg.type === 'init') {
        // Capture preferred device + forced dtype + model + pooling on
        // the FIRST init; subsequent inits (shouldn't happen in
        // practice) are ignored. Must be set before `ensurePipeline`
        // reads them.
        if (workerPrefer === undefined && msg.prefer !== undefined) {
          workerPrefer = msg.prefer;
        }
        if (workerWebgpuDtype === undefined && msg.webgpuDtype !== undefined) {
          workerWebgpuDtype = msg.webgpuDtype;
        }
        if (msg.modelId !== undefined) {
          workerModelId = msg.modelId;
        }
        if (msg.pooling !== undefined) {
          workerPooling = msg.pooling;
        }
        const { device, dtype } = await ensurePipeline();
        post({ type: 'ready', device, dtype });
      } else if (msg.type === 'embed') {
        await handleEmbed(msg);
      }
    } catch (err) {
      const message = formatWorkerError(err);
      // exactOptionalPropertyTypes: must omit optional fields entirely
      // rather than set them to undefined. We tag init-phase errors
      // with the device + dtype attempted so the main thread can pick
      // the cheapest possible respawn — `dtype: 'fp32'` after a q4f16
      // failure beats falling all the way back to WASM. Mid-embed
      // errors don't get the device/dtype tag (the pipeline already
      // reached `ready` so respawning won't help, only retrying the
      // batch will).
      let reply: ErrorReply;
      if (msg.type === 'embed') {
        reply = { type: 'error', id: msg.id, message };
      } else if (initAttemptingDevice !== undefined) {
        const initReply: ErrorReply = {
          type: 'error',
          message,
          device: initAttemptingDevice,
        };
        if (initAttemptingDtype !== undefined) initReply.dtype = initAttemptingDtype;
        reply = initReply;
      } else {
        reply = { type: 'error', message };
      }
      post(reply);
    }
  })();
});
