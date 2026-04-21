import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { CostMode } from './CostMode.js';

function entry(overrides: Partial<UnifiedSessionEntry>): UnifiedSessionEntry {
  return {
    id: 'id',
    source: 'cloud',
    rawSessionId: 'id',
    startedAt: 0,
    updatedAt: Date.UTC(2026, 3, 1),
    durationMs: 0,
    title: 'T',
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: 'claude-opus-4-7',
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

describe('CostMode (AC18)', () => {
  const sessions: UnifiedSessionEntry[] = [
    entry({ id: 's1', totalCostUsd: 5, updatedAt: Date.UTC(2026, 3, 1), project: 'alpha' }),
    entry({
      id: 's2',
      totalCostUsd: null,
      costEstimatedUsd: 3.5,
      costIsEstimate: true,
      updatedAt: Date.UTC(2026, 2, 15),
      project: 'beta',
    }),
    entry({
      id: 's3',
      totalCostUsd: null,
      costEstimatedUsd: 1.2,
      costIsEstimate: true,
      updatedAt: Date.UTC(2026, 2, 20),
      project: 'alpha',
    }),
  ];

  it('renders all four sections (AC18)', () => {
    render(<CostMode sessions={sessions} kpiEntry={null} onSelect={() => {}} />);
    expect(screen.getByText('COST PER MONTH')).toBeDefined();
    expect(screen.getByText('BY MODEL')).toBeDefined();
    expect(screen.getByText('BY PROJECT')).toBeDefined();
    expect(screen.getByText('TOP 20 EXPENSIVE SESSIONS')).toBeDefined();
  });

  it('renders COST · DIAGNOSED empty state when cost-diagnoses.json absent', () => {
    render(<CostMode sessions={sessions} kpiEntry={null} onSelect={() => {}} />);
    expect(screen.getByText('COST · DIAGNOSED')).toBeDefined();
  });

  it('hides COST · DIAGNOSED when costDiagnosedPresent=true', () => {
    render(
      <CostMode
        sessions={sessions}
        kpiEntry={null}
        onSelect={() => {}}
        costDiagnosedPresent={true}
      />,
    );
    expect(screen.queryByText('COST · DIAGNOSED')).toBeNull();
  });

  it('applies highlight class when kpiEntry is set ([R-D19])', () => {
    const { container } = render(
      <CostMode sessions={sessions} kpiEntry="stacked-bar" onSelect={() => {}} />,
    );
    const highlighted = container.querySelector('.lcars-cost-section--highlight');
    expect(highlighted).not.toBeNull();
    expect(highlighted!.getAttribute('data-section')).toBe('stacked-bar');
  });

  it('filters the top-20 table by tool name when toolFilter set', () => {
    const sessionsWithTools = [
      entry({ id: 'a', totalCostUsd: 10, topTools: { web_search: 3 } }),
      entry({ id: 'b', totalCostUsd: 5, topTools: { Read: 3 } }),
    ];
    render(
      <CostMode
        sessions={sessionsWithTools}
        kpiEntry="top-20"
        toolFilter="web_search"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/FILTERED TO web_search/)).toBeDefined();
  });

  it('drill-in: clicking a top-20 row calls onSelect', () => {
    const onSelect = vi.fn();
    const singleton = [entry({ id: 'hit', totalCostUsd: 20, title: 'Hit Session' })];
    render(<CostMode sessions={singleton} kpiEntry={null} onSelect={onSelect} />);
    // Click the row button whose aria-label opens the session title.
    const row = screen.getByRole('button', { name: /open Hit Session/ });
    row.click();
    expect(onSelect).toHaveBeenCalledWith('hit');
  });

  it('shows cloud-only notice when every visible session is source=cloud', () => {
    const cloudOnly = [
      entry({ id: 'c1', source: 'cloud' }),
      entry({ id: 'c2', source: 'cloud' }),
    ];
    render(<CostMode sessions={cloudOnly} kpiEntry={null} onSelect={() => {}} />);
    expect(screen.getByText(/CLOUD-ONLY DATA/)).toBeDefined();
  });

  it('hides cloud-only notice when any visible session is non-cloud', () => {
    const mixed = [
      entry({ id: 'a', source: 'cloud' }),
      entry({ id: 'b', source: 'cli-direct', totalCostUsd: 1 }),
    ];
    render(<CostMode sessions={mixed} kpiEntry={null} onSelect={() => {}} />);
    expect(screen.queryByText(/CLOUD-ONLY DATA/)).toBeNull();
  });

  it('hides cloud-only notice when there are no sessions', () => {
    render(<CostMode sessions={[]} kpiEntry={null} onSelect={() => {}} />);
    expect(screen.queryByText(/CLOUD-ONLY DATA/)).toBeNull();
  });
});
