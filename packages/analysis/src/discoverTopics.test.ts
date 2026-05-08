import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { discoverTopics } from './discoverTopics.js';

function s(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 1000,
    updatedAt: 2000,
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

describe('discoverTopics', () => {
  it('groups sessions by their existing topic string', () => {
    const r = discoverTopics(
      [
        s('a', { topic: '~git + commit + review' }),
        s('b', { topic: '~git + commit + review' }),
        s('c', { topic: '~debug + retry' }),
      ],
      new Map([
        ['a', 'proj_a'],
        ['b', 'proj_a'],
        ['c', 'proj_b'],
      ]),
    );
    expect(r.topics).toHaveLength(2);
    const git = r.topics.find((t) => t.displayName.includes('git'));
    expect(git?.sessionIds).toEqual(['a', 'b']);
    expect(git?.projectIds).toEqual(['proj_a']);
  });

  it('skips sessions without a topic string', () => {
    const r = discoverTopics([s('a'), s('b', { topic: 't1' })], new Map());
    expect(r.topics).toHaveLength(1);
    expect(r.sessionToTopics.get('a')).toEqual([]);
    expect(r.sessionToTopics.get('b')).toEqual(r.topics[0]?.id ? [r.topics[0].id] : []);
  });

  it('cross-references projects-per-topic', () => {
    const r = discoverTopics(
      [
        s('a', { topic: 't1' }),
        s('b', { topic: 't1' }),
      ],
      new Map([
        ['a', 'proj_x'],
        ['b', 'proj_y'],
      ]),
    );
    const topic = r.topics[0]!;
    expect(new Set(topic.projectIds)).toEqual(new Set(['proj_x', 'proj_y']));
  });
});
