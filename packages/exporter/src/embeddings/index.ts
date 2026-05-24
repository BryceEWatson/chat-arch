import { embedBatch, embedOne } from './ollama.js';

export const DEFAULT_EMBEDDING_MODEL = 'mxbai-embed-large';
const DEFAULT_CONCURRENCY = 4;
/**
 * Default texts-per-request when calling Ollama's batched `/api/embed`.
 *
 * 16 is the sweet spot reported by Ollama practitioners — large enough
 * to amortize HTTP + JSON + model-load overhead, small enough that one
 * stalled batch doesn't dominate wall-clock time. For mxbai-embed-large
 * on CPU this puts each batch at ~1–2 s instead of ~16× that for
 * one-at-a-time, which is the change that motivated this code.
 */
const DEFAULT_BATCH_SIZE = 16;

export interface EmbedOptions {
  model?: string;
  baseUrl?: string;
  /** Max in-flight batches at any time. Default 4. */
  concurrency?: number;
  /**
   * Texts per request to Ollama's `/api/embed`. Default 16. Pass `1` to
   * force the legacy `/api/embeddings` single-prompt path (one HTTP
   * call per text); useful when batching is suspected of triggering an
   * Ollama bug or when comparing wall-clock against the old behaviour.
   *
   * If `/api/embed` returns 404 (older Ollama installs), the embedder
   * silently falls back to single-text requests for the rest of the
   * run — no caller change needed.
   */
  batchSize?: number;
}

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const results: Float32Array[] = new Array(texts.length);
  if (texts.length === 0) return results;

  const oneOpts: { model: string; baseUrl?: string } = { model };
  if (opts.baseUrl !== undefined) oneOpts.baseUrl = opts.baseUrl;

  // If the caller asked for batchSize=1 we go straight down the legacy
  // single-text path and preserve the historical concurrency semantics
  // (cap = max in-flight individual embed calls). This is the path the
  // older test suite exercises.
  if (batchSize === 1) {
    let nextIndex = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(concurrency, texts.length);
    for (let w = 0; w < workerCount; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = nextIndex++;
            if (i >= texts.length) return;
            const text = texts[i] as string;
            results[i] = await embedOne(text, oneOpts);
          }
        })(),
      );
    }
    await Promise.all(workers);
    return results;
  }

  // Slice into batches; workers pull off the front of the batch queue.
  // `useBatch` flips to false the first time `/api/embed` 404s so the
  // remaining batches go via embedOne — older Ollama installs work
  // transparently without forcing the caller to set batchSize=1.
  const batchStarts: number[] = [];
  for (let s = 0; s < texts.length; s += batchSize) batchStarts.push(s);

  let useBatch = true;
  let nextBatch = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, batchStarts.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const bi = nextBatch++;
          if (bi >= batchStarts.length) return;
          const start = batchStarts[bi] as number;
          const end = Math.min(start + batchSize, texts.length);
          const slice = texts.slice(start, end);

          if (useBatch) {
            try {
              const vecs = await embedBatch(slice, oneOpts);
              for (let k = 0; k < vecs.length; k++) {
                results[start + k] = vecs[k] as Float32Array;
              }
              continue;
            } catch (err) {
              // Disable batched path for the rest of this run only when
              // the error looks like "endpoint missing" — propagate
              // anything else so a misconfigured baseUrl or genuinely
              // broken model still throws loudly.
              if (
                err instanceof Error &&
                /\/api\/embed not available/i.test(err.message)
              ) {
                useBatch = false;
              } else {
                throw err;
              }
            }
          }
          // Fallback path: per-text embedOne for this slice.
          for (let k = 0; k < slice.length; k++) {
            const text = slice[k] as string;
            results[start + k] = await embedOne(text, oneOpts);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export { isOllamaAvailable, embedOne, embedBatch } from './ollama.js';
export type { EmbedOneOptions, EmbedBatchOptions } from './ollama.js';

export { V2_DEFAULT_EMBEDDING_MODEL } from './model.js';
export { runEmbed, type RunEmbedOptions, type RunEmbedResult } from './embedDriver.js';
export {
  DEFAULT_CHUNK_CHARS,
  buildEmbeddingInput,
  buildEmbeddingInputChunks,
} from './buildEmbeddingInput.js';
