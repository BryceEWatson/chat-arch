import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  ProposedUpgrade,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import type * as CorrectionsLoaderModule from './data/correctionsLoader.js';

// Mock the loader so the viewer's mount-time fetch returns the
// fixture we control. `mergeAppliedImprovements` stays real (it's
// pure and the panel still imports it).
vi.mock('./data/correctionsLoader.js', async () => {
  const actual = await vi.importActual<typeof CorrectionsLoaderModule>(
    './data/correctionsLoader.js',
  );
  return {
    loadCorrectionsFile: vi.fn(async () => null),
    loadCorrectionCandidatesFile: vi.fn(async () => null),
    loadAppliedImprovementsFile: vi.fn(async () => null),
    mergeAppliedImprovements: actual.mergeAppliedImprovements,
  };
});
// Mining client probes the standalone server's /api/mine-corrections;
// stub them so the panel doesn't fire real fetches under jsdom.
vi.mock('./data/mineCorrectionsClient.js', () => ({
  startMineCorrections: vi.fn(),
  fetchCorrectionRunStatus: vi.fn(async () => null),
  clearCorrections: vi.fn(async () => ({ removed: [] })),
  probeClearCorrections: vi.fn(async () => false),
  probeMineCorrections: vi.fn(async () => ({
    ok: true,
    available: false,
    busy: false,
    busyRequestId: null,
    autoWindow: null,
  })),
}));
// Apply-correction probe lives in its own module (CorrectionsPanel
// imports it); stub the probe so it doesn't poke the network.
vi.mock('./data/applyCorrectionClient.js', () => ({
  applyCorrection: vi.fn(),
  probeApplyCorrection: vi.fn(async () => false),
}));

import {
  loadAppliedImprovementsFile,
  loadCorrectionsFile,
} from './data/correctionsLoader.js';
import { ChatArchViewer } from './ChatArchViewer.js';
import type { CorrectionsFile } from '@chat-arch/schema';

const mockedLoadApplied = vi.mocked(loadAppliedImprovementsFile);
const mockedLoadCorrections = vi.mocked(loadCorrectionsFile);

function entry(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 100,
    durationMs: 0,
    title: `title-${id}`,
    titleSource: 'cloud-name',
    preview: `preview-${id}`,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

const sampleManifest: SessionManifest = {
  schemaVersion: 1,
  generatedAt: Date.parse('2026-05-01T00:00:00Z'),
  counts: { cloud: 1, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
  sessions: [entry('a', { title: 'Apple pie recipe' })],
};

const proposedUpgrade: ProposedUpgrade = {
  target: 'CLAUDE.md',
  targetPath: '~/.claude/CLAUDE.md',
  proposedPatch: 'add a guard rule',
  rationale: 'pattern recurs',
  suggestedSection: 'Core Directives',
};

const sampleApplied: AppliedImprovement = {
  id: 'apply-1',
  patternId: 'pat-1',
  appliedAt: 1_700_000_000_000,
  ruleSummary: 'use absolute paths in WSL',
  proposedUpgrade,
};

const ledgerWithEntry: AppliedImprovementsFile = {
  schemaVersion: 1,
  generatedAt: 1_700_000_000_000,
  entries: [sampleApplied],
};

const ledgerEmpty: AppliedImprovementsFile = {
  schemaVersion: 1,
  generatedAt: 1_700_000_000_000,
  entries: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
});

afterEach(() => {
  cleanup();
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
});

describe('ChatArchViewer — Phase 2a default-mode reroute', () => {
  it('reroutes to CORRECTIONS when the applied-improvements ledger has entries', async () => {
    mockedLoadApplied.mockResolvedValueOnce(ledgerWithEntry);
    render(<ChatArchViewer manifest={sampleManifest} />);
    // Location chip mirrors active mode — "CORRECTIONS" appears once
    // the reroute effect has applied. Use waitFor because the load is
    // async.
    await waitFor(() => {
      const active = document.querySelector('[aria-current="page"]');
      expect(active?.getAttribute('aria-label')).toMatch(/^mode CORRECTIONS\b/);
    });
  });

  it('stays on SESSIONS (command) when the ledger is empty', async () => {
    mockedLoadApplied.mockResolvedValueOnce(ledgerEmpty);
    render(<ChatArchViewer manifest={sampleManifest} />);
    // Wait until at least one render cycle has happened post-load,
    // then assert the location chip is still SESSIONS.
    await waitFor(() => {
      expect(mockedLoadApplied).toHaveBeenCalled();
    });
    // Give the post-load effect a tick to settle and re-render.
    await new Promise((r) => setTimeout(r, 0));
    const active = document.querySelector('[aria-current="page"]');
    expect(active?.getAttribute('aria-label')).toMatch(/^mode SESSIONS\b/);
  });

  it('stays in URL-hash-encoded mode when a hash is present (URL wins)', async () => {
    mockedLoadApplied.mockResolvedValueOnce(ledgerWithEntry);
    window.history.replaceState(null, '', '#projects');
    render(<ChatArchViewer manifest={sampleManifest} />);
    await waitFor(() => {
      expect(mockedLoadApplied).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 0));
    // PROJECTS surface stays active despite the ledger having entries —
    // the URL hash takes precedence over the reroute heuristic so deep
    // links aren't yanked.
    const active = document.querySelector('[aria-current="page"]');
    expect(active?.getAttribute('aria-label')).toMatch(/^mode PROJECTS\b/);
  });

  it('scrubs stale Phase-3-cut hashes (#cost / #constellation) and lets the reroute fire', async () => {
    // Phase 3 cut COST and CONSTELLATION; an old bookmark with
    // `#cost` would otherwise sit in the URL bar AND block the
    // default-mode reroute (which short-circuits when the hash is
    // non-empty so URL deep links can win). The hash listener now
    // strips unrecognized hashes before the reroute runs.
    mockedLoadApplied.mockResolvedValueOnce(ledgerWithEntry);
    window.history.replaceState(null, '', '#cost');
    render(<ChatArchViewer manifest={sampleManifest} />);
    await waitFor(() => {
      const active = document.querySelector('[aria-current="page"]');
      expect(active?.getAttribute('aria-label')).toMatch(/^mode CORRECTIONS\b/);
    });
    // And the stale hash is gone — no ghost `#cost` left in the URL.
    expect(window.location.hash).toBe('');
  });

  it('reroutes to CORRECTIONS when corrections.json has patterns but the ledger is empty (P1.2)', async () => {
    // Demo / first-mine users have classified patterns to inspect but
    // haven't clicked APPLY yet — the reroute should still fire so they
    // land in the workshop loop instead of being dumped on SESSIONS.
    const correctionsWithPattern: CorrectionsFile = {
      generatedAt: 1_700_000_000_000,
      corrections: [],
      patterns: [
        {
          id: 'p-demo',
          canonicalRule: 'use bullets, not paragraphs',
          instanceIds: [],
          occurrenceCount: 4,
          firstSeen: 1_700_000_000_000,
          lastSeen: 1_700_100_000_000,
          scope: { kind: 'global' },
          proposedUpgrades: [],
          confidence: 0.6,
          recurringPostApplication: false,
          alreadyEncoded: false,
        },
      ],
      pipeline: {
        heuristicRecall: true,
        llmClassification: true,
        embeddingClustering: true,
        claudeMdCrossCheck: true,
      },
    };
    mockedLoadApplied.mockResolvedValueOnce(ledgerEmpty);
    mockedLoadCorrections.mockResolvedValueOnce(correctionsWithPattern);
    render(<ChatArchViewer manifest={sampleManifest} />);
    await waitFor(() => {
      const active = document.querySelector('[aria-current="page"]');
      expect(active?.getAttribute('aria-label')).toMatch(/^mode CORRECTIONS\b/);
    });
  });
});
