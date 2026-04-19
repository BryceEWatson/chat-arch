import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PHASE_7_RESERVED_FILES, fetchAnalysisTierStatus } from './analysisFetch.js';

/**
 * Covers `[R-AC14]` representative cases:
 *   (1) none present → BROWSER, N=0
 *   (2) only `duplicates.semantic.json` present → BROWSER+LOCAL (1/6)
 *   (3) only `reloops.json` present → BROWSER+LOCAL (1/6)
 *   (4) three of six present → BROWSER+LOCAL (3/6)
 *   (5) all six present → BROWSER+LOCAL (6/6)
 *   (6) unknown extra file is ignored (not counted, not crash) — the
 *       enumeration is code-driven, so this is implicitly covered by
 *       only probing the six known names; we assert the set of tierFiles
 *       keys equals the reserved set.
 * Additional negative tests cover network errors + bad JSON.
 */

type FetchStub = ReturnType<typeof vi.fn>;

function stubFetch(
  presentMap: Partial<Record<string, { generatedAt?: number } | 'net-error' | 'bad-json'>>,
): FetchStub {
  const fn = vi.fn(async (url: unknown): Promise<Response> => {
    const u = String(url);
    const match = PHASE_7_RESERVED_FILES.find((name) => u.endsWith(`/analysis/${name}`));
    if (!match) {
      // unknown filename → 404. This also covers the "unknown extra file
      // ignored" case when paired with a tierFiles-key assertion.
      return new Response(null, { status: 404 });
    }
    const entry = presentMap[match];
    if (entry === undefined) return new Response(null, { status: 404 });
    if (entry === 'net-error') throw new TypeError('simulated network failure');
    if (entry === 'bad-json') {
      return new Response('{not-valid-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('fetchAnalysisTierStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(1) none present → BROWSER, N=0, all tierFiles absent', async () => {
    stubFetch({});
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierStatus).toBe('browser');
    expect(result.tierPresentCount).toBe(0);
    for (const name of PHASE_7_RESERVED_FILES) {
      expect(result.tierFiles[name]?.present).toBe(false);
    }
  });

  it('(2) only duplicates.semantic.json present → BROWSER+LOCAL (1/6)', async () => {
    stubFetch({ 'duplicates.semantic.json': { generatedAt: 1700000000000 } });
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierStatus).toBe('browser+local');
    expect(result.tierPresentCount).toBe(1);
    expect(result.tierFiles['duplicates.semantic.json']).toEqual({
      present: true,
      generatedAt: 1700000000000,
    });
    expect(result.tierFiles['reloops.json']?.present).toBe(false);
  });

  it('(3) only reloops.json present → BROWSER+LOCAL (1/6)', async () => {
    stubFetch({ 'reloops.json': { generatedAt: 1710000000000 } });
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierStatus).toBe('browser+local');
    expect(result.tierPresentCount).toBe(1);
    expect(result.tierFiles['reloops.json']?.generatedAt).toBe(1710000000000);
  });

  it('(4) three of six present → BROWSER+LOCAL (3/6)', async () => {
    stubFetch({
      'duplicates.semantic.json': { generatedAt: 1 },
      'reloops.json': { generatedAt: 2 },
      'cost-diagnoses.json': { generatedAt: 3 },
    });
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierStatus).toBe('browser+local');
    expect(result.tierPresentCount).toBe(3);
    expect(result.tierFiles['handoffs.json']?.present).toBe(false);
    expect(result.tierFiles['skill-seeds.json']?.present).toBe(false);
    expect(result.tierFiles['zombies.diagnosed.json']?.present).toBe(false);
  });

  it('(5) all six present → BROWSER+LOCAL (6/6) with timestamps', async () => {
    const map: Record<string, { generatedAt: number }> = {};
    PHASE_7_RESERVED_FILES.forEach((name, i) => {
      map[name] = { generatedAt: 1_700_000_000_000 + i };
    });
    stubFetch(map);
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierStatus).toBe('browser+local');
    expect(result.tierPresentCount).toBe(6);
    for (let i = 0; i < PHASE_7_RESERVED_FILES.length; i += 1) {
      const name = PHASE_7_RESERVED_FILES[i]!;
      expect(result.tierFiles[name]).toEqual({
        present: true,
        generatedAt: 1_700_000_000_000 + i,
      });
    }
  });

  it('(6) unknown extra file does not appear in tierFiles; keys equal reserved set', async () => {
    // Stub returns a valid body ONLY for duplicates.semantic.json; any
    // other URL gets 404. We then check tierFiles keys == reserved set.
    stubFetch({ 'duplicates.semantic.json': { generatedAt: 1 } });
    const result = await fetchAnalysisTierStatus('/data');
    const keys = Object.keys(result.tierFiles).sort();
    const expected = [...PHASE_7_RESERVED_FILES].sort();
    expect(keys).toEqual(expected);
  });

  it('tolerates network errors (throw from fetch) → treats as absent', async () => {
    stubFetch({ 'reloops.json': 'net-error' });
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierFiles['reloops.json']?.present).toBe(false);
    expect(result.tierStatus).toBe('browser');
  });

  it('tolerates malformed JSON → treats as absent', async () => {
    stubFetch({ 'handoffs.json': 'bad-json' });
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierFiles['handoffs.json']?.present).toBe(false);
    expect(result.tierStatus).toBe('browser');
  });

  it('file present but no generatedAt field → present: true, generatedAt omitted', async () => {
    stubFetch({ 'skill-seeds.json': {} });
    const result = await fetchAnalysisTierStatus('/data');
    expect(result.tierFiles['skill-seeds.json']?.present).toBe(true);
    expect(result.tierFiles['skill-seeds.json']?.generatedAt).toBeUndefined();
  });

  it('strips trailing slash on dataRoot without double-slashing the URL', async () => {
    const fn = stubFetch({});
    await fetchAnalysisTierStatus('/data/');
    // Pick any fetch call and verify URL shape.
    const firstUrl = String(fn.mock.calls[0]?.[0]);
    expect(firstUrl).toMatch(/^\/data\/analysis\//);
    expect(firstUrl).not.toMatch(/\/\/analysis/);
  });
});
