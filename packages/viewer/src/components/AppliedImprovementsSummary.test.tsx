import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  CorrectionPattern,
  CorrectionsFile,
  ProposedUpgrade,
} from '@chat-arch/schema';
import { AppliedImprovementsSummary } from './AppliedImprovementsSummary.js';

afterEach(() => {
  cleanup();
});

const MS_DAY = 86_400_000;

function upgrade(overrides: Partial<ProposedUpgrade> = {}): ProposedUpgrade {
  return {
    target: 'global-claude-md',
    targetPath: '~/.claude/CLAUDE.md',
    patch: '- rule body',
    rationale: 'because',
    applied: false,
    appliedAt: null,
    ...overrides,
  };
}

function entry(
  overrides: Partial<AppliedImprovement> & {
    id: string;
    patternId: string;
    appliedAt: number;
  },
): AppliedImprovement {
  return {
    ruleSummary: overrides.ruleSummary ?? `rule ${overrides.patternId}`,
    proposedUpgrade: overrides.proposedUpgrade ?? upgrade(),
    ...overrides,
  };
}

function ledger(entries: AppliedImprovement[]): AppliedImprovementsFile {
  return {
    schemaVersion: 1,
    generatedAt: 1_700_300_000_000,
    entries,
  };
}

function pattern(overrides: Partial<CorrectionPattern> & { id: string }): CorrectionPattern {
  return {
    id: overrides.id,
    canonicalRule: overrides.canonicalRule ?? `rule ${overrides.id}`,
    instanceIds: overrides.instanceIds ?? [],
    occurrenceCount: overrides.occurrenceCount ?? 3,
    firstSeen: overrides.firstSeen ?? 1_700_000_000_000,
    lastSeen: overrides.lastSeen ?? 1_700_100_000_000,
    scope: { kind: 'global' },
    proposedUpgrades: overrides.proposedUpgrades ?? [],
    confidence: overrides.confidence ?? 0.5,
    recurringPostApplication: overrides.recurringPostApplication ?? false,
    alreadyEncoded: overrides.alreadyEncoded ?? false,
  };
}

function corrections(patterns: CorrectionPattern[]): CorrectionsFile {
  return {
    generatedAt: 1_700_000_000_000,
    corrections: [],
    patterns,
    pipeline: {
      heuristicRecall: true,
      llmClassification: true,
      embeddingClustering: true,
      claudeMdCrossCheck: true,
    },
  };
}

describe('AppliedImprovementsSummary', () => {
  it('renders nothing when applied is null', () => {
    const { container } = render(
      <AppliedImprovementsSummary
        applied={null}
        corrections={null}
        manifestGeneratedAt={null}
        onSelectPattern={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when applied has zero entries', () => {
    const { container } = render(
      <AppliedImprovementsSummary
        applied={ledger([])}
        corrections={null}
        manifestGeneratedAt={null}
        onSelectPattern={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  describe('stats row', () => {
    const cases: Array<{
      name: string;
      entries: AppliedImprovement[];
      patterns: CorrectionPattern[];
      expected: { applied: string; holding: string; recurring: string };
    }> = [
      {
        name: 'all holding (no patterns flagged recurring)',
        entries: [
          entry({ id: 'a', patternId: 'p1', appliedAt: 1_700_000_000_000 }),
          entry({ id: 'b', patternId: 'p2', appliedAt: 1_700_010_000_000 }),
        ],
        patterns: [pattern({ id: 'p1' }), pattern({ id: 'p2' })],
        expected: { applied: '2', holding: '2', recurring: '0' },
      },
      {
        name: 'all recurring',
        entries: [
          entry({ id: 'a', patternId: 'p1', appliedAt: 1_700_000_000_000 }),
          entry({ id: 'b', patternId: 'p2', appliedAt: 1_700_010_000_000 }),
        ],
        patterns: [
          pattern({ id: 'p1', recurringPostApplication: true }),
          pattern({ id: 'p2', recurringPostApplication: true }),
        ],
        expected: { applied: '2', holding: '0', recurring: '2' },
      },
      {
        name: 'mixed: 1 holding + 1 recurring',
        entries: [
          entry({ id: 'a', patternId: 'p1', appliedAt: 1_700_000_000_000 }),
          entry({ id: 'b', patternId: 'p2', appliedAt: 1_700_010_000_000 }),
        ],
        patterns: [
          pattern({ id: 'p1' }),
          pattern({ id: 'p2', recurringPostApplication: true }),
        ],
        expected: { applied: '2', holding: '1', recurring: '1' },
      },
      {
        name: 'two ledger entries on same pattern count once for holding/recurring',
        entries: [
          entry({ id: 'a', patternId: 'p1', appliedAt: 1_700_000_000_000 }),
          entry({
            id: 'b',
            patternId: 'p1',
            appliedAt: 1_700_010_000_000,
            proposedUpgrade: upgrade({ targetPath: '<repo>/CLAUDE.md' }),
          }),
        ],
        patterns: [pattern({ id: 'p1' })],
        expected: { applied: '2', holding: '1', recurring: '0' },
      },
      {
        name: 'pattern absent from corrections file → counts as holding (not recurring)',
        entries: [entry({ id: 'a', patternId: 'orphan', appliedAt: 1_700_000_000_000 })],
        patterns: [],
        expected: { applied: '1', holding: '1', recurring: '0' },
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        render(
          <AppliedImprovementsSummary
            applied={ledger(c.entries)}
            corrections={corrections(c.patterns)}
            manifestGeneratedAt={null}
            onSelectPattern={() => {}}
          />,
        );
        const applied = screen.getByText('APPLIED').previousSibling as HTMLElement;
        const holding = screen.getByText('HOLDING').previousSibling as HTMLElement;
        const recurring = screen.getByText('RECURRING').previousSibling as HTMLElement;
        expect(applied.textContent).toBe(c.expected.applied);
        expect(holding.textContent).toBe(c.expected.holding);
        expect(recurring.textContent).toBe(c.expected.recurring);
      });
    }
  });

  it('renders the headline using the most recent appliedAt', () => {
    // Set a stable "now" so the headline math is deterministic.
    vi.useFakeTimers();
    const now = 1_700_500_000_000;
    vi.setSystemTime(now);
    try {
      const entries = [
        entry({ id: 'a', patternId: 'p1', appliedAt: now - 64 * MS_DAY }),
        entry({ id: 'b', patternId: 'p2', appliedAt: now - 200 * MS_DAY }),
      ];
      render(
        <AppliedImprovementsSummary
          applied={ledger(entries)}
          corrections={corrections([pattern({ id: 'p1' }), pattern({ id: 'p2' })])}
          manifestGeneratedAt={null}
          onSelectPattern={() => {}}
        />,
      );
      const headline = screen.getByText(/SINCE YOU PATCHED/);
      // 64 days < 30 days/month threshold * 2 = 60 days so falls into months
      // Actually 64 days = 2 months in our 30-day buckets.
      expect(headline.textContent).toMatch(/SINCE YOU PATCHED 2MO AGO/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts collapsed; expand button reveals the timeline; collapse hides it again', () => {
    const entries = [entry({ id: 'a', patternId: 'p1', appliedAt: 1_700_000_000_000 })];
    render(
      <AppliedImprovementsSummary
        applied={ledger(entries)}
        corrections={corrections([pattern({ id: 'p1', canonicalRule: 'unique-rule-text' })])}
        manifestGeneratedAt={null}
        onSelectPattern={() => {}}
      />,
    );
    // Initially the timeline is hidden — the rule-summary text doesn't render.
    expect(screen.queryByText('rule p1')).toBeNull();
    const toggle = screen.getByRole('button', { name: /VIEW PATCH LEDGER/i });
    fireEvent.click(toggle);
    expect(screen.getByText('rule p1')).toBeDefined();
    // The toggle label flips.
    const collapseToggle = screen.getByRole('button', { name: /HIDE PATCH LEDGER/i });
    fireEvent.click(collapseToggle);
    expect(screen.queryByText('rule p1')).toBeNull();
  });

  it('timeline rows fire onSelectPattern with the matching patternId', () => {
    const onSelect = vi.fn();
    const entries = [
      entry({ id: 'a', patternId: 'first', appliedAt: 1_700_010_000_000 }),
      entry({ id: 'b', patternId: 'second', appliedAt: 1_700_020_000_000 }),
    ];
    render(
      <AppliedImprovementsSummary
        applied={ledger(entries)}
        corrections={corrections([pattern({ id: 'first' }), pattern({ id: 'second' })])}
        manifestGeneratedAt={null}
        onSelectPattern={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /VIEW PATCH LEDGER/i }));
    // Most-recent first: rule second is at the top.
    const buttons = screen.getAllByTitle("Jump to this pattern's card");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledWith('second');
    fireEvent.click(buttons[1]!);
    expect(onSelect).toHaveBeenCalledWith('first');
  });

  it('renders the bucket badge per row (HOLDING / RECURRING / GONE)', () => {
    const entries = [
      entry({ id: 'a', patternId: 'hold', appliedAt: 1_700_000_000_000 }),
      entry({ id: 'b', patternId: 'rec', appliedAt: 1_700_010_000_000 }),
      entry({ id: 'c', patternId: 'gone', appliedAt: 1_700_020_000_000 }),
    ];
    render(
      <AppliedImprovementsSummary
        applied={ledger(entries)}
        corrections={corrections([
          pattern({ id: 'hold' }),
          pattern({ id: 'rec', recurringPostApplication: true }),
          // 'gone' intentionally omitted from corrections.json
        ])}
        manifestGeneratedAt={null}
        onSelectPattern={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /VIEW PATCH LEDGER/i }));
    // The stat-row labels also say HOLDING/RECURRING; query the row
    // badges by class so we only assert against per-row classification.
    const rowBadges = Array.from(
      document.querySelectorAll('.lcars-applied-summary__row-bucket'),
    ).map((el) => el.textContent);
    expect(rowBadges).toContain('HOLDING');
    expect(rowBadges).toContain('RECURRING');
    expect(rowBadges).toContain('GONE');
  });

  describe('stale-warning chip', () => {
    it('fires when manifest is older than maxAppliedAt + 30 days and >30d wall clock has passed', () => {
      vi.useFakeTimers();
      try {
        const apply = 1_700_000_000_000;
        const now = apply + 60 * MS_DAY; // 60 days post-apply
        const manifest = apply - 5 * MS_DAY; // manifest predates the apply
        vi.setSystemTime(now);
        render(
          <AppliedImprovementsSummary
            applied={ledger([entry({ id: 'a', patternId: 'p1', appliedAt: apply })])}
            corrections={corrections([pattern({ id: 'p1' })])}
            manifestGeneratedAt={manifest}
            onSelectPattern={() => {}}
          />,
        );
        expect(
          screen.getByText(/INDEX IS STALE — RUN UPDATE LOCAL/i),
        ).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fire when manifest was refreshed within 30 days post-apply', () => {
      vi.useFakeTimers();
      try {
        const apply = 1_700_000_000_000;
        const now = apply + 60 * MS_DAY;
        // Manifest was refreshed 31 days after apply — 30+ days of
        // post-apply observation are in the index, not stale.
        const manifest = apply + 31 * MS_DAY;
        vi.setSystemTime(now);
        render(
          <AppliedImprovementsSummary
            applied={ledger([entry({ id: 'a', patternId: 'p1', appliedAt: apply })])}
            corrections={corrections([pattern({ id: 'p1' })])}
            manifestGeneratedAt={manifest}
            onSelectPattern={() => {}}
          />,
        );
        expect(screen.queryByText(/INDEX IS STALE/i)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fire when the latest apply was very recent (no observation window expected)', () => {
      vi.useFakeTimers();
      try {
        const now = 1_700_500_000_000;
        const apply = now - 5 * MS_DAY; // applied 5 days ago
        const manifest = apply - 1 * MS_DAY; // manifest predates the apply
        vi.setSystemTime(now);
        render(
          <AppliedImprovementsSummary
            applied={ledger([entry({ id: 'a', patternId: 'p1', appliedAt: apply })])}
            corrections={corrections([pattern({ id: 'p1' })])}
            manifestGeneratedAt={manifest}
            onSelectPattern={() => {}}
          />,
        );
        // Wall-clock gate: only 5 days post-apply, no expectation that
        // a re-mine has happened yet.
        expect(screen.queryByText(/INDEX IS STALE/i)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fire when manifestGeneratedAt is null', () => {
      vi.useFakeTimers();
      try {
        const apply = 1_700_000_000_000;
        const now = apply + 60 * MS_DAY;
        vi.setSystemTime(now);
        render(
          <AppliedImprovementsSummary
            applied={ledger([entry({ id: 'a', patternId: 'p1', appliedAt: apply })])}
            corrections={corrections([pattern({ id: 'p1' })])}
            manifestGeneratedAt={null}
            onSelectPattern={() => {}}
          />,
        );
        expect(screen.queryByText(/INDEX IS STALE/i)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
