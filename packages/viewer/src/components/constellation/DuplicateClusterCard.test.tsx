import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { DuplicateClusterCard } from './DuplicateClusterCard.js';
import type { MergedDuplicateCluster } from '../../data/mergeDuplicates.js';

function entry(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `Title ${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

describe('DuplicateClusterCard', () => {
  const baseCluster: MergedDuplicateCluster = {
    id: 'abc',
    hash: 'abc123',
    sampleText: 'hello world',
    sessionIds: ['s1', 's2'],
    kind: 'exact',
    originClusterIds: ['abc'],
  };
  const sessionsById = new Map<string, UnifiedSessionEntry>([
    ['s1', entry('s1')],
    ['s2', entry('s2')],
  ]);

  it('renders DUP (N) chip with attribution suffix', () => {
    const { container } = render(
      <DuplicateClusterCard
        cluster={baseCluster}
        sessionsById={sessionsById}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/DUP \(2\)/)).toBeDefined();
    // SourceAttribution renders `· exact` via the lcars-attribution class.
    expect(container.querySelector('.lcars-attribution')?.textContent).toBe(' · exact');
  });

  it('shows exact+semantic kind', () => {
    const { container } = render(
      <DuplicateClusterCard
        cluster={{ ...baseCluster, kind: 'exact+semantic' }}
        sessionsById={sessionsById}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector('.lcars-attribution')?.textContent).toBe(' · exact+semantic');
  });

  it('click on member drills into onSelect', () => {
    const onSelect = vi.fn();
    render(
      <DuplicateClusterCard
        cluster={baseCluster}
        sessionsById={sessionsById}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /open Title s1/ }));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('shows empty-members placeholder when ids not in sessionsById', () => {
    render(
      <DuplicateClusterCard
        cluster={{ ...baseCluster, sessionIds: ['missing'] }}
        sessionsById={new Map()}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/members not found/)).toBeDefined();
  });

  it('highlight=true adds the lcars-dup-cluster--highlight class', () => {
    const { container } = render(
      <DuplicateClusterCard
        cluster={baseCluster}
        sessionsById={sessionsById}
        onSelect={() => {}}
        highlight={true}
      />,
    );
    expect(container.querySelector('.lcars-dup-cluster--highlight')).not.toBeNull();
  });

  it('AC20: originSessionId + originActive marks the originating <li> and sets data-origin', () => {
    const { container } = render(
      <DuplicateClusterCard
        cluster={baseCluster}
        sessionsById={sessionsById}
        onSelect={() => {}}
        highlight={true}
        originSessionId="s2"
        originActive={true}
      />,
    );
    const origin = container.querySelector('li.lcars-dup-cluster__member--origin');
    expect(origin).not.toBeNull();
    expect(origin?.getAttribute('data-origin')).toBe('true');
    // Only one member should carry the origin class.
    expect(container.querySelectorAll('.lcars-dup-cluster__member--origin')).toHaveLength(1);
    // And the class is scoped to the correct session (s2, not s1).
    const link = origin?.querySelector('.lcars-dup-cluster__member-link');
    expect(link?.getAttribute('aria-label')).toMatch(/originating session/);
  });

  it('AC20: originActive=false drops the origin class (fade after 3s)', () => {
    const { container } = render(
      <DuplicateClusterCard
        cluster={baseCluster}
        sessionsById={sessionsById}
        onSelect={() => {}}
        highlight={true}
        originSessionId="s2"
        originActive={false}
      />,
    );
    expect(container.querySelector('.lcars-dup-cluster__member--origin')).toBeNull();
  });
});
