import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  REV3_ATTRIBUTION_KINDS,
  SourceAttribution,
  type AttributionKind,
} from './SourceAttribution.js';

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

  describe('Rev3-G G3 — extended rungs', () => {
    it('renders each new rung as "· {kind}"', () => {
      // Iterates the union via REV3_ATTRIBUTION_KINDS so a future
      // addition to the union must be reflected in the constant.
      for (const kind of REV3_ATTRIBUTION_KINDS) {
        const { container, unmount } = render(
          <SourceAttribution kind={kind} />,
        );
        const escaped = kind.replace(/[-+]/g, (m) => `\\${m}`);
        expect(container.textContent).toMatch(
          new RegExp(`·\\s*${escaped}`),
        );
        expect(container.querySelector('.lcars-attribution')).not.toBeNull();
        unmount();
      }
    });

    it('REV3_ATTRIBUTION_KINDS includes all seven rungs introduced by Rev3-G G3', () => {
      expect(new Set(REV3_ATTRIBUTION_KINDS)).toEqual(
        new Set<AttributionKind>([
          'tier1',
          'tier2',
          'tier3',
          'llm-derived',
          'falsifier-verified',
          'deterministic-with-prior',
          'correlation-significant',
        ]),
      );
    });

    it('aria-label defaults to "source: {kind}" for each new rung', () => {
      for (const kind of REV3_ATTRIBUTION_KINDS) {
        const { unmount } = render(<SourceAttribution kind={kind} />);
        expect(screen.getByLabelText(`source: ${kind}`)).toBeDefined();
        unmount();
      }
    });
  });
});
