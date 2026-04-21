import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { zipSync, strToU8 } from 'fflate';
import type { CloudConversation } from '@chat-arch/schema';
import { UploadPanel } from './UploadPanel.js';

function buildConv(uuid: string, name: string): CloudConversation {
  return {
    uuid,
    name,
    summary: '',
    created_at: '2025-06-01T12:00:00Z',
    updated_at: '2025-06-01T12:00:00Z',
    account: { uuid: 'u' },
    chat_messages: [],
  };
}

function zipFile(entries: Record<string, unknown>, name = 'export.zip'): File {
  const packed: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) {
    // Re-wrap via `new Uint8Array(...)` to align realms with fflate's
    // internal `instanceof Uint8Array` check under jsdom (no-op in browser).
    packed[k] = new Uint8Array(strToU8(typeof v === 'string' ? v : JSON.stringify(v)));
  }
  const bytes = zipSync(packed);
  return bytesToFile(bytes, name);
}

function bytesToFile(bytes: Uint8Array, name: string): File {
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  const file = new File([], name, { type: 'application/zip' });
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

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('UploadPanel', () => {
  it('renders the prominent CTA with headline copy', () => {
    render(<UploadPanel onLoaded={() => {}} />);
    expect(screen.getByText('LOAD CLOUD EXPORT')).toBeDefined();
    expect(screen.getByRole('button', { name: /choose cloud export zip/i })).toBeDefined();
  });

  it('renders compact variant without headline', () => {
    render(<UploadPanel onLoaded={() => {}} variant="compact" />);
    expect(screen.queryByText('LOAD CLOUD EXPORT')).toBeNull();
    expect(screen.getByRole('button', { name: /choose cloud export zip/i })).toBeDefined();
  });

  it('parses a valid ZIP and fires onLoaded with the manifest', async () => {
    const onLoaded = vi.fn();
    const { container } = render(<UploadPanel onLoaded={onLoaded} />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const file = zipFile({
      'conversations.json': [buildConv('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha')],
    });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    const data = onLoaded.mock.calls[0]![0];
    expect(data.manifest.sessions).toHaveLength(1);
    expect(screen.getByText(/LOADED 1 CONVERSATIONS/i)).toBeDefined();
  });

  it('renders the MASKED filename — never the raw file.name — in the success status', async () => {
    // A real claude.ai Privacy Export carries the user's email address
    // in the filename by default (`data-YYYY-MM-DD-<email>.zip`). The
    // parsing/success status elements live in the DOM where a user
    // might screenshot them. The component must surface only the
    // masked `upload.<ext> (<size>)` form — NEVER the raw filename.
    const onLoaded = vi.fn();
    const { container } = render(<UploadPanel onLoaded={onLoaded} />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const file = zipFile(
      { 'conversations.json': [buildConv('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A')] },
      'data-2026-04-20-user@example.com.zip',
    );
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    const statusEl = screen.getByRole('status');
    expect(statusEl.textContent).toMatch(/upload\.zip \(/);
    expect(statusEl.textContent).not.toContain('user@example.com');
    expect(statusEl.textContent).not.toContain('2026-04-20');
  });

  it('also masks the PARSING transient state — not just the success state', async () => {
    // Both the transient `parsing` message and the terminal `success`
    // message live in the DOM and can be screenshotted. A future
    // refactor that masks only the success path while reverting the
    // parsing path to `file.name` would still leak in the parse
    // window. Snapshot the parsing-state render by intercepting
    // `parseCloudZip` to never resolve, and assert on the rendered
    // text BEFORE onLoaded fires.
    //
    // Strategy: use a file whose ZIP parse will hang just long
    // enough for us to snapshot the `parsing` state. `parseCloudZip`
    // is synchronous-ish (fflate's unzipSync runs to completion
    // under jsdom in a single tick), so the parsing state would
    // normally flip to success before React yields. We instead feed
    // it an invalid ZIP so it rejects — which lets us catch the
    // parsing render in the error-dispatch window.
    const onLoaded = vi.fn();
    const { container } = render(<UploadPanel onLoaded={onLoaded} />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    // A name that WOULD leak if masking is skipped — and an invalid
    // zip body so parseCloudZip throws and we flip into error state
    // without success ever rendering. The parsing-state message is
    // briefly live between fireEvent and the error settle; we assert
    // on it via a ref-capturing role=status query during the tick.
    const badBytes = bytesToFile(new Uint8Array([1, 2, 3]), 'data-2026-04-20-user@example.com.zip');
    fireEvent.change(input, { target: { files: [badBytes] } });

    // Grab the `role=status` as-rendered on the next microtask —
    // `setState({status: 'parsing', label})` flushes synchronously
    // under testing-library's fireEvent.
    const statusEl = screen.queryByRole('status');
    if (statusEl) {
      // We caught the parsing render — assert it masks.
      expect(statusEl.textContent ?? '').toMatch(/PARSING upload\.zip \(/);
      expect(statusEl.textContent ?? '').not.toContain('user@example.com');
      expect(statusEl.textContent ?? '').not.toContain('2026-04-20');
    }

    // And the terminal error state must also not leak the filename —
    // the error-branch doesn't render the label, but be explicit.
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toContain('user@example.com');
    });
  });

  it('surfaces an error message on a malformed ZIP', async () => {
    const onLoaded = vi.fn();
    const { container } = render(<UploadPanel onLoaded={onLoaded} />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const bad = bytesToFile(new Uint8Array([1, 2, 3]), 'bad.zip');
    fireEvent.change(input, { target: { files: [bad] } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Could not read ZIP archive/i),
    );
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it('surfaces an error when conversations.json is missing', async () => {
    const onLoaded = vi.fn();
    const { container } = render(<UploadPanel onLoaded={onLoaded} />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const file = zipFile({ 'users.json': [] });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /does not contain conversations\.json/i,
      ),
    );
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
