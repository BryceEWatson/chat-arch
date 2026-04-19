import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry, CloudConversation } from '@chat-arch/schema';
import type { DrillInBody, LocalTranscriptEntry } from '../types.js';
import { buildTranscriptMarkdown } from './transcriptMarkdown.js';

/**
 * Unit tests for `buildTranscriptMarkdown` — the Decision-12 copy-transcript
 * helper. DetailMode.test.tsx covers the cloud-human/assistant happy path
 * via a mocked clipboard; these tests pin the branch coverage the plan
 * actually cares about: `tool_use`, `tool_result`, attachments, and the
 * local-transcript kind header path.
 */

const session: UnifiedSessionEntry = {
  id: 's1',
  source: 'cloud',
  rawSessionId: 's1',
  startedAt: 0,
  updatedAt: 0,
  durationMs: 0,
  title: 'Sample',
  titleSource: 'fallback',
  preview: null,
  userTurns: 1,
  model: null,
  modelsUsed: [],
  cwdKind: 'none',
  totalCostUsd: null,
  tokenTotals: null,
} as unknown as UnifiedSessionEntry;

describe('buildTranscriptMarkdown — cloud branches', () => {
  it('renders tool_use as fenced JSON with the tool name', () => {
    const conv: CloudConversation = {
      uuid: 's1',
      name: 'Sample',
      created_at: '2026-04-17T00:00:00Z',
      updated_at: '2026-04-17T00:00:00Z',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'assistant',
          created_at: '2026-04-17T00:00:00Z',
          text: '',
          content: [
            {
              type: 'tool_use',
              // Loose shape — the helper is tolerant of extra keys.
              ...({ name: 'web_search', input: { query: 'hello' } } as object),
            } as unknown as CloudConversation['chat_messages'][number]['content'][number],
          ],
          attachments: [],
        },
      ],
    } as unknown as CloudConversation;

    const body: DrillInBody = { kind: 'cloud', conversation: conv };
    const md = buildTranscriptMarkdown(session, body);

    expect(md).toContain('# Sample');
    expect(md).toContain('## Assistant');
    expect(md).toContain('*tool_use: web_search*');
    expect(md).toContain('```json');
    expect(md).toContain('"query": "hello"');
  });

  it('renders tool_result with fenced body (string + object variants)', () => {
    const conv: CloudConversation = {
      uuid: 's1',
      name: 'Sample',
      created_at: '2026-04-17T00:00:00Z',
      updated_at: '2026-04-17T00:00:00Z',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'assistant',
          created_at: '2026-04-17T00:00:00Z',
          text: '',
          content: [
            {
              type: 'tool_result',
              ...({ content: 'raw string tool output' } as object),
            } as unknown as CloudConversation['chat_messages'][number]['content'][number],
            {
              type: 'tool_result',
              ...({ content: { ok: true, count: 2 } } as object),
            } as unknown as CloudConversation['chat_messages'][number]['content'][number],
          ],
          attachments: [],
        },
      ],
    } as unknown as CloudConversation;

    const body: DrillInBody = { kind: 'cloud', conversation: conv };
    const md = buildTranscriptMarkdown(session, body);

    expect(md).toContain('*tool_result*');
    expect(md).toContain('raw string tool output');
    // Object variant serializes to pretty JSON.
    expect(md).toContain('"ok": true');
    expect(md).toContain('"count": 2');
  });

  it('renders attachments with file_name / file_type and extracted_content fence', () => {
    const conv: CloudConversation = {
      uuid: 's1',
      name: 'Sample',
      created_at: '2026-04-17T00:00:00Z',
      updated_at: '2026-04-17T00:00:00Z',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-04-17T00:00:00Z',
          text: 'see attached',
          content: [
            {
              type: 'text',
              ...({ text: 'see attached' } as object),
            } as unknown as CloudConversation['chat_messages'][number]['content'][number],
          ],
          attachments: [
            {
              file_name: 'notes.txt',
              file_type: 'text/plain',
              extracted_content: 'hello from attachment',
            } as unknown as CloudConversation['chat_messages'][number]['attachments'][number],
          ],
        },
      ],
    } as unknown as CloudConversation;

    const body: DrillInBody = { kind: 'cloud', conversation: conv };
    const md = buildTranscriptMarkdown(session, body);

    expect(md).toContain('## Human');
    expect(md).toContain('see attached');
    expect(md).toContain('*attachment: notes.txt (text/plain)*');
    expect(md).toContain('hello from attachment');
  });

  it('falls back to the raw text field when content[] is empty', () => {
    const conv: CloudConversation = {
      uuid: 's1',
      name: 'Sample',
      created_at: '2026-04-17T00:00:00Z',
      updated_at: '2026-04-17T00:00:00Z',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          created_at: '2026-04-17T00:00:00Z',
          text: 'hi',
          content: [],
          attachments: [],
        },
      ],
    } as unknown as CloudConversation;
    const body: DrillInBody = { kind: 'cloud', conversation: conv };
    const md = buildTranscriptMarkdown(session, body);
    expect(md).toContain('## Human');
    expect(md).toContain('\nhi\n');
  });
});

describe('buildTranscriptMarkdown — local transcript branch', () => {
  const localSession: UnifiedSessionEntry = {
    ...session,
    source: 'cowork',
    title: 'Local Session',
  };

  it('emits `## {kind}` headers per entry type and fenced raw body on malformed entries', () => {
    const entries: readonly LocalTranscriptEntry[] = [
      { type: 'known', line: { type: 'user', message: { role: 'user', content: 'hello' } } },
      {
        type: 'known',
        line: { type: 'assistant', message: { role: 'assistant', content: 'world' } },
      },
      { type: '_malformed', raw: '{not valid json', error: 'parse error' },
    ];
    const body: DrillInBody = { kind: 'local', entries };
    const md = buildTranscriptMarkdown(localSession, body);

    expect(md).toContain('# Local Session');
    expect(md).toContain('## user');
    expect(md).toContain('## assistant');
    expect(md).toContain('## _malformed');
    expect(md).toContain('{not valid json');
  });
});
