import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import type * as CorrectionsLoaderModule from './data/correctionsLoader.js';

// Phase 4 — when LOAD DEMO DATA is clicked on the empty-state landing,
// the demo fixture ships its own corrections + applied-improvements +
// synthesized rescan delta. Verify the viewer:
//   1. Lights up the persistent rescan-delta chip.
//   2. Routes the user to CORRECTIONS (already covered by the existing
//      reroute logic, but the demo's bundled corrections need to feed
//      the same path).
//   3. Renders the CorrectionsPanel with demo data, not an empty
//      surface.

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

import { ChatArchViewer } from './ChatArchViewer.js';

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

const emptyManifest: SessionManifest = {
  schemaVersion: 1,
  generatedAt: 0,
  counts: { cloud: 0, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
  sessions: [entry('placeholder', { title: 'placeholder' })],
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  // Default fetch — every URL 404s, including /api/rescan, so we
  // simulate the hosted static build (no local Astro dev server).
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
});

afterEach(() => {
  cleanup();
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
});

describe('ChatArchViewer — Phase 4 demo-path workshop loop', () => {
  // The demo button is exposed via EmptyState's UploadPanel only when
  // the manifest has zero sessions. We pass an empty manifest with a
  // single sentinel entry to bypass the "NO DATA YET" early-return
  // path (which uses a different layout); the regular populated
  // layout has its own EmptyState rendering with onLoadDemo.
  //
  // For this test we go through the empty-manifest landing instead.
  it('demo load lights up the persistent rescan-delta chip on hosted', async () => {
    // Use a truly empty manifest so the empty-state landing renders.
    const truly: SessionManifest = {
      ...emptyManifest,
      sessions: [],
    };
    render(<ChatArchViewer manifest={truly} />);

    // The empty-state landing renders LOAD DEMO DATA. On hosted
    // (showInstallLocally=true) CHOOSE ZIP is demoted to secondary
    // styling but still functional; the demo button remains.
    const demoBtn = await screen.findByRole('button', { name: /load demo data/i });
    fireEvent.click(demoBtn);

    // The synthesized rescan delta chip should appear in the top bar.
    // It surfaces the per-source counts the demo fixture pre-populates:
    // 12 total, 4 cowork, 6 cli, 2 desktop.
    await waitFor(() => {
      const topbar = document.querySelector('.lcars-top-bar');
      expect(topbar?.textContent ?? '').toMatch(/12/);
    });
  });

  it('demo load routes to CORRECTIONS and renders the bundled patterns', async () => {
    const truly: SessionManifest = {
      ...emptyManifest,
      sessions: [],
    };
    render(<ChatArchViewer manifest={truly} />);

    const demoBtn = await screen.findByRole('button', { name: /load demo data/i });
    fireEvent.click(demoBtn);

    // Once the demo data is loaded, the default-mode reroute should
    // fire (corrections has patterns; ledger has entries) — the
    // active sidebar item flips to CORRECTIONS.
    await waitFor(() => {
      const active = document.querySelector('[aria-current="page"]');
      expect(active?.getAttribute('aria-label')).toBe('mode CORRECTIONS');
    });

    // And the corrections panel renders the demo patterns. Look for
    // text from one of the canonical rules in the fixture.
    await waitFor(() => {
      // Demo pattern 1 canonical rule — the absolute-paths one.
      // CorrectionsPanel renders the canonicalRule prominently in
      // each pattern card.
      expect(document.body.textContent ?? '').toMatch(/absolute paths/i);
    });
  });
});
