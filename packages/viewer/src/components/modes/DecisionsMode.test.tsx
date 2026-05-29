import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type * as MineDecisionsClient from '../../data/mineDecisionsClient.js';

// The clear control is gated on a probe to /api/clear-decisions; stub the
// client so probeClearDecisions resolves true in jsdom (no dev server).
vi.mock('../../data/mineDecisionsClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MineDecisionsClient>();
  return {
    ...actual,
    probeClearDecisions: () => Promise.resolve(true),
    clearDecisions: () => Promise.resolve({ removed: [], reset: 2 }),
  };
});
import type {
  Decision,
  DecisionCandidate,
  DecisionClassification,
  DecisionOutcomeRef,
  DecisionsFile,
  DecisionClustersFile,
} from '@chat-arch/schema';
import { THRESHOLDS } from '@chat-arch/analysis';
import { DecisionsMode } from './DecisionsMode.js';

/**
 * DecisionsMode tests — PR2 redesign contract:
 *   - Empty / null inputs render an EmptyState.
 *   - CLASSIFIED rows group by classification.kind; each renders the
 *     distilled decision + chose/over + rationale + outcome chip.
 *   - Per-kind landed-rate + Wilson CI gate on minNForRate.
 *   - UNCLASSIFIED rows render in a browsable section (unwrapped
 *     context, no cryptic PHRASE column), collapsed past the preview.
 *   - MINE is a real action (no "not yet implemented" stub note).
 *   - Recurring clusters render from the clusters sidecar.
 */

function candidate(overrides: Partial<DecisionCandidate> & { id: string }): DecisionCandidate {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? 'sess-' + overrides.id,
    userTurnIndex: overrides.userTurnIndex ?? 0,
    kind: overrides.kind ?? 'explicit-go-with',
    span: overrides.span ?? { phrase: "let's go with X", startOffset: 0 },
    surroundingContext: overrides.surroundingContext ?? "let's go with X over Y here",
    precedingAssistantExcerpt: overrides.precedingAssistantExcerpt ?? 'I recommend X',
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
    rationale: 'X is faster on large trees',
    confidence: 0.8,
    actionable: true,
  };
}

function outcomeRef(binary: 'good' | 'bad' | 'neutral', score: number): DecisionOutcomeRef {
  return { sessionId: 'sess', compositeScore: score, binaryClass: binary };
}

function decision(
  id: string,
  kind: DecisionClassification['kind'],
  binary: 'good' | 'bad' | 'neutral' | null,
  opts: { sessionId?: string; classified?: boolean; context?: string } = {},
): Decision {
  return {
    candidate: candidate({
      id,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.context !== undefined ? { surroundingContext: opts.context } : {}),
    }),
    classification: opts.classified === false ? null : classification(kind),
    outcomeRef: binary === null ? null : outcomeRef(binary, 0.75),
  };
}

function buildFile(decisions: readonly Decision[]): DecisionsFile {
  return {
    generatedAt: 1_700_000_000_000,
    decisionHeuristicVersion: 2,
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

  it('groups classified rows by kind and renders distilled/chose/rationale', () => {
    const decisions: Decision[] = [
      decision('d1', 'explicit-go-with', 'good'),
      decision('d2', 'instead-of', 'bad'),
    ];
    render(<DecisionsMode file={buildFile(decisions)} />);
    expect(screen.getByRole('heading', { name: /GO-WITH/ })).toBeDefined();
    expect(screen.getByRole('heading', { name: /INSTEAD-OF/ })).toBeDefined();
    // Distilled decision is the row headline; rationale + chose surface.
    expect(screen.getAllByText('use X').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/X is faster on large trees/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/chose: X/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/over: Y/).length).toBeGreaterThan(0);
    // Two classified rows total.
    expect(document.querySelectorAll('[data-decision-key]').length).toBe(2);
  });

  it('reclassifies into extended kinds (tool-pivot) via classification.kind', () => {
    render(<DecisionsMode file={buildFile([decision('d1', 'tool-pivot', 'good')])} />);
    expect(screen.getByRole('heading', { name: /TOOL PIVOT/ })).toBeDefined();
  });

  it('hides the landed-rate when denom < minNForRate', () => {
    const min = THRESHOLDS.display.minNForRate;
    const decisions: Decision[] = Array.from({ length: 3 }).map((_, i) =>
      decision(`d${i}`, 'explicit-go-with', 'good', { sessionId: `s${i}` }),
    );
    render(<DecisionsMode file={buildFile(decisions)} />);
    expect(screen.getByTestId('rate-hidden-explicit-go-with').textContent).toContain(
      `of ${min}`,
    );
    expect(screen.queryByTestId('rate-explicit-go-with')).toBeNull();
  });

  it('shows the Wilson CI when denom ≥ minNForRate', () => {
    const min = THRESHOLDS.display.minNForRate;
    const decisions: Decision[] = Array.from({ length: min + 4 }).map((_, i) =>
      decision(`d${i}`, 'explicit-go-with', i % 2 === 0 ? 'good' : 'bad', { sessionId: `s${i}` }),
    );
    render(<DecisionsMode file={buildFile(decisions)} />);
    const rate = screen.getByTestId('rate-explicit-go-with');
    expect(rate.textContent).toMatch(/landed/);
    expect(rate.textContent).toMatch(/\[\d+%–\d+%\]/);
  });

  it('renders the OUTCOME chip with the binary class label and score', () => {
    render(<DecisionsMode file={buildFile([decision('d1', 'explicit-go-with', 'bad')])} />);
    const chip = screen.getByTitle(/composite 0\.75 · bad/);
    expect(chip.textContent).toContain('BAD');
  });

  it('renders a real MINE action (no stub note) when there are unclassified decisions', () => {
    render(
      <DecisionsMode
        file={buildFile([decision('u1', 'explicit-go-with', null, { classified: false })])}
      />,
    );
    expect(screen.getByTestId('mine-batch-selector')).toBeDefined();
    expect(screen.getByTestId('mine-decisions-btn').textContent).toMatch(/MINE 5/);
    expect(screen.queryByText(/not yet implemented/i)).toBeNull();
    expect(screen.queryByText(/STUB/)).toBeNull();
  });

  it('renders unclassified decisions in a browsable section with unwrapped context', () => {
    const wrapped =
      '<command-message>shopsmith</command-message>\n<command-name>/menu</command-name> pick the second option';
    render(
      <DecisionsMode
        file={buildFile([
          decision('u1', 'explicit-go-with', null, { classified: false, context: wrapped }),
        ])}
      />,
    );
    const section = screen.getByTestId('decisions-unclassified');
    expect(section).toBeDefined();
    // The raw harness wrapper must not leak into the rendered text.
    expect(section.textContent).not.toContain('<command-message>');
    expect(section.textContent).toMatch(/pick the second option/);
  });

  it('collapses the unclassified list past the preview window', () => {
    const decisions = Array.from({ length: 16 }).map((_, i) =>
      decision(`u${i}`, 'explicit-go-with', null, { classified: false, sessionId: `s${i}` }),
    );
    render(<DecisionsMode file={buildFile(decisions)} />);
    expect(screen.getByTestId('decisions-show-all').textContent).toMatch(/show all 16/);
  });

  it('renders the recurring-decisions section from the clusters sidecar', () => {
    const clustersFile: DecisionClustersFile = {
      generatedAt: 1,
      clusters: [
        {
          id: 'dpat_abc',
          canonicalDecision: 'use ripgrep instead of grep',
          instanceIds: ['d1', 'd2'],
          occurrenceCount: 2,
          firstSeen: 0,
          lastSeen: 0,
          landedRate: 0.5,
          landedDenom: 2,
        },
      ],
    };
    render(
      <DecisionsMode
        file={buildFile([decision('d1', 'explicit-go-with', 'good')])}
        clustersFile={clustersFile}
      />,
    );
    const recurring = screen.getByTestId('decisions-recurring');
    expect(recurring.textContent).toMatch(/use ripgrep instead of grep/);
    expect(recurring.textContent).toMatch(/2 sessions/);
  });

  it('shows the clear-classifications control when classified rows exist (probe ok)', async () => {
    render(<DecisionsMode file={buildFile([decision('d1', 'explicit-go-with', 'good')])} />);
    // Probe resolves in an effect → control appears asynchronously.
    const arm = await screen.findByTestId('decisions-clear-arm');
    expect(arm).toBeDefined();
    fireEvent.click(arm);
    expect(screen.getByTestId('decisions-clear-confirm')).toBeDefined();
  });

  it('hides the clear control when there are no classified rows', async () => {
    render(
      <DecisionsMode
        file={buildFile([decision('u1', 'explicit-go-with', null, { classified: false })])}
      />,
    );
    // Give the probe effect a tick to resolve, then assert absence.
    await waitFor(() => expect(screen.getByTestId('mine-decisions-cta')).toBeDefined());
    expect(screen.queryByTestId('decisions-clear')).toBeNull();
  });
});
