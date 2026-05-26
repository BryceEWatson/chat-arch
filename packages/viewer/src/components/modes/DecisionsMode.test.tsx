import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type {
  Decision,
  DecisionCandidate,
  DecisionClassification,
  DecisionOutcomeRef,
  DecisionsFile,
} from '@chat-arch/schema';
import { THRESHOLDS } from '@chat-arch/analysis';
import { DecisionsMode } from './DecisionsMode.js';

/**
 * DecisionsMode tests (Stream J #1):
 *   - Empty / null inputs render an EmptyState.
 *   - Table renders one row per Decision in each bucket.
 *   - Bucket landed-rate + Wilson CI render when n ≥ minNForRate.
 *   - Landed-rate is hidden when n is below the floor.
 */

function candidate(
  overrides: Partial<DecisionCandidate> & { id: string },
): DecisionCandidate {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? 'sess-' + overrides.id,
    userTurnIndex: overrides.userTurnIndex ?? 0,
    kind: overrides.kind ?? 'explicit-go-with',
    span: overrides.span ?? { phrase: "let's go with X", startOffset: 0 },
    surroundingContext:
      overrides.surroundingContext ??
      'Some pre-context.  ' + (overrides.id ?? '') + ' was selected.',
  };
}

function classification(
  kind: DecisionClassification['kind'] = 'explicit-go-with',
): DecisionClassification {
  return {
    kind,
    distilledDecision: 'use X',
    chosen: ['X'],
    rejected: ['Y'],
    confidence: 0.8,
    actionable: true,
  };
}

function outcomeRef(
  binary: 'good' | 'bad' | 'neutral',
  score: number,
): DecisionOutcomeRef {
  return {
    sessionId: 'sess',
    compositeScore: score,
    binaryClass: binary,
  };
}

function decision(
  id: string,
  kind: DecisionClassification['kind'],
  binary: 'good' | 'bad' | 'neutral' | null,
  opts: { sessionId?: string; classified?: boolean } = {},
): Decision {
  return {
    candidate: candidate({
      id,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      kind: kind === 'tool-pivot' || kind === 'scope-cut' || kind === 'other'
        ? 'explicit-go-with'
        : kind,
    }),
    classification: opts.classified === false ? null : classification(kind),
    outcomeRef: binary === null ? null : outcomeRef(binary, 0.75),
  };
}

function buildFile(decisions: readonly Decision[]): DecisionsFile {
  return {
    generatedAt: 1_700_000_000_000,
    decisionHeuristicVersion: 1,
    decisions,
    scannedSessionIds: [],
  };
}

afterEach(() => cleanup());

describe('DecisionsMode', () => {
  it('renders an empty-state card when file is null', () => {
    render(<DecisionsMode file={null} />);
    expect(screen.getByText('NO DECISIONS')).toBeDefined();
  });

  it('renders the no-candidates state when the file has zero decisions', () => {
    render(<DecisionsMode file={buildFile([])} />);
    expect(screen.getByText('NO DECISIONS FOUND')).toBeDefined();
  });

  it('renders a row per decision in the bucket table', () => {
    const decisions: Decision[] = [
      decision('d1', 'explicit-go-with', 'good'),
      decision('d2', 'explicit-go-with', 'bad'),
      decision('d3', 'instead-of', 'good'),
    ];
    render(<DecisionsMode file={buildFile(decisions)} />);
    // Two buckets surface: GO-WITH + INSTEAD-OF
    expect(screen.getByRole('heading', { name: /GO-WITH/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: /INSTEAD-OF/ })).toBeDefined();
    // Three table rows in total across the buckets.
    const rows = document.querySelectorAll('[data-decision-key]');
    expect(rows.length).toBe(3);
  });

  it('hides the landed-rate when denom < minNForRate (Wilson CI too wide)', () => {
    const min = THRESHOLDS.display.minNForRate;
    // 3 joined good outcomes — well below the floor.
    const decisions: Decision[] = Array.from({ length: 3 }).map((_, i) =>
      decision(`d${i}`, 'explicit-go-with', 'good'),
    );
    render(<DecisionsMode file={buildFile(decisions)} />);
    // iter-5: visible text changed from "rate hidden — n < N" to
    // "rate hidden — n=X of N required" so SR users hear the actual n
    // (was previously mouse-hover-only via title=).
    const hidden = screen.getByTestId('rate-hidden-explicit-go-with').textContent ?? '';
    expect(hidden).toContain(`of ${min} required`);
    expect(hidden).toContain('rate hidden');
    // The CI text isn't present.
    expect(screen.queryByTestId('rate-explicit-go-with')).toBeNull();
  });

  it('shows the Wilson CI when denom ≥ minNForRate', () => {
    const min = THRESHOLDS.display.minNForRate;
    const decisions: Decision[] = Array.from({ length: min + 4 }).map((_, i) =>
      decision(`d${i}`, 'explicit-go-with', i % 2 === 0 ? 'good' : 'bad'),
    );
    render(<DecisionsMode file={buildFile(decisions)} />);
    const rate = screen.getByTestId('rate-explicit-go-with');
    expect(rate.textContent).toMatch(/landed/);
    // Wilson 95% CI brackets are rendered.
    expect(rate.textContent).toMatch(/\[\d+%–\d+%\]/);
  });

  it('groups unclassified decisions into an Untagged bucket pinned to the bottom', () => {
    const decisions: Decision[] = [
      decision('u1', 'explicit-go-with', 'good', { classified: false }),
      decision('d1', 'explicit-go-with', 'good'),
    ];
    render(<DecisionsMode file={buildFile(decisions)} />);
    const buckets = document.querySelectorAll('[data-kind]');
    expect(buckets.length).toBe(2);
    expect(buckets[buckets.length - 1]!.getAttribute('data-kind')).toBe(
      'unclassified',
    );
  });

  it('renders the OUTCOME chip with the binary class label and score', () => {
    render(
      <DecisionsMode
        file={buildFile([decision('d1', 'explicit-go-with', 'bad')])}
      />,
    );
    const table = screen.getByRole('table');
    const cell = within(table).getByTitle(/composite 0\.75 · bad/);
    expect(cell.textContent).toContain('BAD');
  });

  it('renders the MINE batch-size selector when there are unclassified decisions (Wave 7 P2 #7)', () => {
    const decisions: Decision[] = [
      decision('u1', 'explicit-go-with', null, { classified: false }),
    ];
    render(<DecisionsMode file={buildFile(decisions)} />);
    const selector = screen.getByTestId('mine-batch-selector');
    expect(selector).toBeDefined();
    // Default batch is 5 — the button label reflects it.
    expect(screen.getByTestId('mine-decisions-btn').textContent).toMatch(
      /MINE 5/,
    );
  });
});
