import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { SessionCard } from './SessionCard.js';

function base(overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  // Default source is cli-direct (not cloud) so the default fixture exercises
  // the 4-cell meta grid. Cloud cards hide MODEL+COST entirely, so tests
  // that need to pin those cells' behavior would silently pass on a cloud
  // fixture if we defaulted there. Cloud-specific cases explicitly override.
  return {
    id: 'id-1',
    source: 'cli-direct',
    rawSessionId: 'id-1',
    startedAt: 1700000000000,
    updatedAt: 1700000000000,
    durationMs: 0,
    title: 'Sample title',
    titleSource: 'cloud-name',
    preview: 'preview body',
    userTurns: 4,
    model: 'claude-opus-4-7',
    cwdKind: 'none',
    totalCostUsd: 1.23,
    ...overrides,
  } as UnifiedSessionEntry;
}

/**
 * Helper: match a label/value pair inside the session-card meta grid. The
 * grid renders `<dt>LABEL</dt><dd>VALUE</dd>` as siblings, so we assert
 * on the parent cell's flattened text content.
 */
function findMetaCell(label: string): HTMLElement | null {
  const dts = Array.from(document.querySelectorAll('.lcars-session-card__meta-cell'));
  return (dts.find((el) => el.querySelector('dt')?.textContent === label) as HTMLElement) ?? null;
}

function metaValue(label: string): string {
  const cell = findMetaCell(label);
  return cell?.querySelector('dd')?.textContent ?? '';
}

describe('SessionCard', () => {
  it('renders title, preview, model, cost, turns', () => {
    render(<SessionCard session={base({ assistantTurns: 9 })} onSelect={() => {}} />);
    expect(screen.getByText('Sample title')).toBeDefined();
    expect(screen.getByText('preview body')).toBeDefined();
    expect(metaValue('MODEL')).toMatch(/claude-opus-4-7/);
    expect(metaValue('COST')).toMatch(/\$1\.23/);
    // TURNS shows both user and assistant counts (R10 F10.1).
    expect(metaValue('TURNS')).toBe('4→9');
  });

  it('renders em-dash for the assistant half when assistantTurns is absent (R10 F10.1)', () => {
    render(<SessionCard session={base()} onSelect={() => {}} />);
    // userTurns=4, assistantTurns=undefined → "4→—"
    expect(metaValue('TURNS')).toBe('4→—');
  });

  it('renders bare em-dash for null model and null cost on non-cloud sources', () => {
    // Non-cloud sources: missing data is actually missing (not "structurally
    // unavailable"), so no attribution suffix — the em-dash stands alone.
    render(
      <SessionCard
        session={base({
          source: 'cli-direct',
          model: null,
          totalCostUsd: null,
          topTools: undefined,
        })}
        onSelect={() => {}}
      />,
    );
    expect(metaValue('MODEL')).toBe('—');
    expect(metaValue('COST')).toBe('—');
  });

  it('hides MODEL and COST cells entirely for cloud sessions', () => {
    // Cloud conversations genuinely can't have model or cost data (claude.ai
    // exports don't carry them, and running the CLI won't recover it). A
    // permanently-empty cell reads as a bug, so the cells are omitted and
    // the meta grid shrinks to TURNS + TOOLS.
    render(
      <SessionCard
        session={base({
          source: 'cloud',
          model: null,
          totalCostUsd: null,
          costEstimatedUsd: null,
          topTools: undefined,
        })}
        onSelect={() => {}}
      />,
    );
    expect(findMetaCell('MODEL')).toBeNull();
    expect(findMetaCell('COST')).toBeNull();
    // TURNS and TOOLS still render.
    expect(findMetaCell('TURNS')).not.toBeNull();
    expect(findMetaCell('TOOLS')).not.toBeNull();
  });

  it('exposes data-source attribute on the card root for CSS targeting', () => {
    // The meta-grid uses `[data-source="cloud"]` to flip to a 2-col grid
    // (TURNS + TOOLS only). Pin the selector hook so CSS refactors that
    // break it surface here rather than as an ugly regression in the UI.
    const { container } = render(
      <SessionCard session={base({ source: 'cloud' })} onSelect={() => {}} />,
    );
    const card = container.querySelector('.lcars-session-card') as HTMLElement;
    expect(card.getAttribute('data-source')).toBe('cloud');
  });

  it('keeps the generic em-dash tooltip for non-cloud sessions', () => {
    render(
      <SessionCard
        session={base({
          source: 'cli-direct',
          model: null,
          totalCostUsd: null,
          costEstimatedUsd: null,
          topTools: undefined,
        })}
        onSelect={() => {}}
      />,
    );
    const modelCell = findMetaCell('MODEL')!.querySelector('dd')!;
    const costCell = findMetaCell('COST')!.querySelector('dd')!;
    expect(modelCell.getAttribute('title')).toBe('No model recorded');
    expect(costCell.getAttribute('title')).toMatch(/No cost signal/);
  });

  it('renders (no preview) when preview is null', () => {
    render(<SessionCard session={base({ preview: null })} onSelect={() => {}} />);
    expect(screen.getByText('(no preview)')).toBeDefined();
  });

  it('renders $0.00 for meaningful zero cost', () => {
    render(<SessionCard session={base({ totalCostUsd: 0 })} onSelect={() => {}} />);
    expect(metaValue('COST')).toMatch(/\$0\.00/);
  });

  it('renders em-dash for empty topTools object', () => {
    render(<SessionCard session={base({ topTools: {} })} onSelect={() => {}} />);
    expect(metaValue('TOOLS')).toBe('—');
  });

  it('renders top tools sorted by count', () => {
    render(
      <SessionCard
        session={base({ topTools: { Read: 2, Edit: 10, Grep: 5 } })}
        onSelect={() => {}}
      />,
    );
    expect(metaValue('TOOLS')).toMatch(/Edit×10\s+Grep×5\s+Read×2/);
  });

  it('calls onSelect on click', () => {
    const onSelect = vi.fn();
    render(<SessionCard session={base()} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /open Sample title/ }));
    expect(onSelect).toHaveBeenCalledWith('id-1');
  });

  it('calls onSelect on Enter key', () => {
    const onSelect = vi.fn();
    render(<SessionCard session={base()} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /open Sample title/ }), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('id-1');
  });

  it('calls onSelect on Space key', () => {
    const onSelect = vi.fn();
    render(<SessionCard session={base()} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /open Sample title/ }), { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('id-1');
  });

  it('does not crash on empty-title entries (fallback to Untitled session)', () => {
    render(<SessionCard session={base({ title: '' })} onSelect={() => {}} />);
    expect(screen.getByText('Untitled session')).toBeDefined();
  });

  it('renders project label with ↳ prefix when session.project is set', () => {
    const { container } = render(
      <SessionCard session={base({ project: 'my-project-b' })} onSelect={() => {}} />,
    );
    const label = container.querySelector('.lcars-session-card__project');
    expect(label?.textContent).toContain('my-project-b');
    expect(label?.textContent).toContain('↳');
  });

  it('renders DUP chip with member count and attribution when duplicateInfo is set', () => {
    const cluster = {
      id: 'c1',
      hash: 'h',
      sampleText: 't',
      sessionIds: ['a', 'b', 'c'],
      kind: 'exact' as const,
      originClusterIds: ['c1'],
    };
    render(
      <SessionCard
        session={base()}
        onSelect={() => {}}
        duplicateInfo={{ cluster, memberCount: 3 }}
      />,
    );
    expect(screen.getByText(/DUP \(3\)/)).toBeDefined();
  });

  it('DUP chip click fires onDuplicateChipClick, not onSelect (AC20)', () => {
    const cluster = {
      id: 'c99',
      hash: 'h',
      sampleText: 't',
      sessionIds: ['id-1', 'x'],
      kind: 'exact' as const,
      originClusterIds: ['c99'],
    };
    const onSelect = vi.fn();
    const onDup = vi.fn();
    render(
      <SessionCard
        session={base()}
        onSelect={onSelect}
        duplicateInfo={{ cluster, memberCount: 2 }}
        onDuplicateChipClick={onDup}
      />,
    );
    fireEvent.click(screen.getByText(/DUP \(2\)/));
    expect(onDup).toHaveBeenCalledWith('c99', 'id-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ZOMBIE chip click fires onZombieChipClick (AC21)', () => {
    const onZombie = vi.fn();
    render(
      <SessionCard
        session={base({ project: 'my-project-c' })}
        onSelect={() => {}}
        isZombieProject={true}
        onZombieChipClick={onZombie}
      />,
    );
    fireEvent.click(screen.getByText('ZOMBIE'));
    expect(onZombie).toHaveBeenCalledWith('id-1');
  });

  it('COST renders · estimate suffix for estimate-only sessions', () => {
    const { container } = render(
      <SessionCard
        session={base({ totalCostUsd: null, costEstimatedUsd: 1.23, costIsEstimate: true })}
        onSelect={() => {}}
      />,
    );
    const attr = container.querySelectorAll('.lcars-attribution');
    expect(Array.from(attr).some((e) => e.textContent === ' · estimate')).toBe(true);
  });
});
