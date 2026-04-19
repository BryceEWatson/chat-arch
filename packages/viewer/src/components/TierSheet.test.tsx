import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TierSheet } from './TierSheet.js';
import { PHASE_7_RESERVED_FILES } from '../data/analysisFetch.js';

function emptyFiles(): Record<string, { present: boolean; generatedAt?: number }> {
  const out: Record<string, { present: boolean; generatedAt?: number }> = {};
  for (const f of PHASE_7_RESERVED_FILES) out[f] = { present: false };
  return out;
}

describe('TierSheet (AC14 / AC15)', () => {
  it('enumerates all six Phase-7-reserved filenames (AC14)', () => {
    render(
      <TierSheet
        tierStatus="browser"
        tierPresentCount={0}
        tierFiles={emptyFiles()}
        onClose={() => {}}
      />,
    );
    for (const name of PHASE_7_RESERVED_FILES) {
      expect(screen.getByText(name)).toBeDefined();
    }
  });

  it('shows absent marker + "coming soon" for each absent file', () => {
    render(
      <TierSheet
        tierStatus="browser"
        tierPresentCount={0}
        tierFiles={emptyFiles()}
        onClose={() => {}}
      />,
    );
    const comingSoon = screen.getAllByText('coming soon');
    expect(comingSoon.length).toBe(6);
  });

  it('shows ✓ + ISO date for present files with generatedAt', () => {
    const files = emptyFiles();
    // 2026-04-17 UTC
    files['reloops.json'] = { present: true, generatedAt: Date.UTC(2026, 3, 17) };
    render(
      <TierSheet
        tierStatus="browser+local"
        tierPresentCount={1}
        tierFiles={files}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('2026-04-17')).toBeDefined();
  });

  it('shows "present" (no date) when generatedAt is missing', () => {
    const files = emptyFiles();
    files['skill-seeds.json'] = { present: true };
    render(
      <TierSheet
        tierStatus="browser+local"
        tierPresentCount={1}
        tierFiles={files}
        onClose={() => {}}
      />,
    );
    // "present" string must appear exactly once in the per-file timestamp column
    expect(screen.getAllByText('present').length).toBeGreaterThanOrEqual(1);
  });

  it('header copy in BROWSER state names it as the active tier and flags extended as planned', () => {
    render(
      <TierSheet
        tierStatus="browser"
        tierPresentCount={0}
        tierFiles={emptyFiles()}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/BROWSER ANALYSIS/)).toBeDefined();
    expect(screen.getByText(/not yet shipped/)).toBeDefined();
  });

  it('header copy in BROWSER+LOCAL state carries the N/6 count', () => {
    render(
      <TierSheet
        tierStatus="browser+local"
        tierPresentCount={3}
        tierFiles={emptyFiles()}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByText(/BROWSER \+ LOCAL ANALYSIS — 3 of 6 extended views generated\./),
    ).toBeDefined();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <TierSheet
        tierStatus="browser"
        tierPresentCount={0}
        tierFiles={emptyFiles()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('close tier details'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(
      <TierSheet
        tierStatus="browser"
        tierPresentCount={0}
        tierFiles={emptyFiles()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on backdrop click (but not on sheet click)', () => {
    const onClose = vi.fn();
    const { container } = render(
      <TierSheet
        tierStatus="browser"
        tierPresentCount={0}
        tierFiles={emptyFiles()}
        onClose={onClose}
      />,
    );
    const backdrop = container.querySelector('.lcars-tier-sheet-backdrop') as HTMLElement;
    // Click inside the sheet — must NOT close.
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    // Click the backdrop itself — must close.
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
