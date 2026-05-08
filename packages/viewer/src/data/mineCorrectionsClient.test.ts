import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCorrectionRunStatus,
  startMineCorrections,
} from './mineCorrectionsClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/**
 * Build a Response whose body is a stream that emits the given chunks
 * back-to-back, then closes. Each chunk is a string; the test asserts
 * how the NDJSON parser frames lines across chunk boundaries.
 */
function streamingResponse(chunks: readonly string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('startMineCorrections — NDJSON parsing', () => {
  it('yields one event per line, in order', async () => {
    globalThis.fetch = vi.fn(async () =>
      streamingResponse([
        '{"type":"start","command":"x","requestId":"r1","startedAt":1}\n',
        '{"type":"stdout","line":"hello"}\n',
        '{"type":"done","ok":true,"exitCode":0,"durationMs":42,"stdoutTail":"","stderrTail":""}\n',
      ]),
    );
    const events = await collect(startMineCorrections());
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe('start');
    expect(events[1]?.type).toBe('stdout');
    expect(events[2]?.type).toBe('done');
  });

  it('reassembles a JSON object split across chunk boundaries', async () => {
    // Worst case: a single object spans 3 chunks, no newline until the end.
    globalThis.fetch = vi.fn(async () =>
      streamingResponse([
        '{"type":"stdo',
        'ut","line":"split-frame"',
        '}\n',
      ]),
    );
    const events = await collect(startMineCorrections());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'stdout', line: 'split-frame' });
  });

  it('handles back-to-back lines in one chunk and partial trailing fragment', async () => {
    globalThis.fetch = vi.fn(async () =>
      streamingResponse([
        '{"type":"stdout","line":"a"}\n{"type":"stdout","line":"b"}\n{"type":"stdout"',
        ',"line":"c"}\n',
      ]),
    );
    const events = await collect(startMineCorrections());
    expect(events.map((e) => (e.type === 'stdout' ? e.line : null))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('silently skips malformed mid-stream lines instead of throwing', async () => {
    // Mirror reality: the server sometimes interleaves spurious junk
    // (a stray progress line, partial buffer flush). We MUST keep
    // parsing the rest of the stream rather than aborting.
    globalThis.fetch = vi.fn(async () =>
      streamingResponse([
        '{"type":"start","command":"x","requestId":"r","startedAt":1}\n',
        'not-json-at-all\n',
        '{"type":"stdout","line":"survived"}\n',
      ]),
    );
    const events = await collect(startMineCorrections());
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('start');
    expect(events[1]?.type).toBe('stdout');
  });

  it('emits a final tail object even without a trailing newline', async () => {
    // Server is supposed to flush a newline after `done`, but if it
    // doesn't, the parser must still surface the terminal event.
    globalThis.fetch = vi.fn(async () =>
      streamingResponse([
        '{"type":"done","ok":true,"exitCode":0,"durationMs":1,"stdoutTail":"","stderrTail":""}',
      ]),
    );
    const events = await collect(startMineCorrections());
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('done');
  });

  it('throws with the response body when status is non-2xx', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('busy: prior run still in flight', { status: 409 }),
    );
    await expect(collect(startMineCorrections())).rejects.toThrow(
      /status 409/,
    );
  });

  it('throws when the response has no readable body', async () => {
    globalThis.fetch = vi.fn(async () => {
      // Force a body-less response — getter returns null on some test envs.
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'body', { value: null });
      return r;
    });
    await expect(collect(startMineCorrections())).rejects.toThrow(
      /no body/,
    );
  });

  it('posts to the right path with the CSRF header', async () => {
    const fetchSpy = vi.fn(async () =>
      streamingResponse([
        '{"type":"done","ok":true,"exitCode":0,"durationMs":0,"stdoutTail":"","stderrTail":""}\n',
      ]),
    );
    globalThis.fetch = fetchSpy;
    await collect(startMineCorrections({ selection: 'backfill' }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/mine-corrections');
    expect(init?.method).toBe('POST');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Requested-With']).toBe('chat-arch-mine-corrections');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse((init?.body as string) ?? '{}')).toEqual({
      selection: 'backfill',
    });
  });
});

describe('fetchCorrectionRunStatus', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null on 404 (skill hasn’t written the file yet)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 }));
    const status = await fetchCorrectionRunStatus('/data', 'req-1');
    expect(status).toBeNull();
  });

  it('returns null on network failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const status = await fetchCorrectionRunStatus('/data', 'req-1');
    expect(status).toBeNull();
  });

  it('returns null when JSON is malformed', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('not-json', { status: 200 }),
    );
    const status = await fetchCorrectionRunStatus('/data', 'req-1');
    expect(status).toBeNull();
  });

  it('returns the parsed status object on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          requestId: 'req-1',
          status: 'classifying',
          progress: { current: 12, total: 80 },
          updatedAt: 1234,
        }),
        { status: 200 },
      ),
    );
    const status = await fetchCorrectionRunStatus('/data', 'req-1');
    expect(status?.requestId).toBe('req-1');
    expect(status?.status).toBe('classifying');
    expect(status?.progress?.current).toBe(12);
  });

  it('strips trailing slashes from dataDirBaseUrl when building the path', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ requestId: 'r', status: 'starting' }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchSpy;
    await fetchCorrectionRunStatus('/chat-arch-data/', 'req-xyz');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/chat-arch-data/analysis/correction-status-req-xyz.json',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});
