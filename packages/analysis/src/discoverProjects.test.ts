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

  // ---- Project Identity v2 ----

  it('emits per-session attribution { projectId, resolvedVia, confidence }', () => {
    const r = discoverProjects([
      s('a', { project: 'chat-arch' }),
      s('orphan', { title: 'nothing matches here' }),
    ]);
    const a = r.attribution.get('a');
    expect(a?.resolvedVia).toBe('project_field');
    expect(a?.confidence).toBe(1.0);
    expect(a?.projectId).toBe(r.sessionToProject.get('a'));
    const orphan = r.attribution.get('orphan');
    expect(orphan?.resolvedVia).toBe('unassigned');
    expect(orphan?.confidence).toBe(0);
    expect(orphan?.projectId).toBe(UNASSIGNED_PROJECT_ID);
  });

  it('scheduled-task bucket: id is proj_routine-<taskId>, displayName is the modal date-stripped stem', () => {
    const r = discoverProjects([
      s('r1', { cwdKind: 'vm', cwd: '/sessions/x', scheduledTaskId: 'shopforge-sync', title: 'Mar 28 – Shopforge sync' }),
      s('r2', { cwdKind: 'vm', cwd: '/sessions/y', scheduledTaskId: 'shopforge-sync', title: 'Mar 29 – Shopforge sync' }),
      s('r3', { cwdKind: 'vm', cwd: '/sessions/z', scheduledTaskId: 'shopforge-sync', title: 'Apr 02 – Shopforge sync' }),
    ]);
    const routine = r.projects.find((p) => p.id === 'proj_routine-shopforge-sync');
    expect(routine).toBeDefined();
    expect(routine?.sessionIds).toHaveLength(3);
    expect(routine?.displayName).toBe('Shopforge sync');
    expect(r.attribution.get('r1')?.resolvedVia).toBe('scheduled-task');
  });

  it('cross-source unification: VM userSelectedFolders basename merges with host cwd basename', () => {
    const r = discoverProjects([
      s('host', { cwdKind: 'host', cwd: 'C:/Users/b/Projects/chat-arch' }),
      s('vm', { cwdKind: 'vm', cwd: '/sessions/strange-bardeen', userSelectedFolders: ['/Users/b/chat-arch'] }),
    ]);
    expect(r.sessionToProject.get('host')).toBe('proj_chat-arch');
    expect(r.sessionToProject.get('vm')).toBe('proj_chat-arch');
    const p = r.projects.find((x) => x.id === 'proj_chat-arch');
    expect(p?.sessionIds.slice().sort()).toEqual(['host', 'vm']);
  });

  it('disambiguates displayName collisions with a short id suffix', () => {
    const r = discoverProjects([
      s('a', { cwdKind: 'vm', cwd: '/sessions/a', scheduledTaskId: 'task-one', title: 'Daily pulse' }),
      s('b', { cwdKind: 'vm', cwd: '/sessions/b', scheduledTaskId: 'task-two', title: 'Daily pulse' }),
    ]);
    const names = r.projects.map((p) => p.displayName);
    expect(names.every((n) => n.startsWith('Daily pulse ·'))).toBe(true);
    expect(new Set(names).size).toBe(2);
  });

  it('threads user overrides (rule 0) into the cascade', () => {
    const r = discoverProjects([s('z', { project: 'chat-arch', cwd: '/x/chat-arch' })], {
      overrides: [{ projectId: 'moved-elsewhere', match: { sessionIds: ['z'] } }],
    });
    expect(r.sessionToProject.get('z')).toBe('proj_moved-elsewhere');
    expect(r.attribution.get('z')?.resolvedVia).toBe('override');
  });
});
