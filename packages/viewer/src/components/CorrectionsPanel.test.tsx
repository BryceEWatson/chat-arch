import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import type { CorrectionPattern, CorrectionsFile } from '@chat-arch/schema';

// Mock the loader module before importing the panel so the mocked
// implementations are in place when the panel's effects fire.
vi.mock('../data/correctionsLoader.js', () => ({
  loadCorrectionsFile: vi.fn(),
  loadCorrectionCandidatesFile: vi.fn(),
}));
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
} from '../data/correctionsLoader.js';
import { CorrectionsPanel } from './CorrectionsPanel.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mockedLoadCorrections = vi.mocked(loadCorrectionsFile);
const mockedLoadCandidates = vi.mocked(loadCorrectionCandidatesFile);

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
  });

  it('renders the empty state when both fetches return null', async () => {
    mockedLoadCorrections.mockResolvedValue(null);
    mockedLoadCandidates.mockResolvedValue(null);
    render(<CorrectionsPanel dataDirBaseUrl="/x" />);
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
    render(<CorrectionsPanel dataDirBaseUrl="/x" />);
    await waitFor(() => {
      expect(screen.getByText(/4 candidates ready to mine/i)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /MINE CORRECTIONS/i })).toBeDefined();
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
    render(<CorrectionsPanel dataDirBaseUrl="/x" />);
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
    render(<CorrectionsPanel dataDirBaseUrl="/x" />);
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
    render(<CorrectionsPanel dataDirBaseUrl="/x" />);
    await waitFor(() => {
      expect(screen.getByText('NEW PATTERNS TO ENCODE')).toBeDefined();
    });
    const recurring = screen.getByLabelText('RECURRING AFTER APPLIED');
    const encoded = screen.getByLabelText('ALREADY ENCODED BUT FAILING');
    expect(within(recurring).getByText('Nothing here — good.')).toBeDefined();
    expect(within(encoded).getByText('Nothing here — good.')).toBeDefined();
  });
});
