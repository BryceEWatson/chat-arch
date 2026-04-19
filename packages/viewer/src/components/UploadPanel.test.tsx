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
