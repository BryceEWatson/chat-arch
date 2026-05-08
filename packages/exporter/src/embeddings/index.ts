import { embedOne } from './ollama.js';

export const DEFAULT_EMBEDDING_MODEL = 'mxbai-embed-large';
const DEFAULT_CONCURRENCY = 4;

export interface EmbedOptions {
  model?: string;
  baseUrl?: string;
  concurrency?: number;
}

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<Float32Array[]> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const results: Float32Array[] = new Array(texts.length);

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
          const oneOpts: { model: string; baseUrl?: string } = { model };
          if (opts.baseUrl !== undefined) oneOpts.baseUrl = opts.baseUrl;
          results[i] = await embedOne(text, oneOpts);
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

export { isOllamaAvailable, embedOne } from './ollama.js';
export type { EmbedOneOptions } from './ollama.js';
