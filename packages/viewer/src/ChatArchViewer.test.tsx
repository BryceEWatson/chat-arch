import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { zipSync, strToU8 } from 'fflate';
import type { CloudConversation, SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { ChatArchViewer } from './ChatArchViewer.js';
import {
  loadUploadedData,
  saveUploadedData,
  clearUploadedData,
} from './data/uploadedDataStore.js';
import type { UploadedCloudData } from './types.js';

function buildConv(uuid: string, name: string): CloudConversation {
  return {
    uuid,
    name,
    summary: '',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:30:00Z',
    account: { uuid: 'u' },
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        sender: 'human',
        text: 'uploaded-hello',
        content: [{ type: 'text', text: 'uploaded-hello' }],
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T10:00:00Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

function uploadFixtureFile(): File {
  // Re-wrap via `new Uint8Array(...)` to align realms with fflate's
  // internal `instanceof Uint8Array` check under jsdom (no-op in browser).
  const payload = new Uint8Array(
    strToU8(JSON.stringify([buildConv('ffff1111-1111-1111-1111-111111111111', 'Uploaded Alpha')])),
  );
  const bytes = zipSync({ 'conversations.json': payload });
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  // jsdom's File mis-encodes raw Uint8Array BlobParts. Construct an empty
  // file for metadata and override `arrayBuffer()` to serve the raw bytes.
  const file = new File([], 'upload-fixture.zip', { type: 'application/zip' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => {
      const out = new ArrayBuffer(buf.byteLength);
      new Uint8Array(out).set(buf);
      return out;
    },
    configurable: true,
  });
  Object.defineProperty(file, 'size', { value: buf.byteLength, configurable: true });
  return file;
}

const emptyManifest: SessionManifest = {
  schemaVersion: 1,
  generatedAt: 0,
  counts: { cloud: 0, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
  sessions: [],
};

function entry(
  id: string,
  source: UnifiedSessionEntry['source'],
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source,
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 100 + id.length * 10,
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
  generatedAt: 0,
  counts: { cloud: 2, cowork: 1, 'cli-direct': 0, 'cli-desktop': 0 },
  sessions: [
    entry('a', 'cloud', { title: 'Apple pie recipe' }),
    entry('b', 'cloud', { title: 'Banana bread debugging' }),
    entry('c', 'cowork', { title: 'Coconut cream cookbook' }),
  ],
};

beforeEach(async () => {
  vi.restoreAllMocks();
  // Default jsdom width is ~1024 which clears the 900px gate.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  // jsdom persists hash across tests; a stale `#session/...` would re-open
  // the detail overlay in the next test. Clear it explicitly.
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  // fake-indexeddb persists across tests in the same worker. Clear the
  // single persisted-archive key so each test starts from a clean slate.
  // (We avoid `deleteDatabase` here — it would deadlock against the idb-
  // keyval connection that remains open across tests.)
  await clearUploadedData();
});

afterEach(() => {
  cleanup();
});

describe('ChatArchViewer', () => {
  it('renders the LCARS frame and top bar title when manifest is provided', () => {
    render(<ChatArchViewer manifest={sampleManifest} />);
    expect(screen.getByText('CHAT ARCHAEOLOGIST')).toBeDefined();
    expect(screen.getByText('Apple pie recipe')).toBeDefined();
  });

  it('fetches manifest from URL when no prop passed', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => sampleManifest,
          text: async () => '',
        }) as unknown as Response,
    );
    render(<ChatArchViewer manifestUrl="/test-data/manifest.json" />);
    await waitFor(() => expect(screen.getByText('Apple pie recipe')).toBeDefined());
  });

  it('shows empty state on manifest fetch failure', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    render(<ChatArchViewer manifestUrl="/missing.json" />);
    // Title: "NO DATA YET" (was "TRANSMISSION ERROR" — renamed to be less
    // alarmist for what is really just a "no data yet" onboarding state).
    // Use heading role to disambiguate from the "No data yet." detail
    // sentence below it.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /NO DATA YET/i })).toBeDefined(),
    );
    // Detail still surfaces the fetch error so a developer can diagnose.
    expect(screen.getByText(/HTTP 404/)).toBeDefined();
    // Inline upload CTA is the actionable path out.
    expect(screen.getByLabelText(/choose cloud export zip/i)).toBeDefined();
  });

  it('shows EmptyState when manifest has zero sessions', () => {
    render(<ChatArchViewer manifest={emptyManifest} />);
    expect(screen.getByText('NO SESSIONS')).toBeDefined();
  });

  it('filters by search query (case-insensitive substring, debounced)', async () => {
    render(<ChatArchViewer manifest={sampleManifest} />);
    // All three visible at first.
    expect(screen.getByText('Apple pie recipe')).toBeDefined();
    expect(screen.getByText('Banana bread debugging')).toBeDefined();
    expect(screen.getByText('Coconut cream cookbook')).toBeDefined();

    const input = screen.getByLabelText('search sessions') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'BANANA' } });

    // Debounce is 100ms; waitFor polls until the assertion passes.
    await waitFor(
      () => {
        expect(screen.queryByText('Apple pie recipe')).toBeNull();
        expect(screen.getByText('Banana bread debugging')).toBeDefined();
        expect(screen.queryByText('Coconut cream cookbook')).toBeNull();
      },
      { timeout: 1000 },
    );
  });

  it('toggles source filter pills to narrow results', () => {
    render(<ChatArchViewer manifest={sampleManifest} />);
    // Click COWORK pill — only the cowork session should remain.
    fireEvent.click(screen.getByRole('button', { name: /toggle source COWORK/i }));
    expect(screen.queryByText('Apple pie recipe')).toBeNull();
    expect(screen.queryByText('Banana bread debugging')).toBeNull();
    expect(screen.getByText('Coconut cream cookbook')).toBeDefined();

    // ALL pill clears.
    fireEvent.click(screen.getByRole('button', { name: /show all sources/i }));
    expect(screen.getByText('Apple pie recipe')).toBeDefined();
  });

  it('switches to Timeline mode from the sidebar', () => {
    render(<ChatArchViewer manifest={sampleManifest} />);
    fireEvent.click(screen.getByRole('button', { name: /mode TIMELINE/i }));
    // Timeline shows lane labels.
    expect(screen.getAllByText(/CLOUD/i).length).toBeGreaterThan(0);
  });

  it('drill-in sets hash and Esc clears it (R11 F11.3)', async () => {
    window.location.hash = '';
    render(<ChatArchViewer manifest={sampleManifest} />);
    fireEvent.click(screen.getByRole('button', { name: /open Apple pie recipe/i }));
    await waitFor(() => expect(window.location.hash.startsWith('#session/')).toBe(true));

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(window.location.hash).toBe(''));
    // Back on the list.
    expect(screen.getByText('Apple pie recipe')).toBeDefined();
  });

  it('search input is disabled while detail overlay is open (R11 F11.2)', async () => {
    window.location.hash = '';
    render(<ChatArchViewer manifest={sampleManifest} />);
    const input = screen.getByLabelText('search sessions') as HTMLInputElement;
    expect(input.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /open Apple pie recipe/i }));
    await waitFor(() =>
      expect((screen.getByLabelText('search sessions') as HTMLInputElement).disabled).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: /back to list/i }));
    await waitFor(() =>
      expect((screen.getByLabelText('search sessions') as HTMLInputElement).disabled).toBe(false),
    );
  });

  it('list stays mounted under the detail overlay (R11 F11.1)', async () => {
    window.location.hash = '';
    const { container } = render(<ChatArchViewer manifest={sampleManifest} />);
    fireEvent.click(screen.getByRole('button', { name: /open Apple pie recipe/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /back to list/i })).toBeDefined(),
    );
    // The base-mode slot is still in the DOM, just hidden.
    const base = container.querySelector('.lcars-mode-area__base');
    expect(base).toBeTruthy();
    expect((base as HTMLElement).hidden).toBe(true);
    // And still contains the CommandMode grid (component identity preserved).
    expect(base?.querySelector('.lcars-command-mode__grid')).toBeTruthy();
  });

  it('drill-in from card switches to Detail mode, Back returns to Command', async () => {
    // Apple pie has no transcriptPath, so Detail will render DetailMissing
    // without fetching. This keeps the test hermetic.
    render(<ChatArchViewer manifest={sampleManifest} />);
    fireEvent.click(screen.getByRole('button', { name: /open Apple pie recipe/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /back to list/i })).toBeDefined(),
    );
    expect(screen.getAllByText(/NO TRANSCRIPT/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /back to list/i }));
    await waitFor(() => {
      expect(screen.getByText('Apple pie recipe')).toBeDefined();
      expect(screen.getByText('Banana bread debugging')).toBeDefined();
    });
  });

  it('renders responsive layout at tablet width (no legacy 900px gate)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    const { container } = render(<ChatArchViewer manifest={sampleManifest} />);
    // Old "LCARS REQUIRES 900px VIEWPORT" gate is gone — cards render at 800.
    expect(screen.queryByText(/LCARS REQUIRES 900px VIEWPORT/i)).toBeNull();
    expect(screen.getByText('Apple pie recipe')).toBeDefined();
    expect(container.querySelector('.lcars-root')?.getAttribute('data-tier')).toBe('tablet');
  });

  it('renders mobile stack at phone width', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    const { container } = render(<ChatArchViewer manifest={sampleManifest} />);
    // Horizontal pill bar variant kicks in; double-elbow sidebar is absent.
    expect(container.querySelector('.lcars-sidebar--horizontal')).toBeTruthy();
    expect(container.querySelector('.lcars-sidebar__elbow')).toBeNull();
    expect(container.querySelector('.lcars-root')?.getAttribute('data-tier')).toBe('mobile');
    expect(screen.getByText('Apple pie recipe')).toBeDefined();
  });

  it('shows < 320px fallback banner only at extreme narrow widths', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 280 });
    render(<ChatArchViewer manifest={sampleManifest} />);
    expect(screen.getByText(/VIEWPORT TOO NARROW/i)).toBeDefined();
  });

  it('uploaded manifest takes precedence over the fetched manifest; UNLOAD reverts', async () => {
    render(<ChatArchViewer manifest={sampleManifest} />);
    // Fetched manifest loads first.
    expect(screen.getByText('Apple pie recipe')).toBeDefined();

    // Simulate upload via the compact UploadPanel inside UpperPanel.
    const container = document.body;
    const fileInput = container.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [uploadFixtureFile()] } });

    await waitFor(() => expect(screen.getByText('Uploaded Alpha')).toBeDefined());
    // Fetched sessions are gone.
    expect(screen.queryByText('Apple pie recipe')).toBeNull();
    expect(screen.queryByText('Banana bread debugging')).toBeNull();
    // UNLOAD affordance is visible.
    expect(screen.getByRole('button', { name: /unload uploaded ZIP/i })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /unload uploaded ZIP/i }));
    await waitFor(() => {
      expect(screen.getByText('Apple pie recipe')).toBeDefined();
      expect(screen.queryByText('Uploaded Alpha')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // IndexedDB persistence — uploaded ZIP survives a refresh.
  //
  // Browser-only deploys (GitHub Pages, CDN, file://) have no server-backed
  // storage, so the uploaded archive must persist in IDB or the user's
  // upload disappears on every page reload. These tests exercise that round
  // trip end-to-end: the actual `loadUploadedData` is invoked on mount, and
  // the actual `saveUploadedData` is invoked from the persist effect.
  // -------------------------------------------------------------------------

  function persistedArchive(): UploadedCloudData {
    return {
      manifest: {
        schemaVersion: 1,
        generatedAt: 1_700_000_000_000,
        counts: { cloud: 1, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
        sessions: [entry('persisted-x', 'cloud', { title: 'Persisted X' })],
      },
      conversationsById: new Map<string, CloudConversation>([
        ['persisted-x', buildConv('persisted-x', 'Persisted X')],
      ]),
      sourceLabel: 'restored.zip (1.0 KB)',
    };
  }

  it('rehydrates uploaded archive from IndexedDB on mount', async () => {
    await saveUploadedData(persistedArchive());
    render(<ChatArchViewer manifest={emptyManifest} />);
    await waitFor(() => expect(screen.getByText('Persisted X')).toBeDefined());
  });

  it('persists a fresh upload to IndexedDB and a re-mount sees it', async () => {
    const { unmount } = render(<ChatArchViewer manifest={emptyManifest} />);
    const fileInput = document.body.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [uploadFixtureFile()] } });
    await waitFor(() => expect(screen.getByText('Uploaded Alpha')).toBeDefined());

    // The persist effect is async; wait for IDB to actually contain the row
    // before tearing the viewer down. Otherwise we'd race the unmount and
    // the second mount would see an empty store.
    await waitFor(async () => {
      const stored = await loadUploadedData();
      expect(stored?.manifest.sessions.length).toBeGreaterThan(0);
    });

    unmount();

    render(<ChatArchViewer manifest={emptyManifest} />);
    await waitFor(() => expect(screen.getByText('Uploaded Alpha')).toBeDefined());
  });

  it('clearing the upload via the UpperPanel UNLOAD chip wipes IndexedDB too', async () => {
    await saveUploadedData(persistedArchive());
    render(<ChatArchViewer manifest={sampleManifest} />);
    await waitFor(() => expect(screen.getByText('Persisted X')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /unload uploaded ZIP/i }));

    await waitFor(async () => {
      const stored = await loadUploadedData();
      expect(stored).toBeNull();
    });
  });

  it('does not write to IndexedDB before hydration completes', async () => {
    // Plant a stored archive, then mount. If the persist effect ran on the
    // initial `null` state it would clobber the stored archive before the
    // load effect could rehydrate it. Verify the row survives the mount.
    await saveUploadedData(persistedArchive());
    render(<ChatArchViewer manifest={emptyManifest} />);
    await waitFor(() => expect(screen.getByText('Persisted X')).toBeDefined());
    const stored = await loadUploadedData();
    expect(stored).not.toBeNull();
    expect(stored!.manifest.sessions[0]!.title).toBe('Persisted X');
  });

  it('falls through to fetched manifest when IDB is empty', async () => {
    await clearUploadedData();
    render(<ChatArchViewer manifest={sampleManifest} />);
    // Sample fetched data renders, no rehydrated upload appears.
    await waitFor(() => expect(screen.getByText('Apple pie recipe')).toBeDefined());
    expect(screen.queryByText('Persisted X')).toBeNull();
  });

  it('sessions are sorted newest first', () => {
    const many: SessionManifest = {
      ...sampleManifest,
      sessions: [
        entry('a', 'cloud', { title: 'First', updatedAt: 100 }),
        entry('b', 'cloud', { title: 'Second', updatedAt: 300 }),
        entry('c', 'cloud', { title: 'Third', updatedAt: 200 }),
      ],
    };
    render(<ChatArchViewer manifest={many} />);
    const titles = screen.getAllByText(/First|Second|Third/).map((el) => el.textContent);
    expect(titles).toEqual(['Second', 'Third', 'First']);
  });

  // --- Phase 2: browser-side analysis over uploaded data ---------------------
  //
  // When a cloud-only user uploads a ZIP and no exporter-written
  // `analysis/*.json` files are available, the viewer must still surface
  // DUP chips (exact duplicates) and ZOMBIE chips — computed in-page from
  // the uploaded data. Without this, the "core tier runs in-page against
  // your manifest" promise is false for web-upload users.
  // --------------------------------------------------------------------------

  function duplicateConv(uuid: string, name: string, duplicateText: string): CloudConversation {
    return {
      ...buildConv(uuid, name),
      chat_messages: [
        {
          uuid: 'm1',
          parent_message_uuid: '00000000-0000-4000-8000-000000000000',
          sender: 'human',
          text: duplicateText,
          content: [{ type: 'text', text: duplicateText }],
          created_at: '2026-01-01T10:00:00Z',
          updated_at: '2026-01-01T10:00:00Z',
          attachments: [],
          files: [],
        },
      ],
    };
  }

  it('browser-computes DUP clusters over uploaded data when no analysis files are fetched', async () => {
    // Two conversations with identical first-human text → one duplicate
    // cluster with two members. Text is > 40 chars so it clears the
    // ceremonial-noise floor (DEFAULT_MIN_NORMALIZED_LEN).
    const duplicateText =
      'Please refactor the authentication module to use JWT tokens and update all the call sites.';
    const archive: UploadedCloudData = {
      manifest: {
        schemaVersion: 1,
        generatedAt: 0,
        counts: { cloud: 2, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
        sessions: [
          entry('dup-a', 'cloud', { title: 'JWT refactor — first pass' }),
          entry('dup-b', 'cloud', { title: 'JWT refactor — second attempt' }),
        ],
      },
      conversationsById: new Map<string, CloudConversation>([
        ['dup-a', duplicateConv('dup-a', 'JWT refactor — first pass', duplicateText)],
        ['dup-b', duplicateConv('dup-b', 'JWT refactor — second attempt', duplicateText)],
      ]),
      sourceLabel: 'dup-demo.zip (1.0 KB)',
    };
    await saveUploadedData(archive);
    render(<ChatArchViewer manifest={emptyManifest} />);
    await waitFor(() => expect(screen.getByText('JWT refactor — first pass')).toBeDefined());
    // Each duplicate session gets a DUP (2) chip — the in-page cluster
    // computation feeds the same sessionDupIndex the CLI-source path uses.
    const dupChips = document.querySelectorAll('.lcars-chip--dup');
    expect(dupChips.length).toBe(2);
    expect(dupChips[0]!.textContent).toMatch(/DUP \(2\)/);
  });

  it('browser-computes ZOMBIE classification over uploaded data when no analysis files are fetched', async () => {
    // Build a project that ran 2 years ago with no recent activity. The
    // heuristic's silent-zombie rule (SILENT_ZOMBIE_DAYS = 180) should
    // classify it as zombie without needing a probe session.
    const longDormantTs = Date.UTC(2024, 0, 1); // >= 2 years before the current date
    const archive: UploadedCloudData = {
      manifest: {
        schemaVersion: 1,
        generatedAt: 0,
        counts: { cloud: 1, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
        sessions: [
          entry('zombie-1', 'cloud', {
            title: 'Chat Archaeologist kickoff',
            project: 'chat-arch',
            startedAt: longDormantTs,
            updatedAt: longDormantTs,
          }),
        ],
      },
      conversationsById: new Map<string, CloudConversation>([
        ['zombie-1', buildConv('zombie-1', 'Chat Archaeologist kickoff')],
      ]),
      sourceLabel: 'zombie-demo.zip (1.0 KB)',
    };
    await saveUploadedData(archive);
    render(<ChatArchViewer manifest={emptyManifest} />);
    await waitFor(() =>
      expect(screen.getByText('Chat Archaeologist kickoff')).toBeDefined(),
    );
    // The zombie heuristic groups by project and classifies. The session
    // should carry the ZOMBIE chip because its project is dormant.
    const zombieChips = document.querySelectorAll('.lcars-chip--zombie');
    expect(zombieChips.length).toBeGreaterThan(0);
  });
});
