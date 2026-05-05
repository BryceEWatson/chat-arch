import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { UNASSIGNED_PROJECT_ID } from '@chat-arch/schema';
import { discoverProjects } from './discoverProjects.js';

function s(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 1714521600000,
    updatedAt: 1714521600000,
    durationMs: 0,
    title: 'Session ' + id,
    titleSource: 'fallback',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  };
}

describe('discoverProjects', () => {
  it('groups sessions by inferred project field', () => {
    const r = discoverProjects(
      [
        s('a', { project: 'chat-arch' }),
        s('b', { project: 'chat-arch' }),
        s('c', { project: 'other-proj' }),
      ],
      { now: 1714521600000 },
    );
    expect(r.projects).toHaveLength(2);
    const chatArch = r.projects.find((p) => p.displayName === 'chat-arch');
    expect(chatArch?.sessionIds).toEqual(['a', 'b']);
    expect(r.sessionToProject.get('a')).toBe(chatArch?.id);
  });

  it('emits the [UNASSIGNED] pseudo-project for un-projected sessions', () => {
    const r = discoverProjects([s('orphan', { title: 'no project signal here' })]);
    const u = r.projects.find((p) => p.id === UNASSIGNED_PROJECT_ID);
    expect(u).toBeDefined();
    expect(u?.sessionIds).toEqual(['orphan']);
    expect(u?.narrativeIds).toEqual([]);
    expect(u?.source).toBe('unassigned');
    expect(r.sessionToProject.get('orphan')).toBe(UNASSIGNED_PROJECT_ID);
  });

  it('does not emit UNASSIGNED when every session has a project', () => {
    const r = discoverProjects([s('a', { project: 'p1' }), s('b', { project: 'p1' })]);
    expect(r.projects.find((p) => p.id === UNASSIGNED_PROJECT_ID)).toBeUndefined();
  });

  it('every session is assigned to exactly one project', () => {
    const sessions = [
      s('a', { project: 'p1' }),
      s('b', { project: 'p2' }),
      s('c', { title: 'orphan' }),
    ];
    const r = discoverProjects(sessions);
    for (const sess of sessions) {
      expect(r.sessionToProject.has(sess.id)).toBe(true);
    }
  });

  it('produces stable, slugged project ids', () => {
    const r = discoverProjects([s('a', { project: 'My Project!' })]);
    const p = r.projects.find((x) => x.displayName === 'My Project!');
    expect(p?.id).toMatch(/^proj_/);
    expect(p?.id).not.toContain(' ');
    expect(p?.id).not.toContain('!');
  });

  it('rolls up lastActivityAt to the latest member updatedAt', () => {
    const r = discoverProjects(
      [
        s('a', { project: 'p1', updatedAt: 1000 }),
        s('b', { project: 'p1', updatedAt: 2000 }),
      ],
      { now: 5000 },
    );
    const p = r.projects[0]!;
    expect(p.lastActivityAt).toBe(new Date(2000).toISOString());
    expect(p.discoveredAt).toBe(new Date(5000).toISOString());
  });
});
