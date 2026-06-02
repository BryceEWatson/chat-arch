/**
 * Project Identity v2 — adversarial experiment (plan §12, global CLAUDE.md
 * "Validation & Experiment Design": at least one adversarial experiment per
 * validation pass — "under what conditions does this NOT work?").
 *
 * Two failure modes the cascade DELIBERATELY trades off or must handle
 * deterministically. These tests pin the decided behavior so a regression
 * (silent over-merge with no escape hatch; order-dependent displayName)
 * fails loudly.
 */

import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { discoverProjects } from './discoverProjects.js';

function s(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cowork',
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

describe('adversarial (a): VM-USF basename over-merge of two distinct host folders', () => {
  // Decided trade-off (plan §4 "Rule 3 basename over-merge"): basename is the
  // right grain because it gives cross-source unification; the over-merge case
  // (`~/work/client-a/docs` vs `~/personal/docs`, both basename `docs`) is
  // handled by DETECTION + the manual override escape hatch, NOT by silently
  // switching to last-2-segments (which would regress the counted case).
  it('over-merges two distinct host folders that share a basename (the known limitation)', () => {
    const r = discoverProjects([
      s('w', { cwdKind: 'vm', cwd: '/sessions/a', userSelectedFolders: ['/home/b/work/client-a/docs'] }),
      s('p', { cwdKind: 'vm', cwd: '/sessions/b', userSelectedFolders: ['/home/b/personal/docs'] }),
    ]);
    // Both collapse to proj_docs — this IS the documented over-merge.
    expect(r.sessionToProject.get('w')).toBe('proj_docs');
    expect(r.sessionToProject.get('p')).toBe('proj_docs');
    const docs = r.projects.find((x) => x.id === 'proj_docs');
    expect(docs?.sessionIds.slice().sort()).toEqual(['p', 'w']);
  });

  it('the override escape hatch (component 5) splits the over-merge back apart', () => {
    const r = discoverProjects(
      [
        s('w', { cwdKind: 'vm', cwd: '/sessions/a', userSelectedFolders: ['/home/b/work/client-a/docs'] }),
        s('p', { cwdKind: 'vm', cwd: '/sessions/b', userSelectedFolders: ['/home/b/personal/docs'] }),
      ],
      {
        // A cwdGlob can't see userSelectedFolders, so use sessionIds here —
        // exactly the escape hatch the plan prescribes for irreducible cases.
        overrides: [{ projectId: 'client-a-docs', displayName: 'client-a docs', match: { sessionIds: ['w'] } }],
      },
    );
    expect(r.sessionToProject.get('w')).toBe('proj_client-a-docs');
    expect(r.sessionToProject.get('p')).toBe('proj_docs');
    expect(r.attribution.get('w')?.resolvedVia).toBe('override');
    expect(r.attribution.get('p')?.resolvedVia).toBe('vm-folder');
  });
});

describe('adversarial (b): one scheduledTaskId spans many date-prefixed per-run titles', () => {
  // Verified-real hazard (plan §4): a routine emits "Mar 28 – X", "Mar 29 – X",
  // … The displayName MUST resolve deterministically to the date-stripped stem
  // regardless of which per-run title is encountered first.
  const runs = [
    'Mar 28 – Shopforge daily metrics sync',
    'Mar 29 – Shopforge daily metrics sync',
    'Apr 02 – Shopforge daily metrics sync',
    'Apr 15 – Shopforge daily metrics sync',
  ];

  it('resolves to the date-stripped stem regardless of session order', () => {
    const forward = discoverProjects(
      runs.map((t, i) => s(`f${i}`, { cwdKind: 'vm', cwd: `/sessions/f${i}`, scheduledTaskId: 'shopforge-daily-metrics-sync', title: t })),
    );
    const reversed = discoverProjects(
      [...runs].reverse().map((t, i) => s(`r${i}`, { cwdKind: 'vm', cwd: `/sessions/r${i}`, scheduledTaskId: 'shopforge-daily-metrics-sync', title: t })),
    );
    const fName = forward.projects.find((p) => p.id === 'proj_routine-shopforge-daily-metrics-sync')?.displayName;
    const rName = reversed.projects.find((p) => p.id === 'proj_routine-shopforge-daily-metrics-sync')?.displayName;
    expect(fName).toBe('Shopforge daily metrics sync');
    expect(rName).toBe('Shopforge daily metrics sync');
    expect(fName).toBe(rName); // order-independent
  });

  it('one routine id → one project (no rename-split across per-run titles)', () => {
    const r = discoverProjects(
      runs.map((t, i) => s(`x${i}`, { cwdKind: 'vm', cwd: `/sessions/x${i}`, scheduledTaskId: 'shopforge-daily-metrics-sync', title: t })),
    );
    const routine = r.projects.filter((p) => p.id === 'proj_routine-shopforge-daily-metrics-sync');
    expect(routine).toHaveLength(1);
    expect(routine[0]?.sessionIds).toHaveLength(runs.length);
  });
});
