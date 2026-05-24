/**
 * Tests for the Phase Rev3-F F9 curator feed client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCuratorFeed } from './curatorFeedClient.js';

beforeEach(() => {
  // start clean
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchResponse(status: number, body?: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response),
  );
}

function mockFetchThrows(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network down');
    }),
  );
}

describe('loadCuratorFeed', () => {
  it('returns null on 404', async () => {
    mockFetchResponse(404);
    expect(await loadCuratorFeed('/data')).toBeNull();
  });

  it('returns null on network failure', async () => {
    mockFetchThrows();
    expect(await loadCuratorFeed('/data')).toBeNull();
  });

  it('returns null on JSON parse failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json');
        },
      }) as unknown as Response),
    );
    expect(await loadCuratorFeed('/data')).toBeNull();
  });

  it('returns null when schemaVersion is not 1', async () => {
    mockFetchResponse(200, {
      schemaVersion: 99,
      items: [],
      generatedAt: 0,
      ranAt: '',
    });
    expect(await loadCuratorFeed('/data')).toBeNull();
  });

  it('returns null when items is missing', async () => {
    mockFetchResponse(200, {
      schemaVersion: 1,
      generatedAt: 0,
      ranAt: '',
    });
    expect(await loadCuratorFeed('/data')).toBeNull();
  });

  it('parses a valid feed file', async () => {
    mockFetchResponse(200, {
      schemaVersion: 1,
      generatedAt: 1700,
      ranAt: '2026-05-24T12:00:00Z',
      items: [
        {
          kind: 'narrative',
          entityId: 'n1',
          title: 'Test narrative',
          rank: 1,
          compositeScore: 0.72,
          falsifierStatus: 'verified',
        },
      ],
    });
    const feed = await loadCuratorFeed('/data');
    expect(feed).not.toBeNull();
    expect(feed?.items.length).toBe(1);
    expect(feed?.items[0]?.kind).toBe('narrative');
    expect(feed?.items[0]?.falsifierStatus).toBe('verified');
  });

  it('drops malformed items silently (defensive against corrupt write)', async () => {
    mockFetchResponse(200, {
      schemaVersion: 1,
      generatedAt: 1,
      ranAt: '',
      items: [
        // valid
        {
          kind: 'narrative',
          entityId: 'good',
          title: 'ok',
          rank: 1,
          compositeScore: 0.5,
        },
        // unknown kind
        {
          kind: 'pattern',
          entityId: 'bad-kind',
          title: 'x',
          rank: 2,
          compositeScore: 0.5,
        },
        // missing entityId
        { kind: 'narrative', title: 'x', rank: 3, compositeScore: 0.5 },
        // non-numeric rank
        {
          kind: 'narrative',
          entityId: 'bad-rank',
          title: 'x',
          rank: 'first',
          compositeScore: 0.5,
        },
        // unknown falsifierStatus
        {
          kind: 'narrative',
          entityId: 'bad-falsifier',
          title: 'x',
          rank: 5,
          compositeScore: 0.5,
          falsifierStatus: 'maybe',
        },
      ],
    });
    const feed = await loadCuratorFeed('/data');
    expect(feed?.items.length).toBe(1);
    expect(feed?.items[0]?.entityId).toBe('good');
  });

  it('preserves metaAccuracy when present', async () => {
    mockFetchResponse(200, {
      schemaVersion: 1,
      generatedAt: 1,
      ranAt: '',
      items: [],
      metaAccuracy: {
        inDrift: true,
        n: 40,
        accuracy: 0.7,
        lowerBound: 0.55,
        floor: 0.8,
      },
    });
    const feed = await loadCuratorFeed('/data');
    expect(feed?.metaAccuracy?.inDrift).toBe(true);
    expect(feed?.metaAccuracy?.lowerBound).toBe(0.55);
  });

  it('builds the right URL relative to baseUrl', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchSpy);
    await loadCuratorFeed('/data/');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/data/analysis/curator-feed.json',
      expect.any(Object),
    );
    await loadCuratorFeed('/data'); // no trailing slash
    expect(fetchSpy).toHaveBeenCalledWith(
      '/data/analysis/curator-feed.json',
      expect.any(Object),
    );
  });
});
