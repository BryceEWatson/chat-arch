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
    ...(overrides.topic !== undefined ? { topic: overrides.topic } : {}),
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

  it('groups patterns into buckets by topic, label uppercased', async () => {
    const patterns = [
      pattern({ id: 'g1', canonicalRule: 'git rule a', topic: 'Git Workflow' }),
      pattern({ id: 't1', canonicalRule: 'test rule a', topic: 'Test Discipline' }),
      pattern({ id: 'g2', canonicalRule: 'git rule b', topic: 'Git Workflow' }),
    ];
    mockedLoadCorrections.mockResolvedValue(file(patterns));
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByLabelText('GIT WORKFLOW')).toBeDefined();
    });
    const git = screen.getByLabelText('GIT WORKFLOW');
    const test = screen.getByLabelText('TEST DISCIPLINE');

    expect(within(git).getByText('git rule a')).toBeDefined();
    expect(within(git).getByText('git rule b')).toBeDefined();
    expect(within(test).getByText('test rule a')).toBeDefined();
    // No leakage across topics.
    expect(within(git).queryByText('test rule a')).toBeNull();
    expect(within(test).queryByText('git rule a')).toBeNull();
  });

  it('falls back to an UNTAGGED bucket for patterns without a topic field', async () => {
    const patterns = [
      pattern({ id: 'a', canonicalRule: 'pre-topic-stage rule' }),
      pattern({ id: 'b', canonicalRule: 'another untagged', topic: '' }),
      pattern({ id: 'c', canonicalRule: 'tagged rule', topic: 'Tool Usage' }),
    ];
    mockedLoadCorrections.mockResolvedValue(file(patterns));
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByLabelText('UNTAGGED')).toBeDefined();
    });
    const untagged = screen.getByLabelText('UNTAGGED');
    const tool = screen.getByLabelText('TOOL USAGE');
    expect(within(untagged).getByText('pre-topic-stage rule')).toBeDefined();
    expect(within(untagged).getByText('another untagged')).toBeDefined();
    expect(within(tool).getByText('tagged rule')).toBeDefined();
  });

  it('orders buckets: topics with recurring patterns first, then by total weight desc', async () => {
    const patterns = [
      // Heavy non-recurring bucket — would win on weight alone.
      pattern({ id: 'h1', topic: 'Heavy', canonicalRule: 'heavy 1', occurrenceCount: 20 }),
      pattern({ id: 'h2', topic: 'Heavy', canonicalRule: 'heavy 2', occurrenceCount: 20 }),
      // Light bucket with a single RECURRING pattern — must hoist above Heavy.
      pattern({
        id: 'r1',
        topic: 'Recurring Topic',
        canonicalRule: 'recurring',
        recurringPostApplication: true,
        occurrenceCount: 3,
      }),
      // Medium-weight bucket between them.
      pattern({ id: 'm1', topic: 'Medium', canonicalRule: 'medium', occurrenceCount: 10 }),
    ];
    mockedLoadCorrections.mockResolvedValue(file(patterns));
    mockedLoadCandidates.mockResolvedValue(null);
    const { container } = render(
      <CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('RECURRING TOPIC')).toBeDefined();
    });
    const sections = Array.from(
      container.querySelectorAll('.lcars-corrections__buckets > section'),
    ).map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['RECURRING TOPIC', 'HEAVY', 'MEDIUM']);
  });

  it('within a bucket: recurring sorts first, then by confidence desc', async () => {
    const patterns = [
      pattern({
        id: 'low',
        topic: 'T',
        canonicalRule: 'low confidence',
        confidence: 0.2,
        occurrenceCount: 9,
      }),
      pattern({
        id: 'hi',
        topic: 'T',
        canonicalRule: 'high confidence',
        confidence: 0.95,
        occurrenceCount: 3,
      }),
      pattern({
        id: 'rec',
        topic: 'T',
        canonicalRule: 'recurring even with low confidence',
        confidence: 0.3,
        occurrenceCount: 4,
        recurringPostApplication: true,
      }),
    ];
    mockedLoadCorrections.mockResolvedValue(file(patterns));
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByLabelText('T')).toBeDefined();
    });
    const bucket = screen.getByLabelText('T');
    const titles = Array.from(
      bucket.querySelectorAll('.lcars-correction-pattern__rule'),
    ).map((el) => el.textContent);
    // recurring → first; rest by confidence desc.
    expect(titles).toEqual([
      'recurring even with low confidence',
      'high confidence',
      'low confidence',
    ]);
  });

  // Codex review feedback on PR #32: the dropped `--recurring|encoded|new`
  // modifier classes used to drive bucket border + background + title
  // color (signal-based urgency). With dynamic topics those hardcodes
  // don't fit, but the urgency signal still lives on every pattern as
  // `recurringPostApplication` / `alreadyEncoded`. The replacement is
  // `data-has-recurring` / `data-has-encoded` attribute hooks that the
  // stylesheet now keys off. These tests lock the contract.
  describe('bucket urgency attributes', () => {
    it('flags data-has-recurring=true when the bucket contains a recurring pattern', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([
          pattern({
            id: 'r1',
            topic: 'Git Workflow',
            canonicalRule: 'a recurring rule',
            recurringPostApplication: true,
          }),
        ]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByLabelText('GIT WORKFLOW')).toBeDefined();
      });
      const bucket = screen.getByLabelText('GIT WORKFLOW');
      expect(bucket.getAttribute('data-has-recurring')).toBe('true');
      expect(bucket.getAttribute('data-has-encoded')).toBe('false');
    });

    it('flags data-has-encoded=true when the bucket has an encoded-but-not-recurring pattern', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([
          pattern({
            id: 'e1',
            topic: 'Tool Usage',
            canonicalRule: 'encoded',
            alreadyEncoded: true,
          }),
        ]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByLabelText('TOOL USAGE')).toBeDefined();
      });
      const bucket = screen.getByLabelText('TOOL USAGE');
      expect(bucket.getAttribute('data-has-encoded')).toBe('true');
      expect(bucket.getAttribute('data-has-recurring')).toBe('false');
    });

    it('prefers data-has-recurring when a bucket has both signals (recurring wins)', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([
          pattern({
            id: 'r-and-e',
            topic: 'Mixed',
            canonicalRule: 'recurring + encoded',
            recurringPostApplication: true,
            alreadyEncoded: true,
          }),
        ]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByLabelText('MIXED')).toBeDefined();
      });
      const bucket = screen.getByLabelText('MIXED');
      // Builder records `recurring` and skips the `encoded` branch
      // (else-if). CSS rule order also ensures the recurring style
      // wins when both attributes are 'true' on the same element.
      expect(bucket.getAttribute('data-has-recurring')).toBe('true');
      expect(bucket.getAttribute('data-has-encoded')).toBe('false');
    });

    it('flags both attributes as false for plain non-urgent buckets', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([
          pattern({
            id: 'plain',
            topic: 'New Stuff',
            canonicalRule: 'just a new pattern',
          }),
        ]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      await waitFor(() => {
        expect(screen.getByLabelText('NEW STUFF')).toBeDefined();
      });
      const bucket = screen.getByLabelText('NEW STUFF');
      expect(bucket.getAttribute('data-has-recurring')).toBe('false');
      expect(bucket.getAttribute('data-has-encoded')).toBe('false');
    });
  });

  it('does not render empty-bucket placeholders (no Nothing here — good.)', async () => {
    mockedLoadCorrections.mockResolvedValue(
      file([pattern({ id: 'n1', canonicalRule: 'only one', topic: 'Solo' })]),
    );
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
    await waitFor(() => {
      expect(screen.getByLabelText('SOLO')).toBeDefined();
    });
    // Only one section renders; the old empty-bucket placeholder is gone.
    expect(screen.queryByText(/Nothing here/i)).toBeNull();
    expect(screen.queryByLabelText('RECURRING AFTER APPLIED')).toBeNull();
    expect(screen.queryByLabelText('ALREADY ENCODED BUT FAILING')).toBeNull();
    expect(screen.queryByLabelText('NEW PATTERNS TO ENCODE')).toBeNull();
  });

  describe('AppliedImprovementsSummary mount (Phase 2b)', () => {
    it('does not render the summary when there are no applied entries', async () => {
      mockedLoadCorrections.mockResolvedValue(
        file([pattern({ id: 'n1', canonicalRule: 'a new rule' })]),
      );
      mockedLoadCandidates.mockResolvedValue(null);
      mockedLoadApplied.mockResolvedValue(null);
      render(<CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />);
      // Untagged bucket renders (pattern has no topic field); summary does not.
      await waitFor(() => {
        expect(screen.getByLabelText('UNTAGGED')).toBeDefined();
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
      // The pattern lands in the UNTAGGED bucket (no topic) but should now
      // bear the recurring signal — the merge layer flipped
      // recurringPostApplication=true based on the ledger entry. Verify the
      // bucket sort puts it first (recurring sorts to top within a bucket).
      await waitFor(() => {
        expect(screen.getByLabelText('UNTAGGED')).toBeDefined();
      });
      const bucket = screen.getByLabelText('UNTAGGED');
      expect(within(bucket).getByText('flips into recurring')).toBeDefined();
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

  // The Phase 4 hosted-demo blurb relabeling is gone — fixed taxonomy
  // (RECURRING / ENCODED / NEW) was replaced with LLM-derived dynamic
  // topic buckets, so there's no per-host bucket copy to reframe.
  // The hosted demo fixture in `demoUpload.ts` now ships its own
  // topic assignments and renders identically to local mining output.

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

  // SCANNED panel: the per-source missing note now splits "transcript
  // file missing on disk" from "CLI crashed before writing one"
  // (Cowork's case). The split makes it explicit that the user's data
  // *is* there in audit.jsonl for the crashed cases — different
  // remediation path than the genuinely-gone files.
  describe('SCANNED panel — crashed vs missing split', () => {
    function fileWithScanStats(args: {
      sessionsBySource: Record<string, number>;
      sessionsMissingBySource: Record<string, number>;
      sessionsCrashedBySource?: Record<string, number>;
    }): CorrectionsFile {
      return {
        generatedAt: 1_700_000_000_000,
        // At least one candidate is required for the CoverageMeter to
        // mount (it gates on total > 0). The bucketing logic only cares
        // about the `id` field for the headline; classification stays
        // null so notRun=true in the LLM MINE stage.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        corrections: [{ id: 'cand-1' }, { id: 'cand-2' }] as any,
        patterns: [],
        pipeline: {
          heuristicRecall: true,
          llmClassification: false,
          embeddingClustering: false,
          claudeMdCrossCheck: false,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scanStats: {
          sessionsInManifest: 0,
          sessionsScanned: 0,
          sessionsMissing: 0,
          sessionsBySource: args.sessionsBySource,
          sessionsMissingBySource: args.sessionsMissingBySource,
          ...(args.sessionsCrashedBySource
            ? { sessionsCrashedBySource: args.sessionsCrashedBySource }
            : {}),
          rawUserTurns: 0,
          wrapperFiltered: 0,
          tooLongFiltered: 0,
          survivingTurns: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      };
    }

    it('renders split note when both crashed and true-missing exist', async () => {
      mockedLoadCorrections.mockResolvedValue(null);
      mockedLoadCandidates.mockResolvedValue(
        fileWithScanStats({
          sessionsBySource: { cowork: 323 },
          sessionsMissingBySource: { cowork: 51 },
          sessionsCrashedBySource: { cowork: 14 },
        }),
      );
      const { container } = render(
        <CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />,
      );
      // Open the details disclosure so CoverageDetail renders.
      const detailsBtn = await screen.findByRole('button', {
        name: /details/i,
      });
      fireEvent.click(detailsBtn);
      await waitFor(() => {
        expect(
          container.querySelector(
            '[aria-label="EXPORTER SCAN stage"]',
          ),
        ).not.toBeNull();
      });
      // 51 missing total - 14 crashed = 37 true-missing. The note
      // should mention both numbers explicitly.
      const cowork = container.querySelector(
        '[aria-label="EXPORTER SCAN stage"] li:nth-child(3)',
      );
      expect(cowork?.textContent ?? '').toMatch(/272\s*\/\s*323/);
      expect(cowork?.textContent ?? '').toMatch(/37 transcript file missing on disk/);
      expect(cowork?.textContent ?? '').toMatch(/14 CLI crashed/);
    });

    it('renders crashed-only note when all missing are crashes', async () => {
      mockedLoadCorrections.mockResolvedValue(null);
      mockedLoadCandidates.mockResolvedValue(
        fileWithScanStats({
          sessionsBySource: { cowork: 20 },
          sessionsMissingBySource: { cowork: 5 },
          sessionsCrashedBySource: { cowork: 5 },
        }),
      );
      const { container } = render(
        <CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: /details/i }),
      );
      await waitFor(() => {
        expect(
          container.querySelector('[aria-label="EXPORTER SCAN stage"]'),
        ).not.toBeNull();
      });
      const cowork = container.querySelector(
        '[aria-label="EXPORTER SCAN stage"] li:nth-child(3)',
      );
      expect(cowork?.textContent ?? '').toMatch(/5 CLI crashed/);
      expect(cowork?.textContent ?? '').not.toMatch(/missing on disk/);
    });

    it('falls back to legacy "missing on disk" note when no crashed sub-count is reported', async () => {
      mockedLoadCorrections.mockResolvedValue(null);
      mockedLoadCandidates.mockResolvedValue(
        fileWithScanStats({
          sessionsBySource: { cowork: 100 },
          sessionsMissingBySource: { cowork: 10 },
          // No sessionsCrashedBySource — older candidates file shape.
        }),
      );
      const { container } = render(
        <CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: /details/i }),
      );
      await waitFor(() => {
        expect(
          container.querySelector('[aria-label="EXPORTER SCAN stage"]'),
        ).not.toBeNull();
      });
      const cowork = container.querySelector(
        '[aria-label="EXPORTER SCAN stage"] li:nth-child(3)',
      );
      expect(cowork?.textContent ?? '').toMatch(/10 transcript file missing on disk/);
      expect(cowork?.textContent ?? '').not.toMatch(/CLI crashed/);
    });
  });

  // Pipeline-stage markers: the EXPORTER SCAN vs LLM MINE boundary
  // resolves the user's "the headline says 0 mined but the detail
  // shows non-zero counts" confusion. Verify both stages render with
  // the right done/pending status badges and copy.
  describe('pipeline-stage markers', () => {
    function emptyScanStats() {
      return {
        sessionsInManifest: 0,
        sessionsScanned: 0,
        sessionsMissing: 0,
        sessionsBySource: {},
        sessionsMissingBySource: {},
        rawUserTurns: 0,
        wrapperFiltered: 0,
        tooLongFiltered: 0,
        survivingTurns: 0,
      };
    }

    it('marks EXPORTER SCAN as done and LLM MINE as pending when no classifications run yet', async () => {
      mockedLoadCorrections.mockResolvedValue(null);
      mockedLoadCandidates.mockResolvedValue({
        generatedAt: 1_700_000_000_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        corrections: [{ id: 'cand-1' }] as any,
        patterns: [],
        pipeline: {
          heuristicRecall: true,
          llmClassification: false,
          embeddingClustering: false,
          claudeMdCrossCheck: false,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scanStats: emptyScanStats() as any,
      });
      const { container } = render(
        <CorrectionsPanel dataDirBaseUrl="/x" rescanAvailable />,
      );
      fireEvent.click(
        await screen.findByRole('button', { name: /details/i }),
      );
      await waitFor(() => {
        expect(
          container.querySelector('[aria-label="EXPORTER SCAN stage"]'),
        ).not.toBeNull();
      });
      const scanStage = container.querySelector(
        '[aria-label="EXPORTER SCAN stage"]',
      );
      const mineStage = container.querySelector(
        '[aria-label="LLM MINE stage"]',
      );
      expect(scanStage?.getAttribute('data-stage-status')).toBe('done');
      expect(mineStage?.getAttribute('data-stage-status')).toBe('pending');
      expect(scanStage?.textContent ?? '').toMatch(/EXPORTER SCAN/);
      expect(scanStage?.textContent ?? '').toMatch(/done · re-runs on SCAN LOCAL/);
      expect(mineStage?.textContent ?? '').toMatch(/LLM MINE/);
      expect(mineStage?.textContent ?? '').toMatch(/pending · click RE-MINE CORRECTIONS/);
    });
  });
});
