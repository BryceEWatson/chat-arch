import { describe, it, expect } from 'vitest';
import type { CloudConversation } from '@chat-arch/schema';
import { buildCloudEntries, buildEntry } from '../src/cloud-mapping.js';
import { validateEntries } from '../src/lib/validate-entry.js';

// ---------------------------------------------------------------------------
// Fixtures — deliberately cover the branches called out in the review doc:
// empty, summary-present, tool-use-heavy, nameless, unparseable timestamps,
// unknown content-block types.
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
          { type: 'tool_use', id: 'tu1', name: 'web_search', input: { q: 'cats' } },
          { type: 'tool_use', id: 'tu2', name: 'web_search', input: { q: 'cats 2' } },
          { type: 'tool_use', id: 'tu3', name: 'artifacts', input: {} },
          // Tool-use with missing name — must be ignored.
          { type: 'tool_use', id: 'tu4', name: '', input: {} },
          // Unknown block type — must be ignored for tool histogram.
          { type: 'weird_new_thing', foo: 'bar' },
        ],
        created_at: '2026-01-15T10:01:00Z',
        updated_at: '2026-01-15T10:01:00Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

function unparseableConversation(): CloudConversation {
  return {
    ...summaryConversation(),
    uuid: '44444444-4444-4444-4444-444444444444',
    created_at: 'not-a-date',
    updated_at: 'also-bad',
  };
}

describe('buildEntry (pure, browser-safe)', () => {
  it('maps summary-present conversation into cloud-name entry with summary preview', () => {
    const e = buildEntry(summaryConversation())!;
    expect(e).not.toBeNull();
    expect(e.source).toBe('cloud');
    expect(e.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(e.rawSessionId).toBe('22222222-2222-2222-2222-222222222222');
    expect(e.title).toBe('Optimizing the B2B pipeline');
    expect(e.titleSource).toBe('cloud-name');
    expect(e.summary).toMatch(/^\*\*Conversation overview\*\*/);
    expect(e.preview).not.toBeNull();
    expect(e.preview!.startsWith('**Conversation overview**')).toBe(true);
    expect(e.userTurns).toBe(1);
    expect(e.assistantTurns).toBe(1);
    expect(e.model).toBeNull();
    expect(e.cwdKind).toBe('none');
    expect(e.totalCostUsd).toBeNull();
    expect(e.transcriptPath).toBe('cloud-conversations/22222222-2222-2222-2222-222222222222.json');
    expect(e.topTools).toBeUndefined();
    expect(e.durationMs).toBe(60 * 60 * 1000);
  });

  it('falls back to UNTITLED_SESSION + preview=null for empty conv', () => {
    const e = buildEntry(emptyConversation())!;
    expect(e.title).toBe('Untitled session');
    expect(e.titleSource).toBe('fallback');
    expect(e.preview).toBeNull();
    expect(e.userTurns).toBe(0);
    expect(e.assistantTurns).toBeUndefined();
    expect(e.summary).toBeUndefined();
    expect(e.topTools).toBeUndefined();
    expect(e.durationMs).toBe(0);
  });

  it('tallies tool_use blocks, ignores nameless & unknown block types', () => {
    const e = buildEntry(toolHeavyConversation())!;
    expect(e.topTools).toEqual({ web_search: 2, artifacts: 1 });
    expect(e.title).toBe('Sweeping artifacts');
    expect(e.titleSource).toBe('cloud-name');
    // No summary -> preview falls back to first human text.
    expect(e.preview).toBe('Search the web for cats');
  });

  it('returns null when timestamps are unparseable', () => {
    expect(buildEntry(unparseableConversation())).toBeNull();
  });
});

describe('buildCloudEntries (pure aggregate)', () => {
  it('returns sorted-desc entries, conversationsById map, summary count, skips', () => {
    const data = {
      conversations: [
        emptyConversation(),
        summaryConversation(),
        toolHeavyConversation(),
        unparseableConversation(),
      ],
    };
    const { entries, conversationsById, summaryCount, conversationsSkipped } =
      buildCloudEntries(data);

    expect(entries).toHaveLength(3);
    expect(conversationsSkipped).toBe(1);
    expect(summaryCount).toBe(1);

    // Sort order: toolHeavy (2026) > summary (2025-06) > empty (2025-01).
    expect(entries[0]!.id).toBe('33333333-3333-3333-3333-333333333333');
    expect(entries[1]!.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(entries[2]!.id).toBe('11111111-1111-1111-1111-111111111111');

    // conversationsById carries only the entries that survived.
    expect(conversationsById.size).toBe(3);
    expect(conversationsById.has('44444444-4444-4444-4444-444444444444')).toBe(false);
    const conv = conversationsById.get('22222222-2222-2222-2222-222222222222')!;
    expect(conv.chat_messages).toHaveLength(2);
  });

  it('produces entries that pass validateEntries', () => {
    const { entries } = buildCloudEntries({
      conversations: [emptyConversation(), summaryConversation(), toolHeavyConversation()],
    });
    expect(validateEntries(entries)).toEqual([]);
  });

  it('is pure — same input produces same output', () => {
    const data = {
      conversations: [summaryConversation(), toolHeavyConversation()],
    };
    const a = buildCloudEntries(data);
    const b = buildCloudEntries(data);
    expect(JSON.stringify(a.entries)).toEqual(JSON.stringify(b.entries));
  });

  it('handles empty input', () => {
    const r = buildCloudEntries({ conversations: [] });
    expect(r.entries).toEqual([]);
    expect(r.conversationsById.size).toBe(0);
    expect(r.summaryCount).toBe(0);
    expect(r.conversationsSkipped).toBe(0);
  });
});
