import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CloudConversation, UnifiedSessionEntry } from '@chat-arch/schema';
import { runCloudExport } from '../../src/sources/cloud.js';
import { buildCloudOutputs, buildEntry } from '../../src/sources/cloud.js';
import { validateEntries } from '../../src/lib/validate-entry.js';
import { logger } from '../../src/lib/logger.js';

let outDir: string;
const warnings: string[] = [];

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-cloud-test-'));
  warnings.length = 0;
  logger.setSink((line) => {
    warnings.push(line);
  });
});

afterEach(async () => {
  logger.resetForTests();
  await rm(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture: 3 conversations covering empty / summary-present / tool-use-heavy.
// ---------------------------------------------------------------------------

function emptyConversation(): CloudConversation {
  return {
    uuid: '11111111-1111-1111-1111-111111111111',
    name: '',
    summary: '',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    account: { uuid: 'user-0000' },
    chat_messages: [],
  };
}

function summaryConversation(): CloudConversation {
  return {
    uuid: '22222222-2222-2222-2222-222222222222',
    name: 'Optimizing the B2B pipeline',
    summary:
      '**Conversation overview**\n\nThe user presented a comprehensive optimization challenge for their B2B SaaS pipeline and discussed strategies.',
    created_at: '2025-06-01T12:00:00Z',
    updated_at: '2025-06-01T13:00:00Z',
    account: { uuid: 'user-0000' },
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        sender: 'human',
        text: 'Hi there, help me optimize my pipeline.',
        content: [{ type: 'text', text: 'Hi there, help me optimize my pipeline.' }],
        created_at: '2025-06-01T12:00:00Z',
        updated_at: '2025-06-01T12:00:00Z',
        attachments: [],
        files: [],
      },
      {
        uuid: 'm2',
        parent_message_uuid: 'm1',
        sender: 'assistant',
        text: 'Sure — here are ideas.',
        content: [{ type: 'text', text: 'Sure — here are ideas.' }],
        created_at: '2025-06-01T12:01:00Z',
        updated_at: '2025-06-01T12:01:00Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

function toolHeavyConversation(): CloudConversation {
  return {
    uuid: '33333333-3333-3333-3333-333333333333',
    name: 'Sweeping artifacts',
    summary: '',
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T10:30:00Z',
    account: { uuid: 'user-0000' },
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        sender: 'human',
        text: 'Search the web for cats',
        content: [{ type: 'text', text: 'Search the web for cats' }],
        created_at: '2026-01-15T10:00:00Z',
        updated_at: '2026-01-15T10:00:00Z',
        attachments: [],
        files: [],
      },
      {
        uuid: 'm2',
        parent_message_uuid: 'm1',
        sender: 'assistant',
        text: 'searching',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'web_search',
            input: { q: 'cats' },
          },
          {
            type: 'tool_use',
            id: 'tu2',
            name: 'web_search',
            input: { q: 'cats 2' },
          },
          {
            type: 'tool_use',
            id: 'tu3',
            name: 'artifacts',
            input: {},
          },
          // Tool-use with missing name — must be ignored.
          {
            type: 'tool_use',
            id: 'tu4',
            name: '',
            input: {},
          },
        ],
        created_at: '2026-01-15T10:01:00Z',
        updated_at: '2026-01-15T10:01:00Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

describe('buildEntry (cloud field mapping)', () => {
  it('maps a summary-present conversation to a cloud-name entry with summary in preview', () => {
    const e = buildEntry(summaryConversation())!;
    expect(e).not.toBeNull();
    expect(e.source).toBe('cloud');
    expect(e.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(e.rawSessionId).toBe('22222222-2222-2222-2222-222222222222');
    expect(e.title).toBe('Optimizing the B2B pipeline');
    expect(e.titleSource).toBe('cloud-name');
    expect(e.summary).toMatch(/^\*\*Conversation overview\*\*/);
    // preview is first 200 chars of summary.
    expect(e.preview).not.toBeNull();
    expect(e.preview!.startsWith('**Conversation overview**')).toBe(true);
    expect(e.userTurns).toBe(1);
    expect(e.assistantTurns).toBe(1);
    expect(e.model).toBeNull();
    expect(e.cwdKind).toBe('none');
    expect(e.totalCostUsd).toBeNull();
    expect(e.transcriptPath).toBe('cloud-conversations/22222222-2222-2222-2222-222222222222.json');
    // No tool_use blocks → topTools omitted.
    expect(e.topTools).toBeUndefined();
    // durationMs = 1 hour.
    expect(e.durationMs).toBe(60 * 60 * 1000);
  });

  it('falls back to UNTITLED_SESSION + titleSource="fallback" when name is empty, emits preview=null for empty conv', () => {
    const e = buildEntry(emptyConversation())!;
    expect(e).not.toBeNull();
    expect(e.title).toBe('Untitled session');
    expect(e.titleSource).toBe('fallback');
    expect(e.preview).toBeNull();
    expect(e.userTurns).toBe(0);
    expect(e.assistantTurns).toBeUndefined();
    expect(e.summary).toBeUndefined();
    expect(e.topTools).toBeUndefined();
    expect(e.durationMs).toBe(0);
  });

  it('tallies tool_use blocks into topTools and ignores nameless blocks', () => {
    const e = buildEntry(toolHeavyConversation())!;
    expect(e.topTools).toBeDefined();
    expect(e.topTools).toEqual({ web_search: 2, artifacts: 1 });
    expect(e.title).toBe('Sweeping artifacts');
    expect(e.titleSource).toBe('cloud-name');
    // No summary — preview falls back to first human text.
    expect(e.preview).toBe('Search the web for cats');
  });

  it('returns null when created_at/updated_at are unparseable', () => {
    const conv: CloudConversation = {
      ...summaryConversation(),
      created_at: 'not-a-date',
      updated_at: 'also-bad',
    };
    const e = buildEntry(conv);
    expect(e).toBeNull();
  });
});

describe('buildCloudOutputs (post-extraction pipeline)', () => {
  it('writes slim cloud-manifest.json + per-conversation chunks, and omits chat_messages from the manifest', async () => {
    const convs = [emptyConversation(), summaryConversation(), toolHeavyConversation()];
    const result = await buildCloudOutputs(convs, outDir);

    expect(result.entries).toHaveLength(3);
    expect(result.conversationsSkipped).toBe(0);

    // Slim manifest exists and is sorted by updatedAt desc.
    const manifestPath = path.join(outDir, 'cloud-manifest.json');
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as UnifiedSessionEntry[];
    expect(parsed).toHaveLength(3);
    expect(parsed[0]!.id).toBe('33333333-3333-3333-3333-333333333333');

    // Manifest entries must NOT carry embedded chat_messages.
    for (const entry of parsed) {
      expect('chat_messages' in (entry as unknown as Record<string, unknown>)).toBe(false);
    }

    // Chunks exist in cloud-conversations/, parseable, carry chat_messages.
    const chunks = await readdir(path.join(outDir, 'cloud-conversations'));
    expect(chunks.sort()).toEqual(
      [
        '11111111-1111-1111-1111-111111111111.json',
        '22222222-2222-2222-2222-222222222222.json',
        '33333333-3333-3333-3333-333333333333.json',
      ].sort(),
    );
    const toolChunkRaw = await readFile(
      path.join(outDir, 'cloud-conversations', '33333333-3333-3333-3333-333333333333.json'),
      'utf8',
    );
    const toolChunk = JSON.parse(toolChunkRaw) as CloudConversation;
    expect(toolChunk.chat_messages).toHaveLength(2);

    // Chunk is compact JSON (no leading newline, no 2-space indent).
    expect(toolChunkRaw.includes('\n  "')).toBe(false);
  });

  it('validates with zero errors and every entry round-trips', async () => {
    const convs = [emptyConversation(), summaryConversation(), toolHeavyConversation()];
    const result = await buildCloudOutputs(convs, outDir);
    const errors = validateEntries(result.entries);
    expect(errors).toEqual([]);

    // JSON.parse the manifest must yield the same entry count.
    const roundtripped = JSON.parse(
      await readFile(path.join(outDir, 'cloud-manifest.json'), 'utf8'),
    ) as UnifiedSessionEntry[];
    expect(roundtripped).toHaveLength(result.entries.length);
  });

  it('pretty-prints the slim manifest (2-space indent, trailing newline)', async () => {
    await buildCloudOutputs([summaryConversation()], outDir);
    const raw = await readFile(path.join(outDir, 'cloud-manifest.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // 2-space indent at top level -> array element begins `[\n  {` or `[]`.
    expect(raw.startsWith('[\n  {')).toBe(true);
  });
});

describe('runCloudExport error paths', () => {
  it('throws a clear error when no ZIP is found in the downloads dir and no --zip is given', async () => {
    const emptyDownloads = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-dl-empty-'));
    try {
      await expect(runCloudExport({ outDir, downloadsDir: emptyDownloads })).rejects.toThrow(
        /no cloud-export ZIP found/,
      );
    } finally {
      await rm(emptyDownloads, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the given zip path does not exist', async () => {
    await expect(
      runCloudExport({ outDir, zipPath: path.join(outDir, 'does-not-exist.zip') }),
    ).rejects.toThrow();
  });
});

describe('end-to-end pipeline write guarantees', () => {
  it('does not retain chat_messages in the returned in-memory entries', async () => {
    const result = await buildCloudOutputs(
      [summaryConversation(), toolHeavyConversation()],
      outDir,
    );
    for (const e of result.entries) {
      expect('chat_messages' in (e as unknown as Record<string, unknown>)).toBe(false);
    }
  });

  it('sorts entries by updatedAt desc before writing', async () => {
    const result = await buildCloudOutputs(
      [emptyConversation(), summaryConversation(), toolHeavyConversation()],
      outDir,
    );
    for (let i = 1; i < result.entries.length; i++) {
      expect(result.entries[i - 1]!.updatedAt).toBeGreaterThanOrEqual(result.entries[i]!.updatedAt);
    }
  });

  it('every chunk file is non-empty and parseable', async () => {
    const result = await buildCloudOutputs(
      [emptyConversation(), summaryConversation(), toolHeavyConversation()],
      outDir,
    );
    for (const e of result.entries) {
      const abs = path.join(outDir, e.transcriptPath!);
      const st = await stat(abs);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBeGreaterThan(0);
      const parsed = JSON.parse(await readFile(abs, 'utf8')) as CloudConversation;
      expect(parsed.uuid).toBe(e.id);
    }
  });
});
