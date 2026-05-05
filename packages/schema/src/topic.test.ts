import { describe, it, expect } from 'vitest';
import type { Topic } from './topic.js';

describe('Topic entity', () => {
  it('round-trips through JSON without loss', () => {
    const t: Topic = {
      id: 'topic_git_review',
      displayName: '~git + commit + review',
      sessionIds: ['s1', 's2', 's3'],
      projectIds: ['proj_a', 'proj_b'],
      firstSeenAt: '2026-04-01T00:00:00.000Z',
      lastSeenAt: '2026-05-05T00:00:00.000Z',
    };
    const round = JSON.parse(JSON.stringify(t)) as Topic;
    expect(round).toEqual(t);
  });

  it('preserves emergent-cluster `~` prefix in displayName', () => {
    const t: Topic = {
      id: 'topic_emergent',
      displayName: '~debug + retry + abandoned',
      sessionIds: [],
      projectIds: [],
      firstSeenAt: '2026-05-05T00:00:00.000Z',
      lastSeenAt: '2026-05-05T00:00:00.000Z',
    };
    expect(t.displayName.startsWith('~')).toBe(true);
  });
});
