import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { ConstellationMode } from './ConstellationMode.js';
import type { MergedDuplicateCluster } from '../../data/mergeDuplicates.js';
import type { ZombieProject } from '../constellation/ZombieProjectCard.js';

function entry(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `Session ${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

function cluster(id: string, sessionIds: string[]): MergedDuplicateCluster {
  return {
    id,
    hash: 'hash',
    sampleText: 'sample',
    sessionIds,
    kind: 'exact',
    originClusterIds: [id],
  };
}

const zombie: ZombieProject = {
  id: 'my-project-c',
  displayName: 'my-project-c',
  sessionCount: 19,
  firstActiveAt: 0,
  lastActiveAt: 0,
  daysSinceLast: 328,
  classification: 'zombie',
  probeSessionIds: ['s1'],
  burstWindows: [{ start: 0, end: 10, count: 5 }],
  inferenceSource: 'title_keyword',
};

describe('ConstellationMode (AC19)', () => {
  it('renders duplicate-cluster cards, zombie cards, and one collapsed accordion (AC19)', () => {
    const clusters = [cluster('c1', ['a', 'b'])];
    render(
      <ConstellationMode
        sessions={[entry('a'), entry('b')]}
        mergedClusters={clusters}
        zombieProjects={[zombie]}
        tierFiles={{}}
        highlightClusterId={null}
        zombieFilterActive={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/EXACT DUPLICATES \(1\)/)).toBeDefined();
    // Header is now `PROJECT LIFECYCLE (N zombie · M dormant · K active)`
    // (UX finding 5a). With one zombie project fixture: `1 zombie · 0 dormant · 0 active`.
    expect(screen.getByText(/PROJECT LIFECYCLE \(1 zombie · 0 dormant · 0 active\)/)).toBeDefined();
    // Accordion collapsed by default with the [+] prefix.
    expect(screen.getByText(/UNLOCK WITH LOCAL ANALYSIS/)).toBeDefined();
    expect(screen.getByText(/\[\+\]/)).toBeDefined();
    // The three tier-2 sub-sections are NOT in the DOM while collapsed.
    expect(screen.queryByText(/SEMANTIC CLUSTERS/)).toBeNull();
  });

  it('expanding the accordion reveals three LocalAnalyzerEmpty sub-sections', () => {
    render(
      <ConstellationMode
        sessions={[]}
        mergedClusters={[]}
        zombieProjects={[]}
        tierFiles={{}}
        highlightClusterId={null}
        zombieFilterActive={false}
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/UNLOCK WITH LOCAL ANALYSIS/));
    expect(screen.getByText(/SEMANTIC CLUSTERS/)).toBeDefined();
    expect(screen.getByText(/RE-SOLVED PROBLEMS/)).toBeDefined();
    expect(screen.getByText(/ABANDONMENT DIAGNOSIS/)).toBeDefined();
  });

  it('auto-expands accordion when a tier-2 file is already present', () => {
    render(
      <ConstellationMode
        sessions={[]}
        mergedClusters={[]}
        zombieProjects={[]}
        tierFiles={{ 'duplicates.semantic.json': { present: true } }}
        highlightClusterId={null}
        zombieFilterActive={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/SEMANTIC CLUSTERS/)).toBeDefined();
  });

  it('zombieFilterActive narrows the zombie list to classification="zombie"', () => {
    const dormant: ZombieProject = {
      ...zombie,
      id: 'beta',
      displayName: 'beta',
      classification: 'dormant',
    };
    render(
      <ConstellationMode
        sessions={[]}
        mergedClusters={[]}
        zombieProjects={[zombie, dormant]}
        tierFiles={{}}
        highlightClusterId={null}
        zombieFilterActive={true}
        onSelect={() => {}}
      />,
    );
    // Header reports the overall lifecycle histogram regardless of filter.
    // Fixture: 1 zombie + 1 dormant + 0 active.
    expect(screen.getByText(/PROJECT LIFECYCLE \(1 zombie · 1 dormant · 0 active\)/)).toBeDefined();
    expect(screen.getByText(/FILTERED TO ZOMBIE/)).toBeDefined();
    // Only the zombie card renders in the grid (dormant is filtered out).
    expect(screen.getByText('my-project-c')).toBeDefined();
    expect(screen.queryByText('beta')).toBeNull();
  });

  it('lifecycle header count matches classification split (UX finding 5a)', () => {
    const dormant: ZombieProject = {
      ...zombie,
      id: 'beta',
      displayName: 'beta',
      classification: 'dormant',
    };
    const active: ZombieProject = {
      ...zombie,
      id: 'gamma',
      displayName: 'gamma',
      classification: 'active',
    };
    render(
      <ConstellationMode
        sessions={[]}
        mergedClusters={[]}
        zombieProjects={[zombie, dormant, active]}
        tierFiles={{}}
        highlightClusterId={null}
        zombieFilterActive={false}
        onSelect={() => {}}
      />,
    );
    // Default view shows zombie only (1 card rendered), with a Show N toggle.
    expect(screen.getByText(/PROJECT LIFECYCLE \(1 zombie · 1 dormant · 1 active\)/)).toBeDefined();
    expect(screen.getByText(/Show 2 dormant \/ active projects/)).toBeDefined();
    // Only zombie is rendered by default.
    expect(screen.getByText('my-project-c')).toBeDefined();
    expect(screen.queryByText('beta')).toBeNull();
    // Toggling reveals all.
    fireEvent.click(screen.getByText(/Show 2 dormant \/ active projects/));
    expect(screen.getByText('beta')).toBeDefined();
    expect(screen.getByText('gamma')).toBeDefined();
  });

  it('renders empty state text when mergedClusters is empty (tier-1 file absent)', () => {
    render(
      <ConstellationMode
        sessions={[]}
        mergedClusters={[]}
        zombieProjects={[]}
        tierFiles={{}}
        highlightClusterId={null}
        zombieFilterActive={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/No duplicate clusters/)).toBeDefined();
  });

  it('cluster click drills into a session via onSelect', () => {
    const onSelect = vi.fn();
    render(
      <ConstellationMode
        sessions={[entry('a'), entry('b')]}
        mergedClusters={[cluster('c1', ['a', 'b'])]}
        zombieProjects={[]}
        tierFiles={{}}
        highlightClusterId={null}
        zombieFilterActive={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /open Session a/ }));
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});
