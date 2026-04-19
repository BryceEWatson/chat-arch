import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import type { CloudConversation } from '@chat-arch/schema';
import { parseCloudZip } from './zipUpload.js';

function buildConversation(uuid: string, name: string): CloudConversation {
  return {
    uuid,
    name,
    summary: '',
    created_at: '2025-06-01T12:00:00Z',
    updated_at: '2025-06-01T12:00:00Z',
    account: { uuid: 'u' },
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        sender: 'human',
        text: 'hi',
        content: [{ type: 'text', text: 'hi' }],
        created_at: '2025-06-01T12:00:00Z',
        updated_at: '2025-06-01T12:00:00Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

function makeZip(entries: Record<string, unknown>): Uint8Array {
  const packed: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) {
    // Re-wrap via `new Uint8Array(...)` to align realms between strToU8
    // (Node-land TextEncoder inside fflate) and the global Uint8Array that
    // fflate's internal `instanceof Uint8Array` check uses. Without this,
    // vitest's jsdom setup causes zipSync to treat the bytes as a nested
    // directory object. In a real browser there's only one realm so this
    // is a no-op.
    packed[name] = new Uint8Array(
      strToU8(typeof value === 'string' ? value : JSON.stringify(value)),
    );
  }
  return zipSync(packed);
}

function fileFromBytes(bytes: Uint8Array, name = 'export.zip'): File {
  // jsdom's File mis-encodes a raw Uint8Array passed as a BlobPart (it's
  // stringified rather than preserved). We construct an empty File for the
  // name/metadata and override `arrayBuffer` to return our bytes directly.
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
  Object.defineProperty(file, 'size', {
    value: buf.byteLength,
    configurable: true,
  });
  return file;
}

describe('parseCloudZip', () => {
  it('happy path — maps conversations.json to a UnifiedSessionEntry manifest', async () => {
    const convs = [
      buildConversation('aaaa1111-1111-1111-1111-111111111111', 'Alpha'),
      buildConversation('bbbb2222-2222-2222-2222-222222222222', 'Beta'),
    ];
    const zip = makeZip({ 'conversations.json': convs });
    const data = await parseCloudZip(fileFromBytes(zip));

    expect(data.manifest.sessions).toHaveLength(2);
    expect(data.manifest.counts.cloud).toBe(2);
    expect(data.manifest.counts.cowork).toBe(0);
    expect(data.manifest.schemaVersion).toBe(1);

    // Map carries the raw conversations with chat_messages for in-memory drill-in.
    expect(data.conversationsById.size).toBe(2);
    const stored = data.conversationsById.get('aaaa1111-1111-1111-1111-111111111111')!;
    expect(stored.chat_messages).toHaveLength(1);

    // Label includes filename + formatted size.
    expect(data.sourceLabel).toMatch(/^export\.zip \(/);
  });

  it('ignores optional projects/users/memories but keeps conversations', async () => {
    const zip = makeZip({
      'conversations.json': [
        buildConversation('1'.repeat(8) + '-1111-1111-1111-111111111111', 'Solo'),
      ],
      'projects.json': [],
      'users.json': [],
      'memories.json': [],
      'README.txt': 'ignored',
    });
    const data = await parseCloudZip(fileFromBytes(zip));
    expect(data.manifest.sessions).toHaveLength(1);
  });

  it('throws a clear error when conversations.json is missing', async () => {
    const zip = makeZip({ 'users.json': [] });
    await expect(parseCloudZip(fileFromBytes(zip))).rejects.toThrow(
      /does not contain conversations\.json/i,
    );
  });

  it('throws on malformed conversations JSON', async () => {
    const zip = makeZip({ 'conversations.json': '{ not-json' });
    await expect(parseCloudZip(fileFromBytes(zip))).rejects.toThrow(/not valid JSON/);
  });

  it('throws when conversations.json is not an array', async () => {
    const zip = makeZip({ 'conversations.json': { nope: true } });
    await expect(parseCloudZip(fileFromBytes(zip))).rejects.toThrow(/is not a JSON array/);
  });

  it('throws when the archive bytes are not a valid ZIP', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(parseCloudZip(fileFromBytes(junk))).rejects.toThrow(/Could not read ZIP archive/);
  });
});
