import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ActionItemsBanner, type TopItem } from './ActionItemsBanner.js';

/**
 * Wave 6 #4 + Wave 7 P1 #5 — ActionItemsBanner tests.
 *
 * Wave 7 extends the contract to:
 *   - per-kind cursor in localStorage
 *   - "N new since {relative}" headline
 *   - Top-3 this week band
 *   - jargon-translated copy
 *   - dismiss button + cursor sweep on dismiss / click-through
 *   - trust mis-calibration item suppressed on TRUST mode
 */

const CURSOR_KEY = 'chat-arch.action-items-cursor';

beforeEach(() => {
  if (typeof window !== 'undefined') window.localStorage.clear();
});
afterEach(() => cleanup());

describe('ActionItemsBanner', () => {
  it('renders nothing when every count is zero and topItems is empty', () => {
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

  it('renders all three list items with jargon-translated copy', () => {
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
    expect(screen.getByTestId('action-items-link-decisions').textContent).toMatch(
      /decisions awaiting classification/i,
    );
    expect(
      screen.getByTestId('action-items-link-knowledge-debt').textContent,
    ).toMatch(/recurring questions worth turning into rules/i);
    expect(screen.getByTestId('action-items-link-its').textContent).toMatch(
      /config changes worth reviewing/i,
    );
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
    expect(screen.queryByTestId('action-items-banner')).toBeNull();
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
    expect(screen.getByTestId('action-items-link-decisions')).toBeTruthy();
    expect(screen.queryByTestId('action-items-link-knowledge-debt')).toBeNull();
    expect(screen.queryByTestId('action-items-link-its')).toBeNull();
  });

  it('suppresses the trust mis-calibration item when on TRUST', () => {
    render(
      <ActionItemsBanner
        unclassifiedDecisions={0}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        trustMisCalibrationFired={true}
        currentMode="trust"
        onNavigate={() => undefined}
      />,
    );
    expect(screen.queryByTestId('action-items-banner')).toBeNull();
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

  it('persists the cursor on click-through and shows "no new" on remount', () => {
    const NOW = 1_700_000_000_000;
    const { unmount } = render(
      <ActionItemsBanner
        unclassifiedDecisions={3}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByTestId('action-items-link-decisions'));
    unmount();
    cleanup();
    // Remount with same count — should now read "no new".
    render(
      <ActionItemsBanner
        unclassifiedDecisions={3}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
        now={NOW + 60_000}
      />,
    );
    expect(screen.getByTestId('action-items-link-decisions').textContent).toMatch(
      /no new/i,
    );
  });

  it('shows "N new since {relative}" when count grows after a cursor', () => {
    const NOW = 1_700_000_000_000;
    // Seed cursor at 1 item, 1 day ago.
    window.localStorage.setItem(
      CURSOR_KEY,
      JSON.stringify({
        decisions: { countAtSeen: 1, lastSeenAt: NOW - 86_400_000 },
      }),
    );
    render(
      <ActionItemsBanner
        unclassifiedDecisions={8}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
        now={NOW}
      />,
    );
    // 8 - 1 = 7 new since "yesterday".
    expect(screen.getByTestId('action-items-link-decisions').textContent).toMatch(
      /7 new since yesterday/i,
    );
    // Backlog suffix shows full count.
    expect(screen.getByTestId('action-items-backlog-decisions').textContent).toMatch(
      /show all 8/i,
    );
  });

  it('dismiss button hides the banner and sweeps the cursors', () => {
    const NOW = 1_700_000_000_000;
    render(
      <ActionItemsBanner
        unclassifiedDecisions={4}
        knowledgeDebtClusters={2}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByTestId('action-items-dismiss'));
    expect(screen.queryByTestId('action-items-banner')).toBeNull();
    const raw = window.localStorage.getItem(CURSOR_KEY);
    expect(raw).not.toBeNull();
    const cursor = JSON.parse(raw ?? '{}');
    expect(cursor.decisions.countAtSeen).toBe(4);
    expect(cursor['knowledge-debt'].countAtSeen).toBe(2);
  });

  it('renders the Top-3 band when topItems is provided', () => {
    const topItems: TopItem[] = [
      {
        kind: 'knowledge-debt',
        headline: 'recurring docker question (12 sessions)',
        mode: 'insights',
      },
      {
        kind: 'its',
        headline: 'CLAUDE.md edit shifted good-share +18 pp',
        mode: 'insights',
      },
      {
        kind: 'trust-miscalibration',
        headline: 'overrides land less often than accepts',
        mode: 'trust',
      },
    ];
    render(
      <ActionItemsBanner
        unclassifiedDecisions={0}
        knowledgeDebtClusters={1}
        unacknowledgedItsContrasts={1}
        trustMisCalibrationFired={true}
        currentMode="command"
        onNavigate={() => undefined}
        topItems={topItems}
      />,
    );
    expect(screen.getByTestId('action-items-top3')).toBeTruthy();
    expect(screen.getByTestId('action-items-top3-link-0').textContent).toMatch(
      /docker/i,
    );
  });
});
