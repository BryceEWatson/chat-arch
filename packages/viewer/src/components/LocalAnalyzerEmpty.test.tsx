import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocalAnalyzerEmpty } from './LocalAnalyzerEmpty.js';

describe('LocalAnalyzerEmpty (AC17)', () => {
  it('renders the section title', () => {
    render(<LocalAnalyzerEmpty title="SEMANTIC CLUSTERS" estCostUsd={2.5} sessionCount={1464} />);
    expect(screen.getByText('SEMANTIC CLUSTERS')).toBeDefined();
  });

  it('renders the exact CTA format with interpolated cost + session count', () => {
    render(<LocalAnalyzerEmpty title="X" estCostUsd={2.5} sessionCount={1464} />);
    // AC17: CTA text must include the install hint, pnpm analyze, and
    // the estimated cost against the manifest session count.
    expect(
      screen.getByText(
        /LOCAL ANALYZER REQUIRED — install chat-arch-analyzer skill and run 'pnpm analyze'\. Est\. cost ~\$2\.50 against your current 1,464-session manifest\./,
      ),
    ).toBeDefined();
  });

  it('formats session count with thousands separator', () => {
    render(<LocalAnalyzerEmpty title="X" estCostUsd={1} sessionCount={1464} />);
    expect(screen.getByText(/1,464-session manifest/)).toBeDefined();
  });

  it('handles small session counts without a comma', () => {
    render(<LocalAnalyzerEmpty title="X" estCostUsd={1} sessionCount={42} />);
    expect(screen.getByText(/42-session manifest/)).toBeDefined();
  });

  it('formats sub-dollar estCostUsd with two decimals (AC17 — no "~$0.5" ambiguity)', () => {
    render(<LocalAnalyzerEmpty title="X" estCostUsd={0.5} sessionCount={1000} />);
    expect(screen.getByText(/~\$0\.50/)).toBeDefined();
  });

  it('renders the optional preview paragraph when provided', () => {
    render(
      <LocalAnalyzerEmpty
        title="X"
        estCostUsd={1}
        sessionCount={1000}
        preview="What this would show: semantic clusters across related prompts."
      />,
    );
    expect(
      screen.getByText(/What this would show: semantic clusters across related prompts\./),
    ).toBeDefined();
  });

  it('omits the preview paragraph when not provided', () => {
    const { container } = render(
      <LocalAnalyzerEmpty title="X" estCostUsd={1} sessionCount={1000} />,
    );
    expect(container.querySelector('.lcars-local-analyzer-empty__preview')).toBeNull();
  });

  it('exposes an aria-label including the section title', () => {
    render(<LocalAnalyzerEmpty title="RE-SOLVED PROBLEMS" estCostUsd={1} sessionCount={100} />);
    expect(screen.getByLabelText('RE-SOLVED PROBLEMS — local analyzer required')).toBeDefined();
  });

  it('CTA format is identical across different titles (AC17 uniform CTA)', () => {
    const { unmount } = render(
      <LocalAnalyzerEmpty title="A" estCostUsd={2.5} sessionCount={1464} />,
    );
    const ctaA = screen.getByText(/LOCAL ANALYZER REQUIRED/).textContent;
    unmount();
    render(<LocalAnalyzerEmpty title="B" estCostUsd={2.5} sessionCount={1464} />);
    const ctaB = screen.getByText(/LOCAL ANALYZER REQUIRED/).textContent;
    expect(ctaA).toBe(ctaB);
  });
});
