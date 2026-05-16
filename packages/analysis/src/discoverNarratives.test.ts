import { describe, it, expect } from 'vitest';
import type { Project, UnifiedSessionEntry } from '@chat-arch/schema';
import { UNASSIGNED_PROJECT_ID, validateNarrative } from '@chat-arch/schema';
import { discoverNarratives } from './discoverNarratives.js';

function mkSession(
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

function mkProject(id: string, sessionIds: readonly string[]): Project {
  return {
    id,
    displayName: id,
    discoveredAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    sessionIds,
    narrativeIds: [],
    topicIds: [],
    sentiment: 'neutral',
    source: 'cli-cwd',
  };
}

describe('discoverNarratives', () => {
  it('emits a positive narrative when a project has ≥2 positive sessions', () => {
    const sessions = [
      mkSession('a', { title: 'shipped feature' }),
      mkSession('b', { title: 'tests pass and merged' }),
      mkSession('c', { title: 'unrelated discussion' }),
    ];
    const projects = [mkProject('proj_x', ['a', 'b', 'c'])];
    const r = discoverNarratives(sessions, projects, { now: 1000 });
    const narr = r.narratives.find((n) => n.sentiment === 'positive');
    expect(narr).toBeDefined();
    expect(narr?.actionType).toBe('encode-as-pattern');
    expect(narr?.sessionIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(() => validateNarrative(narr!)).not.toThrow();
  });

  it('emits a negative narrative when a project has ≥2 negative sessions', () => {
    const sessions = [
      mkSession('a', { title: "doesn't work" }),
      mkSession('b', { title: 'broken: stuck on error' }),
    ];
    const projects = [mkProject('proj_y', ['a', 'b'])];
    const r = discoverNarratives(sessions, projects);
    const narr = r.narratives.find((n) => n.sentiment === 'negative');
    expect(narr).toBeDefined();
    expect(narr?.actionType).toBe('generate-corrective-prompt');
  });

  it('emits both polarities and rolls project sentiment to "mixed"', () => {
    const sessions = [
      mkSession('a', { title: 'shipped' }),
      mkSession('b', { title: 'tests pass' }),
      mkSession('c', { title: 'broken' }),
      mkSession('d', { title: 'failed deploy' }),
    ];
    const projects = [mkProject('proj_z', ['a', 'b', 'c', 'd'])];
    const r = discoverNarratives(sessions, projects);
    expect(r.narratives).toHaveLength(2);
    expect(r.projectSentiment.get('proj_z')).toBe('mixed');
  });

  it('does NOT emit narratives for the [UNASSIGNED] pseudo-project (D8)', () => {
    const sessions = [
      mkSession('a', { title: 'shipped' }),
      mkSession('b', { title: 'merged' }),
    ];
    const projects = [mkProject(UNASSIGNED_PROJECT_ID, ['a', 'b'])];
    const r = discoverNarratives(sessions, projects);
    expect(r.narratives).toHaveLength(0);
    expect(r.narrativesByProject.get(UNASSIGNED_PROJECT_ID)).toEqual([]);
    expect(r.projectSentiment.get(UNASSIGNED_PROJECT_ID)).toBe('neutral');
  });

  it('skips clusters smaller than minClusterSize', () => {
    const sessions = [mkSession('a', { title: 'shipped' })];
    const projects = [mkProject('proj_q', ['a'])];
    const r = discoverNarratives(sessions, projects);
    expect(r.narratives).toHaveLength(0);
    expect(r.projectSentiment.get('proj_q')).toBe('neutral');
  });

  it('clusters on userTextSamples in addition to title+preview+summary', () => {
    // Two sessions whose titles are sentiment-neutral but whose
    // userTextSamples carry strong positive sentiment. Without the T6
    // widening, neither session would score positive and no narrative
    // would emit. With the widening, both score positive and the
    // narrative shows up.
    const sessions = [
      mkSession('a', {
        title: 'check this',
        userTextSamples: ['that worked perfectly, tests pass'],
      }),
      mkSession('b', {
        title: 'check this',
        userTextSamples: ['shipped the fix, everything green'],
      }),
    ];
    const projects = [mkProject('proj_widen', ['a', 'b'])];
    const r = discoverNarratives(sessions, projects);
    const narr = r.narratives.find((n) => n.sentiment === 'positive');
    expect(narr).toBeDefined();
    expect(narr?.sessionIds).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
