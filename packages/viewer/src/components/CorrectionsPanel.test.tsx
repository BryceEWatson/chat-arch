import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type {
  CorrectionPattern,
  CorrectionsFile,
  ProposedUpgrade,
} from '@chat-arch/schema';
import type * as CorrectionsLoaderModule from '../data/correctionsLoader.js';

// Mock the loader module before importing the panel so the mocked
// implementations are in place when the panel's effects fire.
vi.mock('../data/correctionsLoader.js', async () => {
  // Pull the real `mergeAppliedImprovements` so panel-level merge
  // assertions in the new tests below run against the production
  // implementation; only the I/O entry points are stubbed.
  const actual = await vi.importActual<typeof CorrectionsLoaderModule>(
    '../data/correctionsLoader.js',
  );
  return {
    loadCorrectionsFile: vi.fn(),
    loadCorrectionCandidatesFile: vi.fn(),
    loadAppliedImprovementsFile: vi.fn(async () => null),
    mergeAppliedImprovements: actual.mergeAppliedImprovements,
  };
});
vi.mock('../data/mineCorrectionsClient.js', () => ({
  startMineCorrections: vi.fn(),
  fetchCorrectionRunStatus: vi.fn(async () => null),
  clearCorrections: vi.fn(async () => ({ removed: [] })),
  probeClearCorrections: vi.fn(async () => false),
  probeMineCorrections: vi.fn(async () => ({
    ok: true,
    available: true,
    busy: false,
    busyRequestId: null,
    autoWindow: {
      windowDays: 14,
      candidateCount: 12,
      reasoning: 'First run: targeting the most-recent 12 candidates.',
      mode: 'first-run',
    },
  })),
}));

import {
  loadCorrectionsFile,
  loadCorrectionCandidatesFile,
  loadAppliedImprovementsFile,
} from '../data/correctionsLoader.js';
import { CorrectionsPanel } from './CorrectionsPanel.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mockedLoadCorrections = vi.mocked(loadCorrectionsFile);
const mockedLoadCandidates = vi.mocked(loadCorrectionCandidatesFile);
const mockedLoadApplied = vi.mocked(loadAppliedImprovementsFile);

function pattern(overrides: Partial<CorrectionPattern> & { id: string }): CorrectionPattern {
  return {
    id: overrides.id,
    canonicalRule: overrides.canonicalRule ?? `rule ${overrides.id}`,
    instanceIds: overrides.instanceIds ?? [],
    occurrenceCount: overrides.occurrenceCount ?? 3,
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_700_100_000_000,
    scope: { kind: 'global' },
    proposedUpgrades: overrides.proposedUpgrades ?? [],
    confidence: overrides.confidence ?? 0.5,
    recurringPostApplication: overrides.recurringPostApplication ?? false,
    alreadyEncoded: overrides.alreadyEncoded ?? false,
  };
}

function file(patterns: readonly CorrectionPattern[]): CorrectionsFile {
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

describe('CorrectionsPanel', () => {
  beforeEach(() => {
    mockedLoadCorrections.mockReset();
    mockedLoadCandidates.mockReset();
    mockedLoadApplied.mockReset();
    mockedLoadApplied.mockResolvedValue(null);
  });

  it('renders the empty state when both fetches return null', async () => {
    mockedLoadCorrections.mockResolvedValue(null);
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByText(/No correction candidates yet/i)).toBeDefined();
    });
  });

  it('renders the candidates-only message when corrections.json is absent but candidates exist', async () => {
    mockedLoadCorrections.mockResolvedValue(null);
    mockedLoadCandidates.mockResolvedValue({
      ...file([]),
      // 4 raw candidate corrections, no patterns yet (clustering hasn't run).
      corrections: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'a' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'b' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'c' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'd' } as any,
      ],
    });
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByText(/4 candidates ready to mine/i)).toBeDefined();
    });
    // The mocked autoWindow probe returns count=12, so the single
    // primary CTA renders "MINE ALL 12".
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /MINE ALL 12/ }),
      ).toBeDefined();
    });
  });

  it('sorts patterns into the three buckets correctly', async () => {
    const patterns = [
      pattern({ id: 'r1', canonicalRule: 'recurring rule', recurringPostApplication: true }),
      pattern({ id: 'e1', canonicalRule: 'encoded rule', alreadyEncoded: true }),
      pattern({ id: 'n1', canonicalRule: 'new rule' }),
      // recurring + alreadyEncoded → still RECURRING (it's the stronger signal).
      pattern({
        id: 'r2',
        canonicalRule: 'recurring and encoded',
        recurringPostApplication: true,
        alreadyEncoded: true,
      }),
    ];
    mockedLoadCorrections.mockResolvedValue(file(patterns));
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByLabelText('RECURRING AFTER APPLIED')).toBeDefined();
    });
    const recurring = screen.getByLabelText('RECURRING AFTER APPLIED');
    const encoded = screen.getByLabelText('ALREADY ENCODED BUT FAILING');
    const fresh = screen.getByLabelText('NEW PATTERNS TO ENCODE');

    expect(within(recurring).getByText('recurring rule')).toBeDefined();
    expect(within(recurring).getByText('recurring and encoded')).toBeDefined();
    expect(within(encoded).getByText('encoded rule')).toBeDefined();
    expect(within(fresh).getByText('new rule')).toBeDefined();

    // No leakage between buckets.
    expect(within(recurring).queryByText('encoded rule')).toBeNull();
    expect(within(encoded).queryByText('recurring rule')).toBeNull();
    expect(within(fresh).queryByText('encoded rule')).toBeNull();
  });

  it('sorts patterns within a bucket by confidence desc, then occurrenceCount desc', async () => {
    const patterns = [
      pattern({ id: 'low', canonicalRule: 'low confidence', confidence: 0.2, occurrenceCount: 9 }),
      pattern({ id: 'hi', canonicalRule: 'high confidence', confidence: 0.95, occurrenceCount: 3 }),
      pattern({ id: 'mid-a', canonicalRule: 'mid a', confidence: 0.5, occurrenceCount: 5 }),
      pattern({ id: 'mid-b', canonicalRule: 'mid b', confidence: 0.5, occurrenceCount: 8 }),
    ];
    mockedLoadCorrections.mockResolvedValue(file(patterns));
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByText('NEW PATTERNS TO ENCODE')).toBeDefined();
    });
    const fresh = screen.getByLabelText('NEW PATTERNS TO ENCODE');
    const titles = Array.from(
      fresh.querySelectorAll('.lcars-correction-pattern__rule'),
    ).map((el) => el.textContent);
    // confidence: 0.95, 0.5 (count 8), 0.5 (count 5), 0.2.
    expect(titles).toEqual(['high confidence', 'mid b', 'mid a', 'low confidence']);
  });

  it('renders the "Nothing here — good." placeholder for empty buckets', async () => {
    mockedLoadCorrections.mockResolvedValue(
      file([pattern({ id: 'n1', canonicalRule: 'only a new pattern' })]),
    );
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByText('NEW PATTERNS TO ENCODE')).toBeDefined();
    });
    const recurring = screen.getByLabelText('RECURRING AFTER APPLIED');
    const encoded = screen.getByLabelText('ALREADY ENCODED BUT FAILING');
    expect(within(recurring).getByText('Nothing here — good.')).toBeDefined();
    expect(within(encoded).getByText('Nothing here — good.')).toBeDefined();
  });

  describe('AppliedImprovementsSummary mount (Phase 2b)', () => {
    it('does not render the summary when there are no applied entries', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([pattern({ id: 'n1', canonicalRule: 'a new rule' })]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      mockedLoadApplied.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByText('NEW PATTERNS TO ENCODE')).toBeDefined();
      });
      expect(screen.queryByLabelText('since you patched')).toBeNull();
    });

    it('mounts the summary above the buckets when applied entries exist', async () => {
      const u: ProposedUpgrade = {
        target: 'global-claude-md',
        targetPath: '~/.claude/CLAUDE.md',
        patch: '- rule X',
        rationale: 'r',
        applied: false,
        appliedAt: null,
      };
      const p = pattern({
        id: 'p-summary',
        canonicalRule: 'rule-for-summary',
        proposedUpgrades: [u],
      });
      mockedLoadCorrections.mockResolvedValue(file([p]));
      mockedLoadCandidates.mockResolvedValue(null);
      mockedLoadApplied.mockResolvedValue({
        schemaVersion: 1,
        generatedAt: 1_700_200_000_000,
        entries: [
          {
            id: 'a-1',
            patternId: 'p-summary',
            appliedAt: 1_700_120_000_000,
            ruleSummary: 'rule-for-summary',
            proposedUpgrade: { ...u, applied: true, appliedAt: 1_700_120_000_000 },
          },
        ],
      });
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByLabelText('since you patched')).toBeDefined();
      });
      // Stats row renders all three labels.
      expect(screen.getByText('APPLIED')).toBeDefined();
      expect(screen.getByText('HOLDING')).toBeDefined();
      expect(screen.getByText('RECURRING')).toBeDefined();
    });

    it('plumbs onSelectPattern → data-highlighted on the matching card', async () => {
      const u: ProposedUpgrade = {
        target: 'global-claude-md',
        targetPath: '~/.claude/CLAUDE.md',
        patch: '- rule X',
        rationale: 'r',
        applied: false,
        appliedAt: null,
      };
      const p = pattern({
        id: 'highlight-me',
        canonicalRule: 'rule-to-highlight',
        proposedUpgrades: [u],
      });
      mockedLoadCorrections.mockResolvedValue(file([p]));
      mockedLoadCandidates.mockResolvedValue(null);
      mockedLoadApplied.mockResolvedValue({
        schemaVersion: 1,
        generatedAt: 1_700_200_000_000,
        entries: [
          {
            id: 'a-1',
            patternId: 'highlight-me',
            appliedAt: 1_700_120_000_000,
            ruleSummary: 'rule-to-highlight',
            proposedUpgrade: { ...u, applied: true, appliedAt: 1_700_120_000_000 },
          },
        ],
      });
      const { container } = render(<CorrectionsPanel dataDirBaseUrl="/x" />);
      await waitFor(() => {
        expect(screen.getByLabelText('since you patched')).toBeDefined();
      });
      // Expand the timeline, click the row, assert data-highlighted lights up.
      const expand = screen.getByRole('button', { name: /VIEW PATCH LEDGER/i });
      fireEvent.click(expand);
      const rowBtn = await screen.findByTitle("Jump to this pattern's card");
      fireEvent.click(rowBtn);
      await waitFor(() => {
        const highlighted = container.querySelector(
          '[data-highlighted="true"]',
        );
        expect(highlighted).not.toBeNull();
        expect(highlighted!.getAttribute('data-pattern-id')).toBe('highlight-me');
      });
    });
  });

  describe('applied-improvements merge', () => {
    it('flips a NEW pattern into RECURRING when ledger entry has appliedAt < lastSeen', async () => {
      // The pattern itself was emitted with recurringPostApplication =
      // false, but the ledger says it was applied earlier; merge
      // should re-categorize it.
      const u: ProposedUpgrade = {
        target: 'global-claude-md',
        targetPath: '~/.claude/CLAUDE.md',
        patch: '- rule X',
        rationale: 'r',
        applied: false,
        appliedAt: null,
      };
      const p = pattern({
        id: 'p-recurring',
        canonicalRule: 'flips into recurring',
        proposedUpgrades: [u],
        recurringPostApplication: false,
      });
      mockedLoadCorrections.mockResolvedValue(file([p]));
      mockedLoadCandidates.mockResolvedValue(null);
      mockedLoadApplied.mockResolvedValue({
        schemaVersion: 1,
        generatedAt: 1_700_200_000_000,
        entries: [
          {
            id: 'a-1',
            patternId: 'p-recurring',
            // lastSeen = 1_700_100_000_000 from the pattern factory.
            appliedAt: 1_700_050_000_000,
            ruleSummary: 'flips into recurring',
            proposedUpgrade: { ...u, applied: true, appliedAt: 1_700_050_000_000 },
          },
        ],
      });
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        const recurring = screen.getByLabelText('RECURRING AFTER APPLIED');
        expect(within(recurring).getByText('flips into recurring')).toBeDefined();
      });
      const fresh = screen.getByLabelText('NEW PATTERNS TO ENCODE');
      expect(within(fresh).queryByText('flips into recurring')).toBeNull();
    });

    it('treats applied: true on the merged upgrade as initial APPLIED state', async () => {
      const u: ProposedUpgrade = {
        target: 'global-claude-md',
        targetPath: '~/.claude/CLAUDE.md',
        patch: '- rule Y',
        rationale: 'r',
        applied: false,
        appliedAt: null,
      };
      const p = pattern({
        id: 'p-applied',
        canonicalRule: 'already applied via ledger',
        proposedUpgrades: [u],
        instanceIds: [],
      });
      mockedLoadCorrections.mockResolvedValue(file([p]));
      mockedLoadCandidates.mockResolvedValue(null);
      mockedLoadApplied.mockResolvedValue({
        schemaVersion: 1,
        generatedAt: 1_700_200_000_000,
        entries: [
          {
            id: 'a-1',
            patternId: 'p-applied',
            appliedAt: 1_700_120_000_000,
            ruleSummary: 'already applied',
            proposedUpgrade: { ...u, applied: true, appliedAt: 1_700_120_000_000 },
          },
        ],
      });
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByText('already applied via ledger')).toBeDefined();
      });
      const toggles = screen.getAllByRole('button', { name: /SHOW DETAILS/i });
      // Three buckets render their cards; the one we want is the one
      // that surfaces our pattern, but all toggles are equivalent here.
      // Click the first toggle that belongs to our pattern's card.
      // Just clicking any toggle for this pattern is enough — there's only one.
      for (const t of toggles) t.click();
      // APPLIED ✓ should appear without any APPLY interaction.
      await waitFor(() => {
        expect(screen.getByText(/APPLIED ✓/)).toBeDefined();
      });
    });
  });

  // Phase 4 — when CorrectionsPanel renders on a hosted static build
  // (rescanAvailable=false), the bucket header copy explicitly
  // referencing CLAUDE.md / "ship it" is meaningless to a non-developer
  // visitor on chat-arch.dev. Verify the reframed labels + blurbs land.
  describe('Phase 4 — hosted demo blurbs (rescanAvailable=false)', () => {
    it('reframes the encoded bucket label + blurb to avoid CLAUDE.md jargon', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([
          pattern({ id: 'e1', canonicalRule: 'demo encoded', alreadyEncoded: true }),
        ]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      // No rescanAvailable → defaults to false → hosted-demo blurbs.
      render(<CorrectionsPanel dataDirBaseUrl="/x" />);
      await waitFor(() => {
        expect(screen.getByLabelText('TOLD NOT TO, STILL DOES IT')).toBeDefined();
      });
      const bucket = screen.getByLabelText('TOLD NOT TO, STILL DOES IT');
      // Multiple elements may match (the title + the blurb both
      // contain the phrase); presence of any is enough.
      expect(within(bucket).getAllByText(/told not to/i).length).toBeGreaterThan(0);
      // Canonical CLAUDE.md jargon must not leak into the demo copy.
      expect(within(bucket).queryByText(/already exists in CLAUDE\.md/i)).toBeNull();
    });

    it('reframes the recurring bucket label to "STILL FAILING AFTER A FIX"', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([
          pattern({
            id: 'r1',
            canonicalRule: 'demo recurring',
            recurringPostApplication: true,
          }),
        ]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" />);
      await waitFor(() => {
        expect(screen.getByLabelText('STILL FAILING AFTER A FIX')).toBeDefined();
      });
    });

    it('keeps the canonical labels when rescanAvailable=true (local dev)', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([
          pattern({ id: 'e1', canonicalRule: 'local encoded', alreadyEncoded: true }),
        ]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByLabelText('ALREADY ENCODED BUT FAILING')).toBeDefined();
      });
      // Hosted-only label must not be present.
      expect(screen.queryByLabelText('TOLD NOT TO, STILL DOES IT')).toBeNull();
    });
  });

  // Header-row redesign: "Generated <iso>" was demoted from a row of
  // its own to a "Last mined …" chip in the title row. Verify the chip
  // renders relative time and keeps the absolute ISO in `title=` for
  // debugging without polluting the layout.
  describe('Header timestamp chip', () => {
    it('renders the chip in the title row when corrections.json has generatedAt', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([pattern({ id: 'n1', canonicalRule: 'rule one' })]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByText(/Last mined/i)).toBeDefined();
      });
      const chip = screen.getByText(/Last mined/i);
      // Absolute ISO survives in `title=` for tooltip / debugging.
      expect(chip.getAttribute('title')).toMatch(/Generated 20\d\d-/);
      // Demoted row that used to read "Generated 20...Z" should be gone.
      expect(screen.queryByText(/^Generated 20\d\d-/)).toBeNull();
    });
  });

  // First-principles simplification (Tight): CoverageMeter shows just
  // the bar + one figure ("271 / 581 mined"). The label, funnel
  // sentence, actionable %, and pattern count are gone — diagnostic
  // info now lives only behind the "details ▸" chevron.
  describe('CoverageMeter — Tight layout', () => {
    it('renders just the bar + "N / M mined" figure (no label, no funnel sentence)', async () => {
      const c: CorrectionsFile = {
        generatedAt: 1_700_000_000_000,
        corrections: [
          { id: 'c1', classification: { actionable: true, ruleSummary: 'r' } },
          { id: 'c2', classification: { actionable: false, ruleSummary: 'r' } },
          { id: 'c3', classification: { actionable: true, ruleSummary: 'r' } },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
        patterns: [pattern({ id: 'p1', canonicalRule: 'pat one' })],
        pipeline: {
          heuristicRecall: true,
          llmClassification: true,
          embeddingClustering: true,
          claudeMdCrossCheck: true,
        },
      };
      const cands = {
        ...c,
        corrections: [
          { id: 'c1' },
          { id: 'c2' },
          { id: 'c3' },
          { id: 'c4' },
          { id: 'c5' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any,
      };
      mockedLoadCorrections.mockResolvedValue(c);
      mockedLoadCandidates.mockResolvedValue(cands);
      const { container } = render(
        <CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />,
      );
      await waitFor(() => {
        const figure = container.querySelector(
          '.lcars-corrections__coverage-figure',
        );
        expect(figure?.textContent ?? '').toMatch(/3\s*\/\s*5\s*mined/);
      });
      // Cut by the simplification — these strings should be absent.
      expect(screen.queryByText('MINING PROGRESS')).toBeNull();
      expect(screen.queryByText('ANALYSIS COVERAGE')).toBeNull();
      expect(screen.queryByText(/Of the .* mined/)).toBeNull();
      expect(screen.queryByText(/became actionable corrections/)).toBeNull();
      expect(screen.queryByText(/still to mine/)).toBeNull();
    });
  });

  // MINE ALL collapse: the recent/older split was killed in favor of a
  // single CTA that mines every unprocessed candidate in one pass.
  // Verify the trigger renders one status + one button, and that all
  // the historical jargon (recent/older/backfill/auto-window) is gone.
  describe('MiningTrigger — single MINE ALL CTA', () => {
    it('renders one status sentence + one primary CTA with the total count', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([pattern({ id: 'p1', canonicalRule: 'rule' })]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      const { container } = render(
        <CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />,
      );
      // Mocked autoWindow probe returns candidateCount=12; with
      // selection='all' on the wire, that's the full unprocessed set.
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /MINE ALL 12/ }),
        ).toBeDefined();
      });
      const status = container.querySelector(
        '.lcars-corrections__trigger-status',
      );
      expect(status?.textContent ?? '').toMatch(/12 ready to mine/);
      const cta = screen.getByRole('button', { name: /MINE ALL 12/ });
      expect(cta.getAttribute('title')).toMatch(/Mine all 12 unprocessed candidates/);
      // Killed copy — no recent/older split, no backfill jargon, no
      // auto-window chip, no kicker label.
      expect(screen.queryByText('NEXT MINING PASS')).toBeNull();
      expect(screen.queryByText('AUTO WINDOW')).toBeNull();
      expect(screen.queryByText(/MINE\s+\d+\s+RECENT/)).toBeNull();
      expect(screen.queryByText(/MINE\s+\d+\s+OLDER/)).toBeNull();
      expect(screen.queryByText(/^BACKFILL OLDER/)).toBeNull();
      expect(screen.queryByText(/← back to recent/i)).toBeNull();
      expect(screen.queryByText(/RE-MINE CORRECTIONS/i)).toBeNull();
    });
  });
});
