const DEFAULT_BASE_URL = 'http://localhost:11434';
const AVAILABILITY_TIMEOUT_MS = 1000;

function installHint(baseUrl: string): string {
  return `Ollama not reachable at ${baseUrl}. Install: https://ollama.com, then: ollama pull mxbai-embed-large`;
}

export async function isOllamaAvailable(baseUrl: string = DEFAULT_BASE_URL): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbedOneOptions {
  model: string;
  baseUrl?: string;
}

interface OllamaEmbeddingResponse {
  embedding?: unknown;
}

export async function embedOne(text: string, opts: EmbedOneOptions): Promise<Float32Array> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/api/embeddings`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, prompt: text }),
    });
  } catch {
    throw new Error(installHint(baseUrl));
  }

  if (res.status === 404) {
    throw new Error(`Model ${opts.model} not pulled. Run: ollama pull ${opts.model}`);
  }
  if (!res.ok) {
    throw new Error(`Ollama embeddings request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as OllamaEmbeddingResponse;
  if (!Array.isArray(json.embedding)) {
    throw new Error('Ollama response missing "embedding" array');
  }
  const arr = json.embedding as unknown[];
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v !== 'number') {
      throw new Error('Ollama embedding contained non-numeric value');
    }
    out[i] = v;
  }
  return out;
}

export interface EmbedBatchOptions {
  model: string;
  baseUrl?: string;
}

interface OllamaEmbedBatchResponse {
  embeddings?: unknown;
}

/**
 * Embed a batch of texts in a single Ollama `/api/embed` request.
 *
 * Uses the newer batched endpoint (Ollama ≥ 0.2 / 0.3); a 404 here
 * usually means the endpoint is missing on an older install rather
 * than the model being missing — caller can detect that and fall
 * back to per-text `embedOne` requests. The orchestrator in
 * `./index.ts` does exactly that.
 *
 * Why batch at all: Ollama keeps the model loaded in GPU/CPU memory
 * between requests in a batch, so 16 texts in one call is ~3–10×
 * faster than 16 separate calls even at the same concurrency. The
 * per-request HTTP / JSON overhead also collapses.
 */
export async function embedBatch(
  texts: readonly string[],
  opts: EmbedBatchOptions,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/api/embed`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, input: texts }),
    });
  } catch {
    throw new Error(installHint(baseUrl));
  }

  if (res.status === 404) {
    throw new Error(
      `Ollama /api/embed not available (404). Either the model "${opts.model}" is not pulled, or this Ollama is older than 0.2. Caller can retry with embedOne.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Ollama embed batch failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as OllamaEmbedBatchResponse;
  if (!Array.isArray(json.embeddings)) {
    throw new Error('Ollama batch response missing "embeddings" array');
  }
  const outer = json.embeddings as unknown[];
  if (outer.length !== texts.length) {
    throw new Error(
      `Ollama batch response length ${outer.length} does not match input length ${texts.length}`,
    );
  }
  const out: Float32Array[] = new Array(outer.length);
  for (let i = 0; i < outer.length; i++) {
    const row = outer[i];
    if (!Array.isArray(row)) {
      throw new Error(`Ollama batch response item ${i} is not an array`);
    }
    const buf = new Float32Array(row.length);
    for (let j = 0; j < row.length; j++) {
      const v = row[j];
      if (typeof v !== 'number') {
        throw new Error(`Ollama batch embedding ${i} contained non-numeric value`);
      }
      buf[j] = v;
    }
    out[i] = buf;
  }
  return out;
}
