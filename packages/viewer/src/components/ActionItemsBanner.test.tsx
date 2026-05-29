import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ActionItemsBanner, type TopItem } from './ActionItemsBanner.js';

/**
 * Wave 6 #4 + Wave 7 P1 #5 + redesign (2026-05) — ActionItemsBanner tests.
 *
 * Contract after the de-conflation redesign:
 *   - static "Needs attention" header (no mispaired global count/date)
 *   - per-kind cursor in localStorage
 *   - per-row "N new since {relative}" / "no new since {relative}" delta
 *     in a separate span — count and date describe the SAME bucket
 *   - "Worth a look" examples strip (renders 0-2; no "Top 3" promise)
 *   - jargon-translated copy + full count always in the link text
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
    // Remount with same count — link keeps the full count; the per-row
    // delta span now reads "no new since {rel}".
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
      /3 decisions awaiting classification/i,
    );
    expect(screen.getByTestId('action-items-delta-decisions').textContent).toMatch(
      /no new since/i,
    );
  });

  it('shows full count in the link + "N new since {relative}" delta after a cursor', () => {
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
    // Link always carries the full total (8), not the delta.
    expect(screen.getByTestId('action-items-link-decisions').textContent).toMatch(
      /8 decisions awaiting classification/i,
    );
    // 8 - 1 = 7 new since "yesterday" — in the delta span, anchored to
    // the SAME bucket's cursor.
    expect(screen.getByTestId('action-items-delta-decisions').textContent).toMatch(
      /7 new since yesterday/i,
    );
  });

  it('omits the delta span entirely for a never-seen bucket', () => {
    render(
      <ActionItemsBanner
        unclassifiedDecisions={5}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
        now={1_700_000_000_000}
      />,
    );
    expect(screen.getByTestId('action-items-link-decisions').textContent).toMatch(
      /5 decisions awaiting classification/i,
    );
    expect(screen.queryByTestId('action-items-delta-decisions')).toBeNull();
  });

  it('shows a static "Needs attention" header (no mispaired global count)', () => {
    render(
      <ActionItemsBanner
        unclassifiedDecisions={102}
        knowledgeDebtClusters={5}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
      />,
    );
    expect(screen.getByTestId('action-items-headline').textContent).toMatch(
      /needs attention/i,
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

  it('renders the "Worth a look" examples strip when topItems is provided', () => {
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
    ];
    render(
      <ActionItemsBanner
        unclassifiedDecisions={0}
        knowledgeDebtClusters={1}
        unacknowledgedItsContrasts={1}
        currentMode="command"
        onNavigate={() => undefined}
        topItems={topItems}
      />,
    );
    expect(screen.getByTestId('action-items-examples')).toBeTruthy();
    expect(screen.getByTestId('action-items-examples-link-0').textContent).toMatch(
      /docker/i,
    );
    // Renders exactly as many examples as provided — no "Top 3" padding.
    expect(screen.getByTestId('action-items-examples-link-1').textContent).toMatch(
      /good-share/i,
    );
  });

  it('renders only the examples strip when every count is suppressed', () => {
    const topItems: TopItem[] = [
      {
        kind: 'knowledge-debt',
        headline: 'recurring docker question (12 sessions)',
        mode: 'insights',
      },
    ];
    render(
      <ActionItemsBanner
        unclassifiedDecisions={0}
        knowledgeDebtClusters={0}
        unacknowledgedItsContrasts={0}
        currentMode="command"
        onNavigate={() => undefined}
        topItems={topItems}
      />,
    );
    expect(screen.getByTestId('action-items-banner')).toBeTruthy();
    expect(screen.getByTestId('action-items-examples')).toBeTruthy();
    expect(screen.queryByTestId('action-items-link-decisions')).toBeNull();
  });
});
