/**
 * Main-thread client for the embedding Web Worker.
 *
 * Spawns a module worker, correlates embed requests/responses by id, and
 * surfaces progress through a lightweight observer callback. Two reasons
 * this wrapper isn't a generic `Comlink` or similar:
 *
 *   1. The worker's download progress is a distinct lifecycle stage from
 *      per-embed-batch progress — the UI shows different copy for
 *      "Downloading model weights…" vs "Embedding 412 / 1041…", and
 *      hand-rolled messaging keeps that mapping explicit.
 *
 *   2. We want structured-clone-free transfer of Float32Array batches
 *      (see `embedWorker.ts` for the transferables dance). A fully
 *      generic RPC wrapper would copy.
 *
 * Callers get:
 *
 *   const client = createEmbedClient({ onProgress });
 *   await client.ready();
 *   const vectors = await client.embed(['text a', 'text b']);
 *   client.dispose();
 */

import { cosineSimilarityNormalized } from '@chat-arch/analysis';

export type EmbedProgress =
  | { stage: 'download'; loaded: number; total: number }
  | { stage: 'embed'; loaded: number; total: number };

export interface EmbedClientOptions {
  /** Called for every progress event from the worker. */
  onProgress?: (progress: EmbedProgress) => void;
  /**
   * Force the worker to attempt a specific device. When omitted, the
   * worker tries the fastest available (WebGPU when navigator.gpu is
   * present, else WASM). Pass `'wasm'` to skip WebGPU entirely —
   * useful as a respawn-retry after a prior worker failed with
   * `(err as { device?: string }).device === 'webgpu'`, since
   * transformers.js caches init state in a way that makes in-worker
   * fallback impossible.
   */
  preferDevice?: 'webgpu' | 'wasm';
  /**
   * Force the WebGPU dtype, overriding the worker's auto-pick (which
   * chooses `q4f16` whenever the adapter exposes shader-f16). Used by
   * the main-thread respawn ladder to walk q4f16 → fp16 → fp32 in
   * order of decreasing speed / increasing compatibility:
   *
   *   q4f16: 4-bit weights + fp16 math, ~28 MB, fastest. Requires the
   *          adapter to support shader-f16 AND ORT-jsep's q4f16 op
   *          path to actually work on this driver — which fails on
   *          NVIDIA + D3D12 + ORT 1.22-dev despite shader-f16 being
   *          advertised, hence the rest of the ladder.
   *   fp16:  half-precision weights, ~44 MB, ~2× q4f16's per-inference
   *          cost. Doesn't require the shader-f16 *feature* (different
   *          from f16 weights), so often works where q4f16 doesn't.
   *   fp32:  full precision, ~86 MB, ~3× q4f16's per-inference cost.
   *          The compatibility floor — works on every WebGPU stack
   *          that works at all.
   *
   * Has no effect when preferDevice is `'wasm'`. All variants cache
   * across visits via the Cache API; the model-download cost is
   * one-time per dtype per browser profile.
   */
  forceWebgpuDtype?: 'q4f16' | 'fp16' | 'fp32';
  /**
   * Which HF modelId to load in the worker. Defaults to the worker's
   * built-in default (currently `Xenova/bge-small-en-v1.5`). The
   * benchmark harness overrides per config row to sweep embedders.
   * The model repo must publish ONNX weights under the
   * transformers.js-expected `onnx/` layout; a wrong layout fails
   * at pipeline init rather than silently misbehaving.
   */
  modelId?: string;
  /**
   * Pooling strategy forwarded to the feature-extraction pipeline.
   * Defaults to the worker's built-in default (currently `'cls'` for
   * the BGE default). MUST match the model's 1_Pooling training
   * config — mismatched pooling produces silently wrong vectors and
   * there is no safe default-from-modelId heuristic.
   */
  pooling?: 'cls' | 'mean';
}

/**
 * Error thrown from `ready()` when worker init fails. Subclasses Error
 * purely for JS `instanceof` checks; the interesting bits are the
 * `device` and `dtype` properties that describe which combination was
 * attempted. Main-thread callers use them to choose the cheapest
 * possible recovery — `dtype: 'fp32'` after a `'q4f16'` failure beats
 * falling all the way back to WASM.
 */
export class EmbedInitError extends Error {
  /** Device the worker was attempting to initialize when it failed. */
  readonly device?: 'webgpu' | 'wasm';
  /** Dtype the worker was attempting when it failed. */
  readonly dtype?: 'q4f16' | 'fp16' | 'fp32' | 'q8';
  constructor(message: string, device?: 'webgpu' | 'wasm', dtype?: 'q4f16' | 'fp16' | 'fp32' | 'q8') {
    super(message);
    this.name = 'EmbedInitError';
    if (device !== undefined) this.device = device;
    if (dtype !== undefined) this.dtype = dtype;
  }
}

/**
 * Per-embed-call progress — fired for each batch the worker completes.
 * `loaded` is the count of documents vectorized so far, `total` the
 * size of the full `texts` array. Caller should divide for a 0..1
 * fraction suitable for a progress bar.
 */
export interface EmbedCallProgress {
  loaded: number;
  total: number;
}

/**
 * A batch of vectors streamed from the worker mid-embed. `offset` is
 * the index of the first vector in this batch within the original
 * `texts` array, so the caller can route batches to the correct
 * slots without relying on arrival order (batches arrive in order
 * today, but the protocol doesn't require it). Vectors are transferred
 * zero-copy — the caller owns them after the callback returns.
 */
export interface EmbedBatch {
  offset: number;
  vectors: Float32Array[];
}

export interface EmbedCallOptions {
  /**
   * Fires after each batch completes (32 docs at a time by default).
   * Use for live progress UI during long embeds — the 1041-doc corpus
   * is ~33 batches, so without this the UI sits at 0% for 30+ seconds
   * while looking hung.
   */
  onProgress?: (p: EmbedCallProgress) => void;
  /**
   * Fires with the *vectors* themselves for each batch, not just the
   * count. Enables incremental downstream work — e.g. classify each
   * session as soon as its chunks' vectors have all arrived, rather
   * than waiting for the full Promise to resolve.
   *
   * The Promise returned by `embed(…)` still resolves with the
   * complete Float32Array[] at the end, so callers that don't care
   * about streaming stay on their existing code path.
   */
  onBatch?: (batch: EmbedBatch) => void;
}

export interface EmbedClient {
  /** Resolves once the pipeline is ready (model downloaded + warmed up). */
  ready: () => Promise<{ device: 'webgpu' | 'wasm'; dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8' }>;
  /** Embed a batch of texts. Vectors are pre-normalized (L2=1). */
  embed: (texts: readonly string[], options?: EmbedCallOptions) => Promise<Float32Array[]>;
  /** Terminate the worker and cancel any in-flight requests. */
  dispose: () => void;
}

// Module-level counter for correlating embed requests. Workers can
// multiplex requests, so each call needs a unique id the worker echoes
// back on response. Simple monotonic counter is plenty; a request
// lifetime is ~seconds.
let nextRequestId = 0;

/**
 * Cosine similarity between two pre-normalized vectors. Re-exported from
 * the analysis package so callers don't have to reach into two modules
 * for a single concept. See `cosineSimilarityNormalized` in
 * `@chat-arch/analysis` for the caveat about vectors needing L2=1.
 */
export { cosineSimilarityNormalized };

export function createEmbedClient(options: EmbedClientOptions = {}): EmbedClient {
  // Vite resolves this `new URL(..., import.meta.url)` form at build time
  // and turns it into a proper chunk URL. DO NOT replace with a string
  // literal path — Vite will silently ship the worker as plain text.
  //
  // `.js` extension (not `.ts`) is deliberate: the compiled `dist/`
  // output ships a `.js` file, and Vite's dev server resolves `.js`
  // imports to matching `.ts` sources via module-resolution fallback.
  // Using `.ts` here would break the standalone consumer in prod.
  const worker = new Worker(new URL('./embedWorker.js', import.meta.url), {
    type: 'module',
  });

  type ReadyValue = { device: 'webgpu' | 'wasm'; dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8' };
  let readyResolve: ((value: ReadyValue) => void) | null = null;
  let readyReject: ((reason: unknown) => void) | null = null;
  const readyPromise = new Promise<ReadyValue>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  interface PendingRequest {
    resolve: (vectors: Float32Array[]) => void;
    reject: (err: Error) => void;
    onProgress?: (p: EmbedCallProgress) => void;
    onBatch?: (batch: EmbedBatch) => void;
    /**
     * Accumulator filled by each `partial` message. Pre-sized to
     * `texts.length` at request time so ordered-arrival isn't
     * required — we index by `offset`. Whether all slots filled is
     * checked on `embedded` (completion signal).
     */
    accumulator: Float32Array[];
    /** How many vectors we've received so far (sum of partial lengths). */
    received: number;
  }
  const pending = new Map<string, PendingRequest>();
  let disposed = false;

  worker.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as
      | { type: 'ready'; device: 'webgpu' | 'wasm'; dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8' }
      | { type: 'progress'; stage: 'download' | 'embed'; loaded: number; total: number; requestId?: string }
      | { type: 'partial'; id: string; offset: number; vectors: Float32Array[] }
      | { type: 'embedded'; id: string; total: number }
      | { type: 'error'; id?: string; message: string; device?: 'webgpu' | 'wasm'; dtype?: 'q4f16' | 'fp16' | 'fp32' | 'q8' };

    switch (msg.type) {
      case 'ready':
        if (readyResolve) readyResolve({ device: msg.device, dtype: msg.dtype });
        readyResolve = null;
        readyReject = null;
        return;
      case 'progress':
        // Fan out per-request embed progress to the pending entry's
        // callback (if any) before the broadcast callback. Callers that
        // only care about a specific call (e.g. semanticClassify driving
        // a specific phase's fraction) get correlated updates; the
        // client-level callback still sees everything.
        if (msg.stage === 'embed' && typeof msg.requestId === 'string') {
          const p = pending.get(msg.requestId);
          p?.onProgress?.({ loaded: msg.loaded, total: msg.total });
        }
        options.onProgress?.({ stage: msg.stage, loaded: msg.loaded, total: msg.total });
        return;
      case 'partial': {
        const p = pending.get(msg.id);
        if (!p) {
          // A partial for an id we've already resolved (or never
          // knew about). In normal operation this is impossible —
          // the worker sends all partials before `embedded`. Warn
          // rather than silently drop: a repeatable occurrence of
          // this warning is the canary for a protocol bug (drift
          // between `handleEmbed`'s emit order and the client's
          // assumption about message ordering).
          // eslint-disable-next-line no-console
          console.warn(
            `chat-arch embed-client: received 'partial' for unknown/closed request id=${msg.id} — protocol drift?`,
          );
          return;
        }
        // Place each incoming vector at the absolute index the worker
        // assigned. We don't rely on arrival order, though in practice
        // the worker walks batches in forward order.
        for (let k = 0; k < msg.vectors.length; k += 1) {
          const v = msg.vectors[k] as Float32Array;
          const idx = msg.offset + k;
          // Defensive: if a partial somehow overlaps a prior one,
          // overwrite rather than double-count `received`. Shouldn't
          // happen with current worker logic.
          if (p.accumulator[idx] === undefined) p.received += 1;
          p.accumulator[idx] = v;
        }
        // Streaming consumer hook. Fires AFTER the accumulator is
        // updated so the callback can safely re-read the slice if it
        // wants to (not just the immediate `msg.vectors`). We MUST
        // catch exceptions here: a throw from user code would bubble
        // out of the message-handler into the browser's event loop
        // with no connection back to our pending Promise, which
        // would then deadlock waiting for a resolve/reject that never
        // comes. Convert any throw into a reject so the embed call
        // fails loudly.
        if (p.onBatch) {
          try {
            p.onBatch({ offset: msg.offset, vectors: msg.vectors });
          } catch (callbackErr) {
            pending.delete(msg.id);
            const e = callbackErr instanceof Error ? callbackErr : new Error(String(callbackErr));
            p.reject(e);
            return;
          }
        }
        return;
      }
      case 'embedded': {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        // Paranoia: the worker promises `msg.total` vectors; if the
        // accumulator is short, reject rather than resolve with holes.
        // A hole would surface as a cosine-with-undefined later and
        // corrupt classification silently — much worse than a visible
        // error.
        if (p.received !== msg.total || p.accumulator.length !== msg.total) {
          p.reject(
            new Error(
              `embed client: partial accounting mismatch — ` +
                `got ${p.received} of ${msg.total} expected`,
            ),
          );
          return;
        }
        p.resolve(p.accumulator);
        return;
      }
      case 'error': {
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            p.reject(new Error(msg.message));
            return;
          }
        }
        // Unattributed error — either the init step failed or something
        // blew up outside a request. Use EmbedInitError when the worker
        // tagged the attempted device so the main thread can decide
        // whether a respawn with a different preference will help.
        // Pass `dtype` through too so the caller can distinguish e.g.
        // q4f16-broken from fp32-broken (the practical case is NVIDIA
        // + D3D12 + ORT 1.22-dev, where q4f16 aborts but fp32 works —
        // far cheaper to retry fp32 than fall back to WASM).
        if (readyReject) {
          const initErr =
            msg.device !== undefined
              ? new EmbedInitError(msg.message, msg.device, msg.dtype)
              : new Error(msg.message);
          readyReject(initErr);
          readyResolve = null;
          readyReject = null;
        }
        return;
      }
      default:
        return;
    }
  });

  worker.addEventListener('error', (event) => {
    const err = new Error(event.message || 'embed worker crashed');
    if (readyReject) {
      readyReject(err);
      readyResolve = null;
      readyReject = null;
    }
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  // Kick off initialization immediately — callers who await `ready()`
  // will see progress events along the way. `preferDevice` (when set)
  // forces the worker to attempt exactly that backend; omitted means
  // "try the fastest available". `forceWebgpuDtype` (when set) skips
  // the worker's auto-pick from shader-f16 — this is how the fp32
  // recovery after a q4f16 failure works (the auto-pick would re-pick
  // q4f16 since shader-f16 is still advertised).
  const initPayload: {
    type: 'init';
    prefer?: 'webgpu' | 'wasm';
    webgpuDtype?: 'q4f16' | 'fp16' | 'fp32';
    modelId?: string;
    pooling?: 'cls' | 'mean';
  } = { type: 'init' };
  if (options.preferDevice !== undefined) initPayload.prefer = options.preferDevice;
  if (options.forceWebgpuDtype !== undefined) initPayload.webgpuDtype = options.forceWebgpuDtype;
  if (options.modelId !== undefined) initPayload.modelId = options.modelId;
  if (options.pooling !== undefined) initPayload.pooling = options.pooling;
  worker.postMessage(initPayload);

  return {
    ready: () => readyPromise,
    embed: (
      texts: readonly string[],
      callOptions?: EmbedCallOptions,
    ): Promise<Float32Array[]> => {
      if (disposed) return Promise.reject(new Error('embed client disposed'));
      const id = `req-${nextRequestId++}`;
      return new Promise<Float32Array[]>((resolve, reject) => {
        // Pre-size the accumulator to the full texts.length — partial
        // messages will fill slots by `offset`. `exactOptionalPropertyTypes`
        // forbids writing `onProgress: undefined`, so we build the entry
        // conditionally and cast at the end for the Map contract.
        const entry: PendingRequest = {
          resolve,
          reject,
          accumulator: new Array<Float32Array>(texts.length),
          received: 0,
        };
        if (callOptions?.onProgress) entry.onProgress = callOptions.onProgress;
        if (callOptions?.onBatch) entry.onBatch = callOptions.onBatch;
        pending.set(id, entry);
        worker.postMessage({ type: 'embed', id, texts });
      });
    },
    dispose: (): void => {
      disposed = true;
      for (const p of pending.values()) {
        p.reject(new Error('embed client disposed'));
      }
      pending.clear();
      worker.terminate();
    },
  };
}
