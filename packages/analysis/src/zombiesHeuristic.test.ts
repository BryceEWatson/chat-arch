import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import {
  buildZombieProjects,
  buildZombiesFile,
  classifyProject,
  PROBE_REGEX,
} from './zombiesHeuristic.js';

const MS_PER_DAY = 86_400_000;

function mkSession(overrides: Partial<UnifiedSessionEntry>): UnifiedSessionEntry {
  const startedAt = overrides.startedAt ?? 0;
  return {
    id: overrides.id ?? 'x',
    source: 'cloud',
    rawSessionId: overrides.id ?? 'x',
    startedAt,
    updatedAt: overrides.updatedAt ?? startedAt,
    durationMs: 0,
    title: overrides.title ?? 'Title',
    titleSource: 'cloud-name',
    preview: overrides.preview ?? null,
    userTurns: 2,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

describe('PROBE_REGEX — covers the documented probe phrasings', () => {
  it('matches canonical probe phrasings', () => {
    const hits = [
      'Profitability Outlook for project-c',
      'MVP project plan feasibility',
      'Is the dashboard still viable?',
      'Revisit the pivot',
      'What do you think about the idea?',
      'Worth building? decision doc',
      're-evaluate',
      'Status of the pilot',
    ];
    for (const t of hits) {
      expect(PROBE_REGEX.test(t), `did not match: ${t}`).toBe(true);
    }
  });

  it('does not match random unrelated titles', () => {
    const misses = [
      'Build chat archaeologist orchestrator',
      'Resolving CI deployment issues',
      'Bug fix in retry mock',
    ];
    for (const t of misses) {
      expect(PROBE_REGEX.test(t), `falsely matched: ${t}`).toBe(false);
    }
  });
});

describe('classifyProject — lifecycle states', () => {
  const now = 100 * MS_PER_DAY; // arbitrary "now"

  it('classifies as active when lastActivity < 30 days', () => {
    const r = classifyProject(
      [
        {
          id: 's1',
          startedAt: now - 5 * MS_PER_DAY,
          updatedAt: now - 5 * MS_PER_DAY,
          title: 'x',
          preview: null,
        },
      ],
      now,
    );
    expect(r.classification).toBe('active');
    expect(r.probeSessionIds).toEqual([]);
  });

  it('classifies as dormant when lastActivity ≥ 30 days but no probe', () => {
    const r = classifyProject(
      [
        {
          id: 's1',
          startedAt: now - 80 * MS_PER_DAY,
          updatedAt: now - 80 * MS_PER_DAY,
          title: 'a',
          preview: null,
        },
        {
          id: 's2',
          startedAt: now - 75 * MS_PER_DAY,
          updatedAt: now - 75 * MS_PER_DAY,
          title: 'b',
          preview: null,
        },
      ],
      now,
    );
    expect(r.classification).toBe('dormant');
  });

  it('classifies as zombie when probe after ≥60-day gap with no dense follow-up', () => {
    const r = classifyProject(
      [
        {
          id: 's1',
          startedAt: now - 200 * MS_PER_DAY,
          updatedAt: now - 200 * MS_PER_DAY,
          title: 'initial',
          preview: null,
        },
        {
          id: 's2',
          startedAt: now - 195 * MS_PER_DAY,
          updatedAt: now - 195 * MS_PER_DAY,
          title: 'more work',
          preview: null,
        },
        {
          id: 's3',
          startedAt: now - 190 * MS_PER_DAY,
          updatedAt: now - 190 * MS_PER_DAY,
          title: 'more',
          preview: null,
        },
        // Gap > 60 days, then probe.
        {
          id: 'probe',
          startedAt: now - 100 * MS_PER_DAY,
          updatedAt: now - 100 * MS_PER_DAY,
          title: 'Profitability Outlook for Project',
          preview: null,
        },
      ],
      now,
    );
    expect(r.classification).toBe('zombie');
    expect(r.probeSessionIds).toEqual(['probe']);
  });

  it('does NOT classify as zombie when probe is followed by dense activity', () => {
    const r = classifyProject(
      [
        {
          id: 's1',
          startedAt: now - 200 * MS_PER_DAY,
          updatedAt: now - 200 * MS_PER_DAY,
          title: 'a',
          preview: null,
        },
        {
          id: 'probe',
          startedAt: now - 100 * MS_PER_DAY,
          updatedAt: now - 100 * MS_PER_DAY,
          title: 'MVP feasibility',
          preview: null,
        },
        // Dense follow-up: 3 sessions within 14 days
        {
          id: 'f1',
          startedAt: now - 99 * MS_PER_DAY,
          updatedAt: now - 99 * MS_PER_DAY,
          title: 'b',
          preview: null,
        },
        {
          id: 'f2',
          startedAt: now - 98 * MS_PER_DAY,
          updatedAt: now - 98 * MS_PER_DAY,
          title: 'c',
          preview: null,
        },
      ],
      now,
    );
    expect(r.classification).toBe('dormant');
    expect(r.probeSessionIds).toEqual([]);
  });

  it('computes burst windows for dense activity clusters', () => {
    const r = classifyProject(
      [
        {
          id: '1',
          startedAt: now - 30 * MS_PER_DAY,
          updatedAt: now - 30 * MS_PER_DAY,
          title: 'x',
          preview: null,
        },
        {
          id: '2',
          startedAt: now - 29 * MS_PER_DAY,
          updatedAt: now - 29 * MS_PER_DAY,
          title: 'x',
          preview: null,
        },
        {
          id: '3',
          startedAt: now - 28 * MS_PER_DAY,
          updatedAt: now - 28 * MS_PER_DAY,
          title: 'x',
          preview: null,
        },
      ],
      now,
    );
    expect(r.burstWindows.length).toBe(1);
    expect(r.burstWindows[0]!.count).toBe(3);
  });
});

describe('buildZombieProjects — title-keyword inference resolves zombie projects', () => {
  const NOW = new Date('2026-04-17').getTime();

  it('my-project-c: classified zombie via title_keyword', () => {
    const sessions: UnifiedSessionEntry[] = [
      // Dense early activity.
      mkSession({
        id: 'pc-1',
        title: 'Resolving Backend Test Failure in "my-project-c"',
        startedAt: new Date('2024-08-01').getTime(),
        updatedAt: new Date('2024-08-01').getTime(),
      }),
      mkSession({
        id: 'pc-2',
        title: 'Next steps for the my-project-c roadmap',
        startedAt: new Date('2024-08-05').getTime(),
        updatedAt: new Date('2024-08-05').getTime(),
      }),
      mkSession({
        id: 'pc-3',
        title: 'Detailed Developer Tasks for my-project-c Improvements',
        startedAt: new Date('2024-08-10').getTime(),
        updatedAt: new Date('2024-08-10').getTime(),
      }),
      // Probe after a ≥60-day gap
      mkSession({
        id: 'pc-probe1',
        title: 'Profitability Outlook for my-project-c',
        startedAt: new Date('2025-05-24').getTime(),
        updatedAt: new Date('2025-05-24').getTime(),
      }),
      mkSession({
        id: 'pc-probe2',
        title: 'MVP project plan feasibility',
        preview: 'evaluation of their MVP project plan for my-project-c',
        startedAt: new Date('2025-11-23').getTime(),
        updatedAt: new Date('2025-11-23').getTime(),
      }),
    ];
    const projects = buildZombieProjects(sessions, NOW);
    const pc = projects.find((p) => p.id === 'my-project-c');
    expect(pc, 'my-project-c not resolved').toBeDefined();
    expect(pc!.classification).toBe('zombie');
    expect(pc!.inferenceSource).toBe('title_keyword');
  });

  it('my-project-a: zombie via title_keyword', () => {
    const sessions: UnifiedSessionEntry[] = [
      mkSession({
        id: 'pa-1',
        title: 'my-project-a Dashboard',
        startedAt: new Date('2024-06-15').getTime(),
        updatedAt: new Date('2024-06-15').getTime(),
      }),
      mkSession({
        id: 'pa-2',
        title: 'Enhance my-project-a Dashboard',
        startedAt: new Date('2024-06-20').getTime(),
        updatedAt: new Date('2024-06-20').getTime(),
      }),
      mkSession({
        id: 'pa-3',
        title: 'Improving the my-project-a Dashboard UI',
        startedAt: new Date('2024-07-10').getTime(),
        updatedAt: new Date('2024-07-10').getTime(),
      }),
      mkSession({
        id: 'pa-probe',
        title: 'Status of my-project-a re-evaluate',
        startedAt: new Date('2025-09-01').getTime(),
        updatedAt: new Date('2025-09-01').getTime(),
      }),
    ];
    const projects = buildZombieProjects(sessions, NOW);
    const pa = projects.find((p) => p.id === 'my-project-a');
    expect(pa).toBeDefined();
    expect(pa!.classification).toBe('zombie');
    expect(pa!.inferenceSource).toBe('title_keyword');
  });

  it('my-project-b: zombie via title_keyword', () => {
    const sessions: UnifiedSessionEntry[] = [
      mkSession({
        id: 'pb-1',
        title: 'Initial design for my-project-b',
        startedAt: new Date('2024-04-01').getTime(),
        updatedAt: new Date('2024-04-01').getTime(),
      }),
      mkSession({
        id: 'pb-2',
        title: 'Building the my-project-b prototype',
        startedAt: new Date('2024-04-05').getTime(),
        updatedAt: new Date('2024-04-05').getTime(),
      }),
      mkSession({
        id: 'pb-3',
        title: 'Iterating on my-project-b internals',
        startedAt: new Date('2024-04-10').getTime(),
        updatedAt: new Date('2024-04-10').getTime(),
      }),
      mkSession({
        id: 'pb-probe',
        title: 'Feasibility of my-project-b revival',
        startedAt: new Date('2025-08-01').getTime(),
        updatedAt: new Date('2025-08-01').getTime(),
      }),
    ];
    const projects = buildZombieProjects(sessions, NOW);
    const pb = projects.find((p) => p.id === 'my-project-b');
    expect(pb).toBeDefined();
    expect(pb!.classification).toBe('zombie');
    expect(pb!.inferenceSource).toBe('title_keyword');
  });
});

describe('buildZombiesFile envelope', () => {
  it('emits the prefix-prefixed envelope', () => {
    const file = buildZombiesFile([], 7777);
    expect(file.version).toBe(1);
    expect(file.tier).toBe('browser');
    expect(file.generatedAt).toBe(7777);
    expect(file.projects).toEqual([]);
  });
});
