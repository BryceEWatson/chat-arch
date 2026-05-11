import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup, act, fireEvent, screen } from '@testing-library/react';
import type {
  Correction,
  CorrectionsFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import type * as CorrectionsLoaderModule from './data/correctionsLoader.js';

// Match the reroute test's mocking strategy so the viewer mounts
// without firing real network requests, then drive BACK behavior
// through real DOM clicks + hashchange events.
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
vi.mock('./data/applyCorrectionClient.js', () => ({
  applyCorrection: vi.fn(),
  probeApplyCorrection: vi.fn(async () => false),
}));

import { loadCorrectionsFile } from './data/correctionsLoader.js';
import { ChatArchViewer } from './ChatArchViewer.js';

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

const sampleCorrection: Correction = {
  id: 'inst-a',
  sessionId: 'a',
  userTurnIndex: 0,
  excerpt: 'use absolute paths in WSL',
  precedingAssistantExcerpt: null,
  signals: [{ kind: 'imperative-override', phrase: 'use absolute paths' }],
  classification: {
    kind: 'behavior-rule',
    distilledRule: 'use absolute paths in WSL',
    confidence: 0.9,
    actionable: true,
  },
};

function correctionsWithClickablePill(): CorrectionsFile {
  return {
    generatedAt: Date.parse('2026-05-01T00:00:00Z'),
    corrections: [sampleCorrection],
    patterns: [
      {
        id: 'p1',
        canonicalRule: 'use absolute paths in WSL',
        instanceIds: ['inst-a'],
        occurrenceCount: 3,
        firstSeen: 1_700_000_000_000,
        lastSeen: 1_700_100_000_000,
        scope: { kind: 'global' },
        proposedUpgrades: [],
        confidence: 0.7,
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
}

function locationLabel(): string | null {
  // Probe the active surface. Prefer the sidebar's `aria-current="page"`
  // aria-label (e.g. `mode SESSIONS`) since that's the user-facing label
  // string. Detail mode has no sidebar entry (it's an overlay) — fall
  // back to the frame's `data-active-mode='detail'` for that case.
  const active = document.querySelector('[aria-current="page"]');
  const ariaLabel = active?.getAttribute('aria-label');
  if (ariaLabel?.startsWith('mode ')) return ariaLabel.replace(/^mode /, '');
  const frame = document.querySelector('.lcars-frame');
  const mode = frame?.getAttribute('data-active-mode');
  return mode === 'detail' ? 'DETAIL' : null;
}

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

describe('ChatArchViewer — BACK from detail restores prior surface (P0.1)', () => {
  it('returns to CORRECTIONS after BACK from a CORRECTIONS instance-pill clickthrough', async () => {
    // Resolve corrections.json with a clickable instance pill so the
    // viewer reroutes to CORRECTIONS on mount and a real button is in
    // the DOM for the click below.
    mockedLoadCorrections.mockResolvedValue(correctionsWithClickablePill());

    render(<ChatArchViewer manifest={sampleManifest} />);

    await waitFor(() => {
      expect(locationLabel()).toBe('CORRECTIONS');
    });

    // Pattern cards collapse instance pills behind a SHOW DETAILS
    // toggle. Click that first, then the instance pill. The panel's
    // onSelectSession wrapper sets priorModeBeforeDetail and calls
    // onSelect, which pushes #session/a and flips mode.
    const showDetails = await waitFor(() =>
      screen.getByRole('button', { name: /SHOW DETAILS/i }),
    );
    act(() => {
      fireEvent.click(showDetails);
    });
    const pill = await waitFor(() =>
      screen.getByRole('button', { name: /open session a/i }),
    );
    act(() => {
      fireEvent.click(pill);
    });

    // Detail surface is now active — location chip is "SESSION".
    await waitFor(() => {
      expect(locationLabel()).toBe('DETAIL');
    });

    // Simulate BACK by popping the session hash and dispatching
    // hashchange — equivalent to `window.history.back()`. The
    // listener should consume `priorModeBeforeDetail` (set to
    // 'corrections' by the panel wrapper above) and restore that
    // mode instead of falling back to 'command'.
    act(() => {
      window.history.replaceState(null, '', window.location.pathname);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await waitFor(() => {
      expect(locationLabel()).toBe('CORRECTIONS');
    });
  });

  it('falls back to SESSIONS (command) when BACK fires without priorMode set', async () => {
    // Empty corrections file so no reroute fires. Mode stays
    // 'command' (SESSIONS) on mount.
    mockedLoadCorrections.mockResolvedValueOnce(null);

    render(<ChatArchViewer manifest={sampleManifest} />);

    await waitFor(() => {
      expect(locationLabel()).toBe('SESSIONS');
    });

    // Push a session hash directly — bypasses the panel's wrapper,
    // so priorModeBeforeDetail stays null. The hashchange listener
    // sets mode='detail'.
    act(() => {
      window.history.pushState(null, '', '#session/a');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => {
      expect(locationLabel()).toBe('DETAIL');
    });

    // Pop the hash → listener sees prevMode='detail' but no stashed
    // prior, so it falls back to 'command'.
    act(() => {
      window.history.replaceState(null, '', window.location.pathname);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => {
      expect(locationLabel()).toBe('SESSIONS');
    });
  });
});
