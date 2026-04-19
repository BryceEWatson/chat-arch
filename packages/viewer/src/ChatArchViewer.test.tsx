import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { zipSync, strToU8 } from 'fflate';
import type { CloudConversation, SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { ChatArchViewer } from './ChatArchViewer.js';

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

beforeEach(() => {
  vi.restoreAllMocks();
  // Default jsdom width is ~1024 which clears the 900px gate.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  // jsdom persists hash across tests; a stale `#session/...` would re-open
  // the detail overlay in the next test. Clear it explicitly.
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
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

  it('shows ErrorState on fetch failure', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
    render(<ChatArchViewer manifestUrl="/missing.json" />);
    await waitFor(() => expect(screen.getByText(/TRANSMISSION ERROR/i)).toBeDefined());
    expect(screen.getByText(/No data yet/i)).toBeDefined();
    expect(screen.getByText(/HTTP 404/)).toBeDefined();
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

  it('top-bar `×` clear-upload chip only appears when an upload is active, and reverts', async () => {
    render(<ChatArchViewer manifest={sampleManifest} />);
    // No upload yet → chip is not rendered.
    expect(screen.queryByRole('button', { name: /clear uploaded ZIP/i })).toBeNull();

    // Upload a ZIP.
    const fileInput = document.body.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [uploadFixtureFile()] } });
    await waitFor(() => expect(screen.getByText('Uploaded Alpha')).toBeDefined());

    // Chip is now visible.
    const clear = screen.getByRole('button', { name: /clear uploaded ZIP/i });
    expect(clear).toBeDefined();

    // Clicking the chip reverts to the fetched manifest (same path as UNLOAD).
    fireEvent.click(clear);
    await waitFor(() => {
      expect(screen.getByText('Apple pie recipe')).toBeDefined();
      expect(screen.queryByText('Uploaded Alpha')).toBeNull();
    });
    // And the chip disappears again.
    expect(screen.queryByRole('button', { name: /clear uploaded ZIP/i })).toBeNull();
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
});
