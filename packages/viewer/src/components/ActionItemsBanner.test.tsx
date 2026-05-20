import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ActionItemsBanner } from './ActionItemsBanner.js';

/**
 * Wave 6 #4 — ActionItemsBanner tests. Confirms:
 *   - Hides cleanly when every count is zero.
 *   - Hides items whose target matches the current mode.
 *   - Renders each non-zero item with a clickable navigation link.
 */

afterEach(() => cleanup());

describe('ActionItemsBanner', () => {
  it('renders nothing when every count is zero', () => {
    const { container } = render(
      <ActionItemsBanner
        unclassifiedDecisions={0}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
      />,
    );
    expect(container.querySelector('[data-testid="action-items-banner"]')).toBeNull();
  });

  it('renders all three when on a non-relevant mode', () => {
    render(
      <ActionItemsBanner
        unclassifiedDecisions={3}
        knowledgeDebtClusters={2}
        unacknowledgedItsContrasts={1}
        currentMode="command"
        onNavigate={() => undefined}
      />,
    );
    expect(screen.getByTestId('action-items-banner')).toBeTruthy();
    expect(screen.getByTestId('action-items-link-decisions')).toBeTruthy();
    expect(screen.getByTestId('action-items-link-knowledge-debt')).toBeTruthy();
    expect(screen.getByTestId('action-items-link-its')).toBeTruthy();
  });

  it('suppresses the decisions item when already on DECISIONS', () => {
    render(
      <ActionItemsBanner
        unclassifiedDecisions={3}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        currentMode="decisions"
        onNavigate={() => undefined}
      />,
    );
    // The whole banner hides because nothing else is non-zero either.
    expect(
      screen.queryByTestId('action-items-banner'),
    ).toBeNull();
  });

  it('suppresses knowledge-debt + its items when on INSIGHTS', () => {
    render(
      <ActionItemsBanner
        unclassifiedDecisions={2}
        knowledgeDebtClusters={5}
        unacknowledgedItsContrasts={3}
        currentMode="insights"
        onNavigate={() => undefined}
      />,
    );
    // decisions item survives
    expect(screen.getByTestId('action-items-link-decisions')).toBeTruthy();
    // insights items are suppressed
    expect(screen.queryByTestId('action-items-link-knowledge-debt')).toBeNull();
    expect(screen.queryByTestId('action-items-link-its')).toBeNull();
  });

  it('fires onNavigate with the right mode when an item is clicked', () => {
    let target: string | null = null;
    render(
      <ActionItemsBanner
        unclassifiedDecisions={1}
        knowledgeDebtClusters={1}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={(m) => {
          target = m;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('action-items-link-decisions'));
    expect(target).toBe('decisions');
    fireEvent.click(screen.getByTestId('action-items-link-knowledge-debt'));
    expect(target).toBe('insights');
  });
});
