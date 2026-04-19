import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countToolUsesInMessage, streamToolUses } from '../../src/lib/toolUses.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-toolUses-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('countToolUsesInMessage', () => {
  it('tallies tool_use blocks by name', () => {
    const acc: Record<string, number> = {};
    countToolUsesInMessage(
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't3', name: 'Edit', input: {} },
        ],
      },
      acc,
    );
    expect(acc).toEqual({ Bash: 2, Edit: 1 });
  });

  it('accumulates across multiple calls (same acc object)', () => {
    const acc: Record<string, number> = { Bash: 1 };
    countToolUsesInMessage(
      {
        content: [
          { type: 'tool_use', name: 'Bash' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
      acc,
    );
    expect(acc).toEqual({ Bash: 2, Read: 1 });
  });

  it('ignores text / thinking / tool_result / unknown blocks', () => {
    const acc: Record<string, number> = {};
    countToolUsesInMessage(
      {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'thinking', thinking: '…' },
          { type: 'tool_result', tool_use_id: 't1', content: 'out' },
          { type: 'weird-future-block', foo: 'bar' },
        ],
      },
      acc,
    );
    expect(acc).toEqual({});
  });

  it('skips tool_use blocks with missing or empty name (treated as malformed)', () => {
    const acc: Record<string, number> = {};
    countToolUsesInMessage(
      {
        content: [
          { type: 'tool_use', id: 't1' }, // no name
          { type: 'tool_use', id: 't2', name: '' }, // empty name
          { type: 'tool_use', id: 't3', name: 42 }, // non-string
          { type: 'tool_use', id: 't4', name: 'Bash' },
        ],
      },
      acc,
    );
    expect(acc).toEqual({ Bash: 1 });
  });

  it('no-ops on string-content messages (no tool_use possible)', () => {
    const acc: Record<string, number> = {};
    countToolUsesInMessage({ role: 'assistant', content: 'plain text' }, acc);
    expect(acc).toEqual({});
  });

  it('no-ops on missing / non-object / content-less inputs', () => {
    const acc: Record<string, number> = {};
    countToolUsesInMessage(null, acc);
    countToolUsesInMessage(undefined, acc);
    countToolUsesInMessage('not an object', acc);
    countToolUsesInMessage({}, acc); // no content
    countToolUsesInMessage({ content: null }, acc); // null content
    expect(acc).toEqual({});
  });
});

describe('streamToolUses', () => {
  async function writeTranscript(lines: readonly object[]): Promise<string> {
    const file = path.join(tmp, 'transcript.jsonl');
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return file;
  }

  it('returns a histogram across all assistant lines', async () => {
    const file = await writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: 'do the thing' },
        timestamp: 't1',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'on it' },
            { type: 'tool_use', id: 'a', name: 'Bash' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'b', name: 'Bash' },
            { type: 'tool_use', id: 'c', name: 'Edit' },
          ],
        },
      },
    ]);
    expect(await streamToolUses(file)).toEqual({ Bash: 2, Edit: 1 });
  });

  it('ignores tool_use blocks on non-assistant lines', async () => {
    const file = await writeTranscript([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            // A user message carrying a tool_result — never counted. We
            // also shouldn't count a rogue tool_use in a user line.
            { type: 'tool_result', tool_use_id: 'a', content: 'r' },
            { type: 'tool_use', id: 'rogue', name: 'NotAssistant' },
          ],
        },
      },
    ]);
    expect(await streamToolUses(file)).toEqual({});
  });

  it('silently skips malformed lines but keeps counting valid ones', async () => {
    const file = path.join(tmp, 'transcript.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'a', name: 'Bash' }],
          },
        }),
        '{ this is not valid json',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'b', name: 'Edit' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    expect(await streamToolUses(file)).toEqual({ Bash: 1, Edit: 1 });
  });

  it('returns {} for a missing file (never throws)', async () => {
    const missing = path.join(tmp, 'does-not-exist.jsonl');
    expect(await streamToolUses(missing)).toEqual({});
  });

  it('returns {} for an empty file', async () => {
    const file = path.join(tmp, 'empty.jsonl');
    await writeFile(file, '', 'utf8');
    expect(await streamToolUses(file)).toEqual({});
  });
});
