import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isOllamaAvailable, embedOne } from './ollama.js';
import { embed, cosineSimilarity } from './index.js';

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = ORIGINAL_FETCH;
  vi.useRealTimers();
});

describe('isOllamaAvailable', () => {
  it('returns true on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await isOllamaAvailable('http://localhost:11434')).toBe(true);
  });

  it('returns false on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await isOllamaAvailable('http://localhost:11434')).toBe(false);
  });

  it('returns false on non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await isOllamaAvailable('http://localhost:11434')).toBe(false);
  });

  it('returns false when request exceeds 1s timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );
    const start = Date.now();
    const result = await isOllamaAvailable('http://localhost:11434');
    expect(result).toBe(false);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

describe('embedOne', () => {
  it('posts the correct body and parses response.embedding into Float32Array', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ embedding: [0.1, 0.2, 0.3] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await embedOne('hello', {
      model: 'mxbai-embed-large',
      baseUrl: 'http://localhost:11434',
    });

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(3);
    expect(Array.from(result).map((v) => Number(v.toFixed(4)))).toEqual([0.1, 0.2, 0.3]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://localhost:11434/api/embeddings');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string);
    expect(body).toEqual({ model: 'mxbai-embed-large', prompt: 'hello' });
  });

  it('throws clear error on 404 (model not pulled)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(embedOne('hi', { model: 'missing-model' })).rejects.toThrow(
      /Model missing-model not pulled\. Run: ollama pull missing-model/,
    );
  });

  it('throws install hint on connection refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:11434');
      }),
    );
    await expect(embedOne('hi', { model: 'mxbai-embed-large' })).rejects.toThrow(
      /Ollama not reachable.*ollama pull mxbai-embed-large/s,
    );
  });
});

describe('embed (concurrency cap)', () => {
  let inFlight = 0;
  let maxInFlight = 0;

  beforeEach(() => {
    inFlight = 0;
    maxInFlight = 0;
  });

  it('respects the concurrency cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return jsonResponse({ embedding: [1, 0, 0] });
      }),
    );

    const texts = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const results = await embed(texts, { concurrency: 3, model: 'mxbai-embed-large' });

    expect(results).toHaveLength(12);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('returns 0 when either vector has zero norm', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(cosineSimilarity(b, a)).toBe(0);
    expect(cosineSimilarity(a, a)).toBe(0);
  });
});
