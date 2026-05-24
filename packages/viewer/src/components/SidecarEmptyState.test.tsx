import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { SidecarEmptyState } from './SidecarEmptyState.js';

/**
 * Wave 7 P1 #4 — SidecarEmptyState contract:
 *   - Renders the standardized "No data yet" copy.
 *   - Surfaces the OPEN DATA PANEL CTA when onOpenDataPanel is provided.
 *   - Suppresses the CTA when the handler is absent (embedded / hosted).
 *   - Forwards clicks to the handler.
 */

afterEach(() => cleanup());

describe('SidecarEmptyState', () => {
  it('renders the title, standard body, and optional detail', () => {
    render(
      <SidecarEmptyState
        title="NO INSIGHTS DATA"
        detail="INSIGHTS reads three sidecars."
      />,
    );
    expect(screen.getByText('NO INSIGHTS DATA')).toBeDefined();
    expect(screen.getByText(/No data yet/i)).toBeDefined();
    expect(screen.getByText(/INSIGHTS reads three sidecars/i)).toBeDefined();
  });

  it('omits the CTA when onOpenDataPanel is undefined', () => {
    render(<SidecarEmptyState title="X" />);
    expect(screen.queryByTestId('open-data-panel-cta')).toBeNull();
  });

  it('renders and fires the OPEN DATA PANEL CTA', () => {
    let called = 0;
    render(
      <SidecarEmptyState title="X" onOpenDataPanel={() => (called += 1)} />,
    );
    const cta = screen.getByTestId('open-data-panel-cta');
    expect(cta.textContent).toMatch(/OPEN DATA PANEL/i);
    fireEvent.click(cta);
    expect(called).toBe(1);
  });
});
