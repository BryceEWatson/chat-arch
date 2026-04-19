import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceAttribution } from './SourceAttribution.js';

describe('SourceAttribution', () => {
  it('renders "· exact"', () => {
    render(<SourceAttribution kind="exact" />);
    expect(screen.getByText(/·\s*exact/)).toBeDefined();
  });

  it('renders "· heuristic"', () => {
    render(<SourceAttribution kind="heuristic" />);
    expect(screen.getByText(/·\s*heuristic/)).toBeDefined();
  });

  it('renders "· estimate"', () => {
    render(<SourceAttribution kind="estimate" />);
    expect(screen.getByText(/·\s*estimate/)).toBeDefined();
  });

  it('renders "· exact+semantic" (merged state per R-D14)', () => {
    render(<SourceAttribution kind="exact+semantic" />);
    expect(screen.getByText(/·\s*exact\+semantic/)).toBeDefined();
  });

  it('renders "· semantic"', () => {
    render(<SourceAttribution kind="semantic" />);
    expect(screen.getByText(/·\s*semantic/)).toBeDefined();
  });

  it('renders "· diagnosed"', () => {
    render(<SourceAttribution kind="diagnosed" />);
    expect(screen.getByText(/·\s*diagnosed/)).toBeDefined();
  });

  it('applies the lcars-attribution class (dim palette at 0.7 opacity per R-D18)', () => {
    const { container } = render(<SourceAttribution kind="exact" />);
    const span = container.querySelector('.lcars-attribution');
    expect(span).not.toBeNull();
  });

  it('exposes an aria-label for assistive tech (default uses kind)', () => {
    render(<SourceAttribution kind="exact" />);
    expect(screen.getByLabelText('source: exact')).toBeDefined();
  });

  it('respects the ariaLabel override', () => {
    render(<SourceAttribution kind="exact" ariaLabel="duplicate cluster: exact match" />);
    expect(screen.getByLabelText('duplicate cluster: exact match')).toBeDefined();
  });
});
