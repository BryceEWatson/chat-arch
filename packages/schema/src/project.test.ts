import { describe, it, expect } from 'vitest';
import {
  UNASSIGNED_PROJECT_ID,
  UNASSIGNED_PROJECT_DISPLAY,
  isUnassignedProject,
  type Project,
} from './project.js';

describe('Project entity', () => {
  it('exports UNASSIGNED_PROJECT_ID === "__unassigned__"', () => {
    expect(UNASSIGNED_PROJECT_ID).toBe('__unassigned__');
  });

  it('isUnassignedProject discriminates correctly', () => {
    expect(isUnassignedProject({ id: UNASSIGNED_PROJECT_ID })).toBe(true);
    expect(isUnassignedProject({ id: 'proj_abc123' })).toBe(false);
  });

  it('round-trips through JSON without loss', () => {
    const p: Project = {
      id: 'proj_abc',
      displayName: 'chat-arch',
      discoveredAt: '2026-05-05T00:00:00.000Z',
      lastActivityAt: '2026-05-05T12:00:00.000Z',
      sessionIds: ['s1', 's2'],
      narrativeIds: ['n1'],
      topicIds: ['t1', 't2'],
      sentiment: 'positive',
      source: 'cli-cwd',
    };
    const round = JSON.parse(JSON.stringify(p)) as Project;
    expect(round).toEqual(p);
  });

  it('represents the [UNASSIGNED] pseudo-project with no narratives', () => {
    const u: Project = {
      id: UNASSIGNED_PROJECT_ID,
      displayName: UNASSIGNED_PROJECT_DISPLAY,
      discoveredAt: '2026-05-05T00:00:00.000Z',
      lastActivityAt: '2026-05-05T00:00:00.000Z',
      sessionIds: ['s1'],
      narrativeIds: [],
      topicIds: ['t1'],
      sentiment: 'neutral',
      source: 'unassigned',
    };
    expect(u.narrativeIds).toHaveLength(0);
    expect(isUnassignedProject(u)).toBe(true);
  });
});
