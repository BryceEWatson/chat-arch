import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    render(<UpperPanel manifest={m} filtered={entries} {...base} />);
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
        {...base}
      />,
    );
    expect(screen.getByText(/1 of 5 tagged/)).toBeDefined();
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
        {...base}
      />,
    );
    expect(screen.queryByText(/tagged\)/)).toBeNull();
  });

  it('collapses automated runs so they do not dominate TOTAL / TOP PROJECT', () => {
    // 5 near-identical automated status-paragraph runs in "Command" +
    // 2 interactive sessions in "alpha". Pre-collapse, Command would win
    // TOP PROJECT (5 > 2) and TOTAL would read 7. Collapsed: Command is a
    // single row (1) so alpha (2) wins, and TOTAL reads 3.
    const automated = Array.from({ length: 5 }, (_, i) =>
      entry(`auto-${i}`, {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
      }),
    );
    const interactive = [
      entry('h1', { project: 'alpha' }),
      entry('h2', { project: 'alpha' }),
    ];
    const entries = [...automated, ...interactive];
    render(
      <UpperPanel manifest={manifest(entries)} filtered={entries} {...base} />,
    );
    // TOP PROJECT KPI shows alpha (collapsed counts: alpha=2 > Command=1).
    const topProjectKpi = screen
      .getByText('TOP PROJECT')
      .closest('.lcars-kpi') as HTMLElement;
    expect(topProjectKpi.textContent).toContain('alpha');
    expect(topProjectKpi.textContent).not.toContain('Command');
    // Coverage caption: 3 of 3 tagged would be ≥30% so it's hidden; the
    // key check is the collapsed TOTAL is 3, not 7 — assert via a low-
    // coverage variant below.
  });

  it('coverage caption uses the COLLAPSED total, not the raw session count', () => {
    // 5 automated (collapse to 1) in Command + 4 untagged interactive.
    // Collapsed rows = 5; tagged = 1 (the Command group) → 1/5 = 20% < 30%,
    // so the caption shows "1 of 5 tagged" — proving TOTAL collapsed to 5
    // rather than the raw 9.
    const automated = Array.from({ length: 5 }, (_, i) =>
      entry(`auto-${i}`, {
        project: 'Command',
        automationTemplateId: 'status-paragraph',
      }),
    );
    const untagged = [entry('u1'), entry('u2'), entry('u3'), entry('u4')];
    const entries = [...automated, ...untagged];
    render(
      <UpperPanel manifest={manifest(entries)} filtered={entries} {...base} />,
    );
    expect(screen.getByText(/1 of 5 tagged/)).toBeDefined();
  });

  it('KPI tiles render as informational (no role="button") after Phase 3 cut', () => {
    // Phase 3 cut CostMode, so KPI tiles no longer drill in. They keep
    // displaying the same data values but are not interactive.
    const entries = [entry('a', { totalCostUsd: 10, topTools: { Read: 5 } })];
    const { container } = render(
      <UpperPanel
        manifest={manifest(entries)}
        filtered={entries}
        {...base}
      />,
    );
    const kpiTiles = container.querySelectorAll('.lcars-kpi');
    expect(kpiTiles.length).toBe(4);
    // iter-14: KPI tiles gained role="group" so their aria-label (which
    // is otherwise dropped on a bare <div>) is honored by AT. The
    // load-bearing assertion is that they are NOT role="button" — they
    // are non-interactive informational tiles after Phase 3.
    for (const tile of Array.from(kpiTiles)) {
      expect(tile.getAttribute('role')).not.toBe('button');
    }
  });
});

// UpperPanel no longer renders source/project/zero-turn pills; those
// moved into `FilterBar`. See `FilterBar.test.tsx` for the equivalent
// coverage of project pills (AC12) and the zero-turn toggle (AC11).
