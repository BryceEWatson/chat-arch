import { describe, it, expect } from 'vitest';
import type { Project, Topic, UnifiedSessionEntry } from '@chat-arch/schema';
import { UNASSIGNED_PROJECT_ID } from '@chat-arch/schema';
import {
  rankProjectsByActivity,
  rankTopicsBySessionCount,
  sortSessionsByRecency,
} from './indexes.js';

function project(opts: Partial<Project> & { id: string }): Project {
  return {
    id: opts.id,
    displayName: opts.displayName ?? opts.id,
    discoveredAt: opts.discoveredAt ?? '2026-01-01T00:00:00Z',
    lastActivityAt: opts.lastActivityAt ?? '2026-01-01T00:00:00Z',
    sessionIds: opts.sessionIds ?? [],
    narrativeIds: opts.narrativeIds ?? [],
    topicIds: opts.topicIds ?? [],
    sentiment: opts.sentiment ?? 'neutral',
    source: opts.source ?? 'cli-cwd',
  };
}

function topic(id: string, sessionCount: number): Topic {
  return {
    id,
    displayName: id,
    sessionIds: Array.from({ length: sessionCount }, (_, i) => `${id}-s${i}`),
    projectIds: [],
  } as unknown as Topic;
}

function entry(id: string, updatedAt: number): UnifiedSessionEntry {
  return { id, updatedAt } as unknown as UnifiedSessionEntry;
}

describe('rankProjectsByActivity', () => {
  it('returns empty for empty input', () => {
    expect(rankProjectsByActivity([])).toEqual([]);
  });

  it('orders most-recent-activity first', () => {
    const a = project({ id: 'a', lastActivityAt: '2026-01-01T00:00:00Z' });
    const b = project({ id: 'b', lastActivityAt: '2026-03-01T00:00:00Z' });
    const c = project({ id: 'c', lastActivityAt: '2026-02-01T00:00:00Z' });
    expect(rankProjectsByActivity([a, b, c]).map((p) => p.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('pins [UNASSIGNED] last regardless of activity', () => {
    const u = project({
      id: UNASSIGNED_PROJECT_ID,
      lastActivityAt: '2030-01-01T00:00:00Z', // most recent
    });
    const a = project({ id: 'a', lastActivityAt: '2026-01-01T00:00:00Z' });
    expect(rankProjectsByActivity([u, a]).map((p) => p.id)).toEqual([
      'a',
      UNASSIGNED_PROJECT_ID,
    ]);
  });

  it('does not mutate the input array', () => {
    const a = project({ id: 'a', lastActivityAt: '2026-01-01T00:00:00Z' });
    const b = project({ id: 'b', lastActivityAt: '2026-03-01T00:00:00Z' });
    const input = [a, b];
    rankProjectsByActivity(input);
    expect(input.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('rankTopicsBySessionCount', () => {
  it('returns empty for empty input', () => {
    expect(rankTopicsBySessionCount([])).toEqual([]);
  });

  it('orders most-sessions first and does not mutate input', () => {
    const input = [topic('a', 1), topic('b', 5), topic('c', 3)];
    expect(rankTopicsBySessionCount(input).map((t) => t.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(input.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('sortSessionsByRecency', () => {
  it('returns empty when no ids', () => {
    expect(sortSessionsByRecency([], new Map())).toEqual([]);
  });

  it('drops ids with no entry in the map', () => {
    const map = new Map([['s1', entry('s1', 100)]]);
    expect(
      sortSessionsByRecency(['s1', 'missing'], map).map((s) => s.id),
    ).toEqual(['s1']);
  });

  it('orders resolved entries most-recent-updated first', () => {
    const map = new Map([
      ['s1', entry('s1', 100)],
      ['s2', entry('s2', 300)],
      ['s3', entry('s3', 200)],
    ]);
    expect(
      sortSessionsByRecency(['s1', 's2', 's3'], map).map((s) => s.id),
    ).toEqual(['s2', 's3', 's1']);
  });
});
