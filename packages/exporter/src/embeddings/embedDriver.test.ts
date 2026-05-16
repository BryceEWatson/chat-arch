import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  EmbeddingMeta,
  SessionManifest,
  SessionSource,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { runEmbed } from './embedDriver.js';

const ORIGINAL_FETCH = globalThis.fetch;

interface MockOptions {
  /** When true, /api/tags returns 200; otherwise it throws. */
  ollamaUp: boolean;
  /** Dimensionality of returned embedding vectors. */
  dim?: number;
}

interface MockHandle {
  embedCallCount: () => number;
  promptsSeen: () => string[];
}

function installFetchMock(opts: MockOptions): MockHandle {
  const dim = opts.dim ?? 768;
  let embedCalls = 0;
  const prompts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/tags')) {
        if (!opts.ollamaUp) throw new Error('ECONNREFUSED');
        return new Response('{}', { status: 200 });
      }
      if (url.endsWith('/api/embeddings')) {
        embedCalls += 1;
        const body = JSON.parse((init?.body as string) ?? '{}') as { prompt?: string };
        prompts.push(body.prompt ?? '');
        // Deterministic non-zero vector keyed off prompt length.
        const arr: number[] = new Array(dim);
        for (let i = 0; i < dim; i += 1) {
          arr[i] = ((body.prompt ?? '').length + i) / 1000;
        }
        return new Response(JSON.stringify({ embedding: arr }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return {
    embedCallCount: () => embedCalls,
    promptsSeen: () => prompts.slice(),
  };
}

function s(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cowork',
    rawSessionId: id,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    durationMs: 1000,
    title: `title-${id}`,
    titleSource: 'fallback',
    preview: `preview ${id}`,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    sourceMtimeMs: 100,
    ...overrides,
  };
}

function manifestOf(sessions: UnifiedSessionEntry[]): SessionManifest {
  const counts: Record<SessionSource, number> = {
    cloud: 0,
    cowork: 0,
    'cli-direct': 0,
    'cli-desktop': 0,
  };
  for (const e of sessions) counts[e.source] += 1;
  return {
    schemaVersion: 4,
    generatedAt: 1_700_000_002_000,
    counts,
    sessions,
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'chat-arch-embed-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  globalThis.fetch = ORIGINAL_FETCH;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('runEmbed', () => {
  it('fails soft when Ollama is unavailable and does not write sidecars', async () => {
    installFetchMock({ ollamaUp: false });
    const m = manifestOf([s('a'), s('b')]);

    const result = await runEmbed({ outDir: tmpRoot, manifest: m });
    expect(result.skippedReason).toBe('ollama-unavailable');
    expect(result.embedded).toBe(0);
    expect(result.reused).toBe(0);
    await expect(
      readFile(path.join(tmpRoot, 'analysis', 'embeddings.meta.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('writes embeddings.bin + embeddings.meta.json for eligible sessions', async () => {
    const handle = installFetchMock({ ollamaUp: true, dim: 4 });
    const m = manifestOf([s('a'), s('b'), s('c')]);

    const result = await runEmbed({ outDir: tmpRoot, manifest: m });
    expect(result.skippedReason).toBeUndefined();
    expect(result.embedded).toBe(3);
    expect(result.reused).toBe(0);
    expect(handle.embedCallCount()).toBe(3);

    const metaPath = path.join(tmpRoot, 'analysis', 'embeddings.meta.json');
    const binPath = path.join(tmpRoot, 'analysis', 'embeddings.bin');
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as EmbeddingMeta;
    expect(meta.version).toBe(1);
    expect(meta.dimensions).toBe(4);
    expect(meta.entries).toHaveLength(3);
    expect(meta.entries.map((e) => e.sessionId)).toEqual(['a', 'b', 'c']);
    // Byte offsets are zero-based, stride = dim * 4 bytes.
    expect(meta.entries.map((e) => e.offset)).toEqual([0, 16, 32]);

    const bin = await readFile(binPath);
    expect(bin.length).toBe(3 * 4 * 4);
  });

  it('skips entries with transcriptStatus pruned and empty buildEmbeddingInput', async () => {
    const handle = installFetchMock({ ollamaUp: true, dim: 4 });
    const m = manifestOf([
      s('keep'),
      s('pruned', { transcriptStatus: 'pruned' }),
      // No signal text — buildEmbeddingInput returns empty, should skip.
      {
        ...s('empty'),
        title: '',
        preview: null,
        userTextSamples: [],
      } as UnifiedSessionEntry,
    ]);

    const result = await runEmbed({ outDir: tmpRoot, manifest: m });
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(2);
    expect(handle.embedCallCount()).toBe(1);
    expect(handle.promptsSeen()[0]).toContain('title-keep');
  });

  it('reuses unchanged vectors on incremental rerun (--only-changed)', async () => {
    const handle1 = installFetchMock({ ollamaUp: true, dim: 4 });
    const m1 = manifestOf([
      s('a', { sourceMtimeMs: 100 }),
      s('b', { sourceMtimeMs: 200 }),
      s('c', { sourceMtimeMs: 300 }),
    ]);
    await runEmbed({ outDir: tmpRoot, manifest: m1, onlyChanged: true });
    expect(handle1.embedCallCount()).toBe(3);

    // Reset the fetch mock so the embed-call counter restarts at 0.
    vi.unstubAllGlobals();
    const handle2 = installFetchMock({ ollamaUp: true, dim: 4 });
    const m2 = manifestOf([
      s('a', { sourceMtimeMs: 100 }), // unchanged → reuse
      s('b', { sourceMtimeMs: 999 }), // changed → re-embed
      s('c', { sourceMtimeMs: 300 }), // unchanged → reuse
    ]);
    const result2 = await runEmbed({ outDir: tmpRoot, manifest: m2, onlyChanged: true });
    expect(result2.embedded).toBe(1);
    expect(result2.reused).toBe(2);
    expect(handle2.embedCallCount()).toBe(1);

    const meta = JSON.parse(
      await readFile(path.join(tmpRoot, 'analysis', 'embeddings.meta.json'), 'utf8'),
    ) as EmbeddingMeta;
    expect(meta.entries.map((e) => e.offset)).toEqual([0, 16, 32]);
    expect(meta.entries.map((e) => e.sourceMtimeMs)).toEqual([100, 999, 300]);
  });

  it('writes empty sidecars and reports no-sessions when no eligible entries exist', async () => {
    installFetchMock({ ollamaUp: true, dim: 4 });
    const m = manifestOf([s('pruned-only', { transcriptStatus: 'pruned' })]);

    const result = await runEmbed({ outDir: tmpRoot, manifest: m });
    expect(result.skippedReason).toBe('no-sessions');
    expect(result.embedded).toBe(0);

    const meta = JSON.parse(
      await readFile(path.join(tmpRoot, 'analysis', 'embeddings.meta.json'), 'utf8'),
    ) as EmbeddingMeta;
    expect(meta.count).toBe(0);
    expect(meta.entries).toEqual([]);

    const bin = await readFile(path.join(tmpRoot, 'analysis', 'embeddings.bin'));
    expect(bin.length).toBe(0);
  });
});
