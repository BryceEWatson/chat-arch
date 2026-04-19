import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { Sparkline } from './Sparkline.js';

function base(
  id: string,
  updatedAt: number,
  source: UnifiedSessionEntry['source'] = 'cloud',
): UnifiedSessionEntry {
  return {
    id,
    source,
    rawSessionId: id,
    startedAt: updatedAt,
    updatedAt,
    durationMs: 0,
    title: `s-${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
  } as UnifiedSessionEntry;
}

describe('Sparkline', () => {
  it('renders empty-state when given no sessions', () => {
    render(<Sparkline allSessions={[]} visibleSessions={[]} />);
    expect(screen.getByText('NO ACTIVITY')).toBeDefined();
  });

  it('renders one bar per non-empty week', () => {
    const sunday = Date.UTC(2026, 3, 5, 0, 0, 0);
    const WEEK = 7 * 86_400_000;
    const all = [
      base('a', sunday),
      base('b', sunday + 86_400_000),
      base('c', sunday + WEEK),
      base('d', sunday + 2 * WEEK),
    ];
    const { container } = render(<Sparkline allSessions={all} visibleSessions={all} />);
    const bars = container.querySelectorAll('rect.lcars-sparkline__bar');
    expect(bars.length).toBe(3);
  });

  it('dims bars whose week has no visible session', () => {
    const sunday = Date.UTC(2026, 3, 5, 0, 0, 0);
    const WEEK = 7 * 86_400_000;
    const all = [base('a', sunday), base('b', sunday + WEEK), base('c', sunday + 2 * WEEK)];
    const visible = [all[0]!, all[2]!]; // middle week is missing
    const { container } = render(<Sparkline allSessions={all} visibleSessions={visible} />);
    const bars = Array.from(container.querySelectorAll('rect.lcars-sparkline__bar'));
    // second bar should have the dim class
    expect(bars[1]!.classList.contains('lcars-sparkline__bar--dim')).toBe(true);
    expect(bars[0]!.classList.contains('lcars-sparkline__bar--dim')).toBe(false);
  });

  it('axis shows first and last week labels', () => {
    const sunday = Date.UTC(2026, 3, 5, 0, 0, 0);
    const WEEK = 7 * 86_400_000;
    const all = [base('a', sunday), base('b', sunday + 2 * WEEK)];
    render(<Sparkline allSessions={all} visibleSessions={all} />);
    // Two axis labels present.
    expect(screen.getByText('Apr 5')).toBeDefined();
    expect(screen.getByText('Apr 19')).toBeDefined();
  });
});
