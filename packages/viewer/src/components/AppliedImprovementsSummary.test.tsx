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
        // Phase 2b adversarial-review fix: a pattern in the apply
        // ledger but missing from the current corrections.json renders
        // as a GONE row in the timeline. It must NOT inflate HOLDING
        // (the original implementation lumped these into HOLDING,
        // conflating "lost track of pattern" with "rule is sticking").
        name: 'pattern absent from corrections file → GONE row, neither holding nor recurring',
        entries: [entry({ id: 'a', patternId: 'orphan', appliedAt: 1_700_000_000_000 })],
        patterns: [],
        expected: { applied: '1', holding: '0', recurring: '0' },
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
    // Iter-7 a11y: per-row buttons now expose the full row context
    // (rule + bucket + target + when) via aria-label; the prior
    // mouse-only `title=` redundancy was dropped.
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.lcars-applied-summary__row-btn'),
    );
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
        // Phase 4 P0.5: with no `onRefreshIndex` callback wired here,
        // the chip falls back to the install-locally hosted copy.
        // Iter-7 a11y: copy shortened to fit within stale-chip header
        // real estate; "INSTALL LOCALLY" is the shortened form of the
        // prior "INSTALL CHAT-ARCH LOCALLY TO REFRESH".
        expect(
          screen.getByText(/INDEX IS STALE — INSTALL LOCALLY/i),
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

    it('renders chip as a button and fires onRefreshIndex when provided', () => {
      vi.useFakeTimers();
      try {
        const apply = 1_700_000_000_000;
        const now = apply + 60 * MS_DAY;
        const manifest = apply - 5 * MS_DAY;
        vi.setSystemTime(now);
        const onRefresh = vi.fn();
        render(
          <AppliedImprovementsSummary
            applied={ledger([entry({ id: 'a', patternId: 'p1', appliedAt: apply })])}
            corrections={corrections([pattern({ id: 'p1' })])}
            manifestGeneratedAt={manifest}
            onSelectPattern={() => {}}
            onRefreshIndex={onRefresh}
          />,
        );
        // Iter-7 a11y: aria-label dropped in favor of letting visible
        // text drive the accessible name; visible label shortened
        // from the prior "RUN UPDATE LOCAL TO CHECK FOR NEW VIOLATIONS".
        const chip = screen.getByRole('button', {
          name: /INDEX IS STALE — REFRESH/i,
        });
        expect(chip.tagName).toBe('BUTTON');
        fireEvent.click(chip);
        expect(onRefresh).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders chip as non-interactive span with install-locally copy when onRefreshIndex omitted', () => {
      // Phase 4 P0.5: hosted static build has no UPDATE LOCAL button to
      // point at. The chip's copy on the no-callback branch should
      // tell the visitor to install chat-arch locally instead.
      vi.useFakeTimers();
      try {
        const apply = 1_700_000_000_000;
        const now = apply + 60 * MS_DAY;
        const manifest = apply - 5 * MS_DAY;
        vi.setSystemTime(now);
        render(
          <AppliedImprovementsSummary
            applied={ledger([entry({ id: 'a', patternId: 'p1', appliedAt: apply })])}
            corrections={corrections([pattern({ id: 'p1' })])}
            manifestGeneratedAt={manifest}
            onSelectPattern={() => {}}
          />,
        );
        // Iter-7 a11y: visible copy shortened to fit chip header real
        // estate. Drops "CHAT-ARCH" + "TO REFRESH" tail.
        const chip = screen.getByText(/INDEX IS STALE — INSTALL LOCALLY TO REFRESH/i);
        expect(chip.tagName).toBe('SPAN');
        // Non-interactive — no click handler attached as a button.
        expect(
          screen.queryByRole('button', { name: /index is stale/i }),
        ).toBeNull();
        // The "RUN UPDATE LOCAL" wording must NOT appear here — this is
        // the hosted-mode copy path.
        expect(screen.queryByText(/RUN UPDATE LOCAL/i)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('GONE pattern classification (P0.2 review fix)', () => {
    it('GONE entries do not inflate HOLDING and still render the GONE badge', () => {
      const entries = [
        entry({ id: 'a', patternId: 'hold', appliedAt: 1_700_000_000_000 }),
        entry({ id: 'b', patternId: 'gone1', appliedAt: 1_700_010_000_000 }),
        entry({ id: 'c', patternId: 'gone2', appliedAt: 1_700_020_000_000 }),
      ];
      render(
        <AppliedImprovementsSummary
          applied={ledger(entries)}
          corrections={corrections([pattern({ id: 'hold' })])}
          manifestGeneratedAt={null}
          onSelectPattern={() => {}}
        />,
      );
      // 1 holding (only "hold"), 0 recurring, 2 gone — but only the
      // three displayed stats are APPLIED / HOLDING / RECURRING. The
      // gone tally is implicit via the GONE row badges.
      const holding = screen.getByText('HOLDING').previousSibling as HTMLElement;
      const recurring = screen.getByText('RECURRING').previousSibling as HTMLElement;
      expect(holding.textContent).toBe('1');
      expect(recurring.textContent).toBe('0');

      // GONE rows still render in the timeline.
      fireEvent.click(screen.getByRole('button', { name: /VIEW PATCH LEDGER/i }));
      const goneBadges = Array.from(
        document.querySelectorAll('.lcars-applied-summary__row-bucket--gone'),
      );
      expect(goneBadges).toHaveLength(2);
      for (const b of goneBadges) {
        expect(b.textContent).toBe('GONE');
      }
    });
  });

  describe('corrupt appliedAt clamping (P1.2 review fix)', () => {
    it('ignores entries with implausibly-old appliedAt when computing the headline', () => {
      vi.useFakeTimers();
      try {
        const now = 1_730_000_000_000;
        vi.setSystemTime(now);
        // Single entry with a corrupt epoch — without the floor this
        // would render "SINCE YOU PATCHED 20000D AGO" or similar.
        render(
          <AppliedImprovementsSummary
            applied={ledger([entry({ id: 'a', patternId: 'p1', appliedAt: 1 })])}
            corrections={corrections([pattern({ id: 'p1' })])}
            manifestGeneratedAt={null}
            onSelectPattern={() => {}}
          />,
        );
        const headline = document.querySelector(
          '.lcars-applied-summary__headline',
        );
        expect(headline?.textContent).toBe('SINCE YOU PATCHED');
        expect(headline?.textContent).not.toMatch(/\d/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the next-most-recent plausible entry when one is corrupt', () => {
      vi.useFakeTimers();
      try {
        const now = 1_730_000_000_000;
        vi.setSystemTime(now);
        const plausible = now - 64 * MS_DAY;
        render(
          <AppliedImprovementsSummary
            applied={ledger([
              entry({ id: 'corrupt', patternId: 'p1', appliedAt: 1 }),
              entry({ id: 'good', patternId: 'p2', appliedAt: plausible }),
            ])}
            corrections={corrections([pattern({ id: 'p1' }), pattern({ id: 'p2' })])}
            manifestGeneratedAt={null}
            onSelectPattern={() => {}}
          />,
        );
        const headline = screen.getByText(/SINCE YOU PATCHED/);
        expect(headline.textContent).toMatch(/SINCE YOU PATCHED 2MO AGO/);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
