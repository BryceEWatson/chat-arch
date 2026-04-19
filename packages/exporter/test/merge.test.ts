import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { mergeSources } from '../src/merge.js';

function mkCoworkEntry(id: string, updatedAt: number): UnifiedSessionEntry {
  return {
    id,
    source: 'cowork',
    rawSessionId: `local_${id}`,
    startedAt: updatedAt - 1000,
    updatedAt,
    durationMs: 1000,
    title: `session ${id}`,
    titleSource: 'manifest',
    preview: 'preview',
    userTurns: 2,
    model: 'claude-opus-4-7',
    cwdKind: 'vm',
    totalCostUsd: 0.12,
    costEstimatedUsd: 0.12,
    costIsEstimate: false,
  };
}

function mkCliDirectEntry(id: string, updatedAt: number): UnifiedSessionEntry {
  return {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    startedAt: updatedAt - 2000,
    updatedAt,
    durationMs: 2000,
    title: `cli ${id}`,
    titleSource: 'first-prompt',
    preview: 'cli preview',
    userTurns: 3,
    model: 'claude-sonnet-4-5',
    cwdKind: 'host',
    totalCostUsd: null,
    costEstimatedUsd: null,
    costIsEstimate: false,
    cwd: 'C:\\repo',
  };
}

function mkCliDesktopStub(id: string, updatedAt: number): UnifiedSessionEntry {
  // Phase 2's cli-desktop stub — minimal fields, no transcriptPath yet.
  return {
    id,
    source: 'cli-desktop',
    rawSessionId: `local_${id}`,
    startedAt: updatedAt - 500,
    updatedAt,
    durationMs: 500,
    title: `desktop ${id}`,
    titleSource: 'manifest',
    preview: null,
    userTurns: 0,
    model: null,
    cwdKind: 'host',
    totalCostUsd: null,
    costEstimatedUsd: null,
    costIsEstimate: false,
  };
}

function mkCliDesktopEnriched(id: string, updatedAt: number): UnifiedSessionEntry {
  // Phase 3's cli-desktop entry after transcript enrichment — more non-null fields.
  return {
    id,
    source: 'cli-desktop',
    rawSessionId: `local_${id}`,
    startedAt: updatedAt - 5000,
    updatedAt,
    durationMs: 5000,
    title: `desktop ${id}`,
    titleSource: 'manifest',
    preview: 'enriched preview',
    userTurns: 4,
    assistantTurns: 4,
    model: 'claude-opus-4-7',
    modelsUsed: ['claude-opus-4-7'],
    cwdKind: 'host',
    cwd: 'C:\\repo\\pkg',
    project: 'pkg',
    totalCostUsd: null,
    costEstimatedUsd: null,
    costIsEstimate: false,
    tokenTotals: { input: 100, output: 200, cacheCreation: 0, cacheRead: 0 },
    transcriptPath: 'local-transcripts/cli-desktop/' + id + '.jsonl',
    manifestPath: 'manifests/cli-desktop/local_' + id + '.json',
  };
}

function mkCloudEntry(id: string, updatedAt: number): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: updatedAt - 3000,
    updatedAt,
    durationMs: 3000,
    title: 'cloud session',
    titleSource: 'cloud-name',
    preview: 'cloud preview',
    userTurns: 5,
    assistantTurns: 5,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    costEstimatedUsd: null,
    costIsEstimate: false,
    transcriptPath: `cloud-conversations/${id}.json`,
  };
}

describe('mergeSources', () => {
  it('preserves all entries when there are no collisions', () => {
    const cowork = [mkCoworkEntry('aaaaaaaa-0000-0000-0000-000000000001', 3000)];
    const cli = [mkCliDirectEntry('bbbbbbbb-0000-0000-0000-000000000002', 2000)];
    const cloud = [mkCloudEntry('cccccccc-0000-0000-0000-000000000003', 1000)];

    const m = mergeSources(cowork, cli, cloud, 50000);
    expect(m.sessions).toHaveLength(3);
    expect(m.counts).toEqual({ cowork: 1, 'cli-direct': 1, 'cli-desktop': 0, cloud: 1 });
    expect(m.schemaVersion).toBe(2);
    expect(m.generatedAt).toBe(50000);
  });

  it('prefers the enriched cli-desktop entry over the Phase 2 stub (Phase 3 wins on richness)', () => {
    const id = 'dddddddd-0000-0000-0000-000000000004';
    const stub = mkCliDesktopStub(id, 1000);
    const enriched = mkCliDesktopEnriched(id, 1500);

    // Phase 2 emits the stub as part of `cowork` call (cli-desktop items are
    // in the cowork pipeline's output). Phase 3 re-emits the enriched entry
    // in the `cli` pipeline's output.
    const m = mergeSources([stub], [enriched], []);
    const desktop = m.sessions.filter((s) => s.source === 'cli-desktop');
    expect(desktop).toHaveLength(1);
    expect(desktop[0]!.userTurns).toBe(4);
    expect(desktop[0]!.transcriptPath).toBe('local-transcripts/cli-desktop/' + id + '.jsonl');
    expect(desktop[0]!.tokenTotals).toBeDefined();
    expect(m.counts['cli-desktop']).toBe(1);
  });

  it('handles empty source arrays cleanly', () => {
    const m = mergeSources([], [], []);
    expect(m.sessions).toEqual([]);
    expect(m.counts).toEqual({ cowork: 0, 'cli-direct': 0, 'cli-desktop': 0, cloud: 0 });
    expect(m.schemaVersion).toBe(2);
  });

  it('sorts sessions by updatedAt descending', () => {
    const cowork = [
      mkCoworkEntry('aaaaaaaa-0000-0000-0000-000000000010', 1_000_000),
      mkCoworkEntry('aaaaaaaa-0000-0000-0000-000000000011', 3_000_000),
    ];
    const cli = [mkCliDirectEntry('bbbbbbbb-0000-0000-0000-000000000012', 2_000_000)];
    const cloud = [mkCloudEntry('cccccccc-0000-0000-0000-000000000013', 4_000_000)];

    const m = mergeSources(cowork, cli, cloud);
    const updates = m.sessions.map((s) => s.updatedAt);
    expect(updates).toEqual([4_000_000, 3_000_000, 2_000_000, 1_000_000]);
  });

  it('emits all four source counts in the counts block', () => {
    const cowork = [
      mkCoworkEntry('aaaaaaaa-0000-0000-0000-000000000020', 1000),
      mkCoworkEntry('aaaaaaaa-0000-0000-0000-000000000021', 1100),
    ];
    const stub = mkCliDesktopStub('dddddddd-0000-0000-0000-000000000022', 1200);
    const enriched = mkCliDesktopEnriched('dddddddd-0000-0000-0000-000000000022', 1200);
    const direct = [mkCliDirectEntry('bbbbbbbb-0000-0000-0000-000000000023', 1300)];
    const cloud = [
      mkCloudEntry('cccccccc-0000-0000-0000-000000000024', 1400),
      mkCloudEntry('cccccccc-0000-0000-0000-000000000025', 1500),
      mkCloudEntry('cccccccc-0000-0000-0000-000000000026', 1600),
    ];

    const m = mergeSources([...cowork, stub], [...direct, enriched], cloud);
    expect(m.counts).toEqual({
      cowork: 2,
      'cli-direct': 1,
      'cli-desktop': 1,
      cloud: 3,
    });
  });
});
