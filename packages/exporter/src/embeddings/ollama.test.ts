import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isOllamaAvailable, embedOne, embedBatch } from './ollama.js';
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

  it('respects the concurrency cap (legacy batchSize=1 path)', async () => {
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
    const results = await embed(texts, {
      concurrency: 3,
      batchSize: 1,
      model: 'mxbai-embed-large',
    });

    expect(results).toHaveLength(12);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });
});

describe('embedBatch', () => {
  it('posts an array via /api/embed and parses embeddings into Float32Arrays', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ embeddings: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await embedBatch(['a', 'b', 'c'], {
      model: 'mxbai-embed-large',
      baseUrl: 'http://localhost:11434',
    });
    expect(result).toHaveLength(3);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(result[0]!).map((v) => Number(v.toFixed(4)))).toEqual([0.1, 0.2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('http://localhost:11434/api/embed');
    const body = JSON.parse(call[1].body as string);
    expect(body).toEqual({ model: 'mxbai-embed-large', input: ['a', 'b', 'c'] });
  });

  it('returns empty for empty input without hitting the network', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await embedBatch([], { model: 'mxbai-embed-large' });
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws if response length does not match input length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ embeddings: [[0.1, 0.2]] })),
    );
    await expect(
      embedBatch(['a', 'b'], { model: 'mxbai-embed-large' }),
    ).rejects.toThrow(/length 1 does not match input length 2/);
  });

  it('throws a fall-back-friendly error on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(
      embedBatch(['a'], { model: 'mxbai-embed-large' }),
    ).rejects.toThrow(/\/api\/embed not available/);
  });
});

describe('embed (batched path)', () => {
  it('uses /api/embed and makes ceil(N/batchSize) calls', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { input: string[] };
      return jsonResponse({
        embeddings: body.input.map(() => [1, 0, 0]),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const texts = Array.from({ length: 17 }, (_, i) => `t${i}`);
    const result = await embed(texts, {
      model: 'mxbai-embed-large',
      batchSize: 8,
      concurrency: 4,
    });

    expect(result).toHaveLength(17);
    // ceil(17/8) = 3 batches.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls as unknown as [string][][]) {
      expect(url).toMatch(/\/api\/embed$/);
    }
  });

  it('falls back to /api/embeddings per-text when batch endpoint returns 404', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/api/embed')) {
        return new Response('not found', { status: 404 });
      }
      const body = JSON.parse(init!.body as string) as { prompt: string };
      expect(body.prompt).toBeDefined();
      return jsonResponse({ embedding: [1, 0, 0] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const texts = Array.from({ length: 5 }, (_, i) => `t${i}`);
    const result = await embed(texts, {
      model: 'mxbai-embed-large',
      batchSize: 8,
      concurrency: 2,
    });

    expect(result).toHaveLength(5);
    // 1 batch attempt that 404s, then 5 per-text fallbacks = 6 fetches.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('propagates non-404 errors from the batch endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );
    await expect(
      embed(['a', 'b'], { model: 'mxbai-embed-large', batchSize: 8 }),
    ).rejects.toThrow(/Ollama embed batch failed: 500/);
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
