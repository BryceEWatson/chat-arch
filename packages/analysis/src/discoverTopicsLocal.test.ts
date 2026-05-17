import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { discoverTopicsLocal } from './discoverTopicsLocal.js';

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
    durationMs: 0,
    title: id,
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  };
}

// Build a unit-norm vector along a single axis so we can shape cosine
// distances by axis assignment.
function axisVec(dim: number, axis: number): Float32Array {
  const v = new Float32Array(dim);
  v[axis] = 1;
  return v;
}

describe('discoverTopicsLocal', () => {
  it('returns empty when there are no eligible sessions', () => {
    const r = discoverTopicsLocal([], new Map(), new Map());
    expect(r.topics).toEqual([]);
    expect(r.consideredCount).toBe(0);
  });

  it('ignores sessions that already carry an entry.topic string', () => {
    const sessions = [
      s('a', { topic: '~git + commit', title: 'git work alpha' }),
      s('b', { topic: '~git + commit', title: 'git work beta' }),
      s('c', { topic: '~git + commit', title: 'git work gamma' }),
    ];
    const embeddings = new Map<string, Float32Array>([
      ['a', axisVec(8, 0)],
      ['b', axisVec(8, 0)],
      ['c', axisVec(8, 0)],
    ]);
    const r = discoverTopicsLocal(sessions, embeddings, new Map());
    expect(r.topics).toEqual([]);
    expect(r.consideredCount).toBe(0);
  });

  it('emits one cluster when ≥minSize sessions share an axis', () => {
    const sessions: UnifiedSessionEntry[] = [];
    const embeddings = new Map<string, Float32Array>();
    for (let i = 0; i < 4; i += 1) {
      const id = `topic-a-${i}`;
      sessions.push(s(id, { title: `topic alpha session ${i}`, preview: 'topic alpha discussion' }));
      embeddings.set(id, axisVec(8, 0));
    }
    for (let i = 0; i < 4; i += 1) {
      const id = `topic-b-${i}`;
      sessions.push(s(id, { title: `topic beta session ${i}`, preview: 'topic beta different content' }));
      embeddings.set(id, axisVec(8, 1));
    }
    const r = discoverTopicsLocal(sessions, embeddings, new Map(), {
      threshold: 0.99,
      minSize: 3,
    });
    expect(r.topics.length).toBe(2);
    for (const t of r.topics) {
      expect(t.sessionIds.length).toBeGreaterThanOrEqual(3);
      expect(t.id.startsWith('topic_local_')).toBe(true);
      expect(t.displayName.startsWith('~')).toBe(true);
    }
  });

  it('cross-references projects when sessionToProject maps the members', () => {
    const sessions: UnifiedSessionEntry[] = [];
    const embeddings = new Map<string, Float32Array>();
    const map = new Map<string, string>();
    for (let i = 0; i < 4; i += 1) {
      const id = `s-${i}`;
      sessions.push(s(id, { title: `payments handler ${i}` }));
      embeddings.set(id, axisVec(8, 0));
      map.set(id, 'proj_payments');
    }
    const r = discoverTopicsLocal(sessions, embeddings, map, { threshold: 0.99, minSize: 3 });
    expect(r.topics).toHaveLength(1);
    expect(r.topics[0]?.projectIds).toEqual(['proj_payments']);
  });

  it('skips sessions without an embedding', () => {
    const sessions = [
      s('a', { title: 'foo' }),
      s('b', { title: 'bar' }),
      s('c', { title: 'baz' }),
      s('d', { title: 'qux' }),
    ];
    const embeddings = new Map<string, Float32Array>([
      ['a', axisVec(8, 0)],
      ['b', axisVec(8, 0)],
      ['c', axisVec(8, 0)],
    ]);
    const r = discoverTopicsLocal(sessions, embeddings, new Map(), {
      threshold: 0.99,
      minSize: 3,
    });
    expect(r.consideredCount).toBe(3);
    expect(r.topics[0]?.sessionIds.sort()).toEqual(['a', 'b', 'c']);
  });
});
