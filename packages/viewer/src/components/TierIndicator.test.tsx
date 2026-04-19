import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TierIndicator } from './TierIndicator.js';
import { PHASE_7_RESERVED_FILES } from '../data/analysisFetch.js';

function files(
  preset: 'none' | 'one' | 'three' | 'all',
): Record<string, { present: boolean; generatedAt?: number }> {
  const out: Record<string, { present: boolean; generatedAt?: number }> = {};
  for (const name of PHASE_7_RESERVED_FILES) out[name] = { present: false };
  if (preset === 'one') out['duplicates.semantic.json'] = { present: true, generatedAt: 1 };
  if (preset === 'three') {
    out['duplicates.semantic.json'] = { present: true, generatedAt: 1 };
    out['reloops.json'] = { present: true, generatedAt: 2 };
    out['cost-diagnoses.json'] = { present: true, generatedAt: 3 };
  }
  if (preset === 'all') {
    for (const name of PHASE_7_RESERVED_FILES) out[name] = { present: true, generatedAt: 1 };
  }
  return out;
}

describe('TierIndicator ([R-D17], AC14, AC15)', () => {
  it('renders "BROWSER ANALYSIS" (exact load-bearing copy) in browser state', () => {
    render(<TierIndicator tierStatus="browser" tierPresentCount={0} tierFiles={files('none')} />);
    // The word ANALYSIS is load-bearing — do NOT render bare "BROWSER".
    expect(screen.getByText('BROWSER ANALYSIS')).toBeDefined();
  });

  it('does NOT render "(0/6)" in the BROWSER state (count only appears in BROWSER+LOCAL)', () => {
    render(<TierIndicator tierStatus="browser" tierPresentCount={0} tierFiles={files('none')} />);
    expect(screen.queryByText(/\(\d\/6\)/)).toBeNull();
  });

  it('renders "BROWSER + LOCAL ANALYSIS (1/6)" with one file present', () => {
    render(
      <TierIndicator tierStatus="browser+local" tierPresentCount={1} tierFiles={files('one')} />,
    );
    expect(screen.getByText('BROWSER + LOCAL ANALYSIS (1/6)')).toBeDefined();
  });

  it('renders "BROWSER + LOCAL ANALYSIS (3/6)" with three files present', () => {
    render(
      <TierIndicator tierStatus="browser+local" tierPresentCount={3} tierFiles={files('three')} />,
    );
    expect(screen.getByText('BROWSER + LOCAL ANALYSIS (3/6)')).toBeDefined();
  });

  it('renders "BROWSER + LOCAL ANALYSIS (6/6)" with all files present', () => {
    render(
      <TierIndicator tierStatus="browser+local" tierPresentCount={6} tierFiles={files('all')} />,
    );
    expect(screen.getByText('BROWSER + LOCAL ANALYSIS (6/6)')).toBeDefined();
  });

  it('applies the --browser class in browser state (drives #665544 full-opacity palette)', () => {
    const { container } = render(
      <TierIndicator tierStatus="browser" tierPresentCount={0} tierFiles={files('none')} />,
    );
    expect(container.querySelector('.lcars-tier-indicator--browser')).not.toBeNull();
    expect(container.querySelector('.lcars-tier-indicator--local')).toBeNull();
  });

  it('applies the --local class in browser+local state (drives #CC99CC full-opacity palette)', () => {
    const { container } = render(
      <TierIndicator tierStatus="browser+local" tierPresentCount={1} tierFiles={files('one')} />,
    );
    expect(container.querySelector('.lcars-tier-indicator--local')).not.toBeNull();
    expect(container.querySelector('.lcars-tier-indicator--browser')).toBeNull();
  });

  it('is keyboard-focusable and opens TierSheet on Enter (AC15)', () => {
    render(<TierIndicator tierStatus="browser" tierPresentCount={0} tierFiles={files('none')} />);
    const pill = screen.getByRole('button', { name: /analysis tier/i });
    expect(pill.getAttribute('tabIndex')).toBe('0');
    fireEvent.keyDown(pill, { key: 'Enter' });
    // Sheet opens → dialog present
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('opens TierSheet on click and closes on Escape (AC15)', () => {
    render(
      <TierIndicator tierStatus="browser+local" tierPresentCount={1} tierFiles={files('one')} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /analysis tier/i }));
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('TierSheet enumerates all six reserved filenames when open (AC14)', () => {
    render(<TierIndicator tierStatus="browser" tierPresentCount={0} tierFiles={files('none')} />);
    fireEvent.click(screen.getByRole('button', { name: /analysis tier/i }));
    for (const filename of PHASE_7_RESERVED_FILES) {
      expect(screen.getByText(filename)).toBeDefined();
    }
  });

  it('advertises aria-haspopup and aria-expanded correctly', () => {
    render(<TierIndicator tierStatus="browser" tierPresentCount={0} tierFiles={files('none')} />);
    const pill = screen.getByRole('button', { name: /analysis tier/i });
    expect(pill.getAttribute('aria-haspopup')).toBe('dialog');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(pill);
    expect(pill.getAttribute('aria-expanded')).toBe('true');
  });
});
