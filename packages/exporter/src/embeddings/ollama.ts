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
