import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { UpperPanel } from './UpperPanel.js';

function entry(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `T ${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

function manifest(entries: UnifiedSessionEntry[]): SessionManifest {
  return {
    schemaVersion: 2,
    generatedAt: 0,
    counts: {
      cloud: entries.filter((e) => e.source === 'cloud').length,
      cowork: entries.filter((e) => e.source === 'cowork').length,
      'cli-direct': entries.filter((e) => e.source === 'cli-direct').length,
      'cli-desktop': entries.filter((e) => e.source === 'cli-desktop').length,
    },
    sessions: entries,
  };
}

const base = {
  sourceFilter: new Set<UnifiedSessionEntry['source']>(),
  onToggleSource: () => {},
  onClearFilters: () => {},
  projectFilter: new Set<string>(),
  onToggleProject: () => {},
  unknownProjectActive: false,
  onToggleUnknownProject: () => {},
  showEmpty: false,
  onToggleShowEmpty: () => {},
};

describe('UpperPanel KPI strip (AC7)', () => {
  it('renders all four KPIs: COST, TOKENS, TOP TOOL, TOP PROJECT', () => {
    const entries = [
      entry('a', {
        totalCostUsd: 5,
        tokenTotals: { input: 0, output: 100, cacheCreation: 0, cacheRead: 0 },
        project: 'alpha',
        topTools: { web_search: 3 },
      }),
      entry('b', {
        totalCostUsd: null,
        costEstimatedUsd: 2.3,
        costIsEstimate: true,
        tokenTotals: { input: 0, output: 200, cacheCreation: 0, cacheRead: 0 },
        project: 'alpha',
      }),
    ];
    const m = manifest(entries);
    render(<UpperPanel manifest={m} filtered={entries} onKpiClick={() => {}} {...base} />);
    expect(screen.getByText('COST')).toBeDefined();
    expect(screen.getByText('TOKENS')).toBeDefined();
    expect(screen.getByText('TOP TOOL')).toBeDefined();
    expect(screen.getByText('TOP PROJECT')).toBeDefined();
    // Exact + estimate separated in the COST value.
    expect(screen.getByText(/\$5\.00 \+ \$2\.30 est/)).toBeDefined();
    // Top tool is web_search.
    expect(screen.getByText('web_search')).toBeDefined();
    // Top project is alpha — rendered in both the TOP PROJECT KPI value
    // AND as a project pill. Expect both occurrences.
    const alphas = screen.getAllByText(/alpha/);
    expect(alphas.length).toBeGreaterThanOrEqual(1);
  });

  it('shows coverage disclosure when <30% of sessions have a resolved project ([R-D9])', () => {
    // 1 tagged out of 5 = 20% — below 30% threshold.
    const entries = [
      entry('a', { project: 'alpha' }),
      entry('b'),
      entry('c'),
      entry('d'),
      entry('e'),
    ];
    render(
      <UpperPanel
        manifest={manifest(entries)}
        filtered={entries}
        onKpiClick={() => {}}
        {...base}
      />,
    );
    expect(screen.getByText(/\(1 of 5 tagged\)/)).toBeDefined();
  });

  it('hides the coverage disclosure when ≥30% tagged', () => {
    const entries = [
      entry('a', { project: 'alpha' }),
      entry('b', { project: 'alpha' }),
      entry('c'),
    ];
    render(
      <UpperPanel
        manifest={manifest(entries)}
        filtered={entries}
        onKpiClick={() => {}}
        {...base}
      />,
    );
    expect(screen.queryByText(/tagged\)/)).toBeNull();
  });

  it('KPI click calls onKpiClick with the correct section + toolFilter', () => {
    const onKpiClick = vi.fn();
    const entries = [entry('a', { totalCostUsd: 10, topTools: { Read: 5 } })];
    render(
      <UpperPanel
        manifest={manifest(entries)}
        filtered={entries}
        onKpiClick={onKpiClick}
        {...base}
      />,
    );
    fireEvent.click(screen.getByText('COST').closest('[role="button"]')!);
    expect(onKpiClick).toHaveBeenCalledWith('stacked-bar');
    fireEvent.click(screen.getByText('TOKENS').closest('[role="button"]')!);
    expect(onKpiClick).toHaveBeenCalledWith('by-model');
    fireEvent.click(screen.getByText('TOP TOOL').closest('[role="button"]')!);
    expect(onKpiClick).toHaveBeenCalledWith('top-20', 'Read');
    fireEvent.click(screen.getByText('TOP PROJECT').closest('[role="button"]')!);
    expect(onKpiClick).toHaveBeenCalledWith('by-project');
  });
});

// UpperPanel no longer renders source/project/zero-turn pills; those
// moved into `FilterBar`. See `FilterBar.test.tsx` for the equivalent
// coverage of project pills (AC12) and the zero-turn toggle (AC11).
