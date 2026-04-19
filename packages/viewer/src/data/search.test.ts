import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { filterSessions, sortByUpdatedDesc, bucketByWeek } from './search.js';

function base(overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id: 'id1',
    source: 'cloud',
    rawSessionId: 'id1',
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: 'Sample',
    titleSource: 'cloud-name',
    preview: 'preview text',
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

describe('filterSessions', () => {
  const a = base({ id: 'a', title: 'Architect the index', preview: 'hello world' });
  const b = base({ id: 'b', title: 'Other', summary: 'architectural review', preview: 'zzz' });
  const c = base({ id: 'c', title: 'Plain', source: 'cowork', preview: 'cowork body' });
  const all = [a, b, c];

  it('pass-through when empty query and empty filter', () => {
    expect(filterSessions(all, '', new Set())).toHaveLength(3);
  });
  it('case-insensitive substring matches title, summary, preview', () => {
    expect(filterSessions(all, 'arch', new Set())).toHaveLength(2);
    expect(filterSessions(all, 'COWORK', new Set())).toHaveLength(1);
  });
  it('source filter narrows set', () => {
    const f = new Set<UnifiedSessionEntry['source']>(['cowork']);
    expect(filterSessions(all, '', f)).toEqual([c]);
  });
  it('query + filter combine (AND)', () => {
    const f = new Set<UnifiedSessionEntry['source']>(['cloud']);
    expect(filterSessions(all, 'cowork', f)).toHaveLength(0);
  });
  it('null preview does not crash', () => {
    const n = base({ id: 'n', preview: null });
    expect(filterSessions([n], 'anything', new Set())).toHaveLength(0);
  });
});

describe('filterSessions — extended axes', () => {
  const byCwd = {
    id: 'cwd',
    title: 'something',
    preview: null,
    summary: undefined,
    cwd: '/home/example/my-project-b',
  } as unknown as UnifiedSessionEntry;
  const byProject = {
    id: 'proj',
    title: 'foo',
    preview: null,
    project: 'my-project-b',
  } as unknown as UnifiedSessionEntry;
  const byTool = {
    id: 'tool',
    title: 'bar',
    preview: null,
    topTools: { web_search: 3, Read: 5 },
  } as unknown as UnifiedSessionEntry;
  const byModel = {
    id: 'model',
    title: 'baz',
    preview: null,
    modelsUsed: ['claude-opus-4-7', 'claude-sonnet-4-5'],
  } as unknown as UnifiedSessionEntry;

  it('matches on project (case-insensitive)', () => {
    expect(filterSessions([byProject], 'my-project-b', new Set())).toHaveLength(1);
    expect(filterSessions([byProject], 'MY-PROJECT-B', new Set())).toHaveLength(1);
  });

  it('matches on cwd', () => {
    expect(filterSessions([byCwd], 'my-project-b', new Set())).toHaveLength(1);
  });

  it('matches on topTools key name (case-insensitive)', () => {
    expect(filterSessions([byTool], 'web_search', new Set())).toHaveLength(1);
    expect(filterSessions([byTool], 'WEB_SEARCH', new Set())).toHaveLength(1);
  });

  it('matches on modelsUsed entries', () => {
    expect(filterSessions([byModel], 'opus-4-7', new Set())).toHaveLength(1);
    expect(filterSessions([byModel], 'sonnet-4-5', new Set())).toHaveLength(1);
  });

  it('does not match when the query is absent from all axes', () => {
    expect(
      filterSessions([byCwd, byProject, byTool, byModel], 'nonexistent', new Set()),
    ).toHaveLength(0);
  });
});

describe('sortByUpdatedDesc', () => {
  it('newest first, does not mutate', () => {
    const x = base({ id: '1', updatedAt: 100 });
    const y = base({ id: '2', updatedAt: 300 });
    const z = base({ id: '3', updatedAt: 200 });
    const input = [x, y, z];
    const sorted = sortByUpdatedDesc(input);
    expect(sorted.map((s) => s.id)).toEqual(['2', '3', '1']);
    expect(input.map((s) => s.id)).toEqual(['1', '2', '3']);
  });
});

describe('bucketByWeek', () => {
  it('empty input', () => {
    expect(bucketByWeek([])).toEqual([]);
  });
  it('buckets three entries across three weeks', () => {
    const WEEK = 7 * 86_400_000;
    // Pick a known Sunday 00:00 UTC as anchor.
    const sunday = Date.UTC(2026, 3, 5, 0, 0, 0); // 2026-04-05
    const s1 = base({ id: '1', updatedAt: sunday + 3_600_000 }); // week 0
    const s2 = base({ id: '2', updatedAt: sunday + WEEK + 3_600_000 }); // week 1
    const s3 = base({ id: '3', updatedAt: sunday + 2 * WEEK + 3_600_000 }); // week 2
    const buckets = bucketByWeek([s1, s2, s3]);
    expect(buckets).toHaveLength(3);
    expect(buckets.map((b) => b.count)).toEqual([1, 1, 1]);
    expect(buckets[0]!.start).toBe(sunday);
  });
  it('fills gaps with zero counts', () => {
    const WEEK = 7 * 86_400_000;
    const sunday = Date.UTC(2026, 3, 5, 0, 0, 0);
    const s1 = base({ id: '1', updatedAt: sunday });
    const s2 = base({ id: '2', updatedAt: sunday + 3 * WEEK });
    const buckets = bucketByWeek([s1, s2]);
    expect(buckets.map((b) => b.count)).toEqual([1, 0, 0, 1]);
  });
  it('groups same-week entries', () => {
    const sunday = Date.UTC(2026, 3, 5, 0, 0, 0);
    const s1 = base({ id: '1', updatedAt: sunday });
    const s2 = base({ id: '2', updatedAt: sunday + 86_400_000 });
    const buckets = bucketByWeek([s1, s2]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.count).toBe(2);
  });
});
