import { describe, it, expect } from 'vitest';
import {
  parseTranscript,
  lineTextPreview,
  lineFullBody,
  shouldExpand,
  EXPANDER_MIN_CHARS,
} from './transcriptParse.js';

describe('parseTranscript', () => {
  it('handles empty input', () => {
    expect(parseTranscript('')).toEqual([]);
  });
  it('splits well-formed JSONL', () => {
    const text =
      '{"type":"ai-title","aiTitle":"Hello"}\n{"type":"user","message":{"content":"hi"}}\n';
    const out = parseTranscript(text);
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe('known');
    if (out[0]!.type === 'known') {
      expect(out[0]!.line['type']).toBe('ai-title');
    }
  });
  it('wraps malformed lines without dropping them', () => {
    const text = '{"type":"ai-title","aiTitle":"ok"}\nTHIS IS NOT JSON\n';
    const out = parseTranscript(text);
    expect(out).toHaveLength(2);
    expect(out[1]!.type).toBe('_malformed');
    if (out[1]!.type === '_malformed') {
      expect(out[1]!.raw).toBe('THIS IS NOT JSON');
      expect(out[1]!.error).toMatch(/JSON/i);
    }
  });
  it('ignores blank lines', () => {
    const text = '{"type":"user"}\n\n\n{"type":"assistant"}';
    expect(parseTranscript(text)).toHaveLength(2);
  });
  it('treats non-object JSON as malformed', () => {
    const text = '"just a string"\n42\n[1,2]\n{"type":"ok"}';
    const out = parseTranscript(text);
    expect(out.filter((e) => e.type === '_malformed')).toHaveLength(3);
  });
  it('dispatches known types (structural round-trip)', () => {
    const types = [
      'ai-title',
      'user',
      'assistant',
      'attachment',
      'last-prompt',
      'tool_use_summary',
    ];
    const text = types.map((t) => JSON.stringify({ type: t })).join('\n');
    const out = parseTranscript(text);
    expect(out.map((e) => (e.type === 'known' ? (e.line['type'] as string) : '_m'))).toEqual(types);
  });
});

describe('lineTextPreview', () => {
  it('extracts ai-title', () => {
    expect(lineTextPreview({ type: 'ai-title', aiTitle: 'Hello' })).toBe('Hello');
  });
  it('extracts string message content', () => {
    expect(lineTextPreview({ type: 'user', message: { content: 'plain text' } })).toBe(
      'plain text',
    );
  });
  it('joins array content blocks with a divider', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
        ],
      },
    };
    expect(lineTextPreview(line)).toBe('part one · part two');
  });
  it('extracts last-prompt', () => {
    expect(lineTextPreview({ type: 'last-prompt', lastPrompt: 'yo' })).toBe('yo');
  });
  it('returns attachment label (file upload)', () => {
    expect(lineTextPreview({ type: 'attachment', attachment: { file_name: 'a.txt' } })).toBe(
      'attachment: a.txt',
    );
  });

  // --- new extractors ---

  it('summarizes a tool_use block with the preferred input field', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'gcloud auth list', description: 'x' },
          },
        ],
      },
    };
    expect(lineTextPreview(line)).toBe('Bash · gcloud auth list');
  });

  it('falls back to a JSON snippet when tool_use input has no known keys', () => {
    const line = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Weird', input: { foo: 1, bar: true } }] },
    };
    const out = lineTextPreview(line);
    expect(out.startsWith('Weird · {')).toBe(true);
    expect(out).toContain('foo: 1');
    expect(out).toContain('bar: true');
  });

  it('summarizes a string tool_result', () => {
    const line = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'stdout: ok', is_error: false }] },
    };
    expect(lineTextPreview(line)).toBe('stdout: ok');
  });

  it('flags an errored tool_result', () => {
    const line = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'command not found', is_error: true }] },
    };
    expect(lineTextPreview(line)).toBe('error · command not found');
  });

  it('summarizes a tool_result with nested text/image blocks', () => {
    const line = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: [{ type: 'text', text: 'hello' }, { type: 'image' }],
            is_error: false,
          },
        ],
      },
    };
    expect(lineTextPreview(line)).toBe('hello · (image)');
  });

  it('extracts thinking block text', () => {
    const line = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'weighing options' }] },
    };
    expect(lineTextPreview(line)).toBe('thinking · weighing options');
  });

  it('flags encrypted (signature-only) thinking blocks', () => {
    const line = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '', signature: 'a'.repeat(400) }] },
    };
    expect(lineTextPreview(line)).toBe('thinking · (encrypted, 400 chars signature)');
  });

  it('labels redacted_thinking', () => {
    const line = { type: 'assistant', message: { content: [{ type: 'redacted_thinking' }] } };
    expect(lineTextPreview(line)).toBe('thinking · (redacted)');
  });

  it('mixes thinking + tool_use + text in one assistant row', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'planning' },
          { type: 'text', text: 'Let me run:' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    expect(lineTextPreview(line)).toBe('thinking · planning · Let me run: · Bash · ls');
  });

  it('summarizes queue-operation without payload', () => {
    expect(lineTextPreview({ type: 'queue-operation', operation: 'enqueue' })).toBe('enqueue');
  });

  it('includes queue-operation content when present', () => {
    expect(
      lineTextPreview({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'Follow-up prompt',
      }),
    ).toBe('enqueue · Follow-up prompt');
  });

  it('describes file-history-snapshot with file count', () => {
    expect(
      lineTextPreview({
        type: 'file-history-snapshot',
        snapshot: { trackedFileBackups: { 'a.ts': {}, 'b.ts': {} } },
      }),
    ).toBe('snapshot · 2 tracked files');
    expect(
      lineTextPreview({
        type: 'file-history-snapshot',
        isSnapshotUpdate: true,
        snapshot: { trackedFileBackups: {} },
      }),
    ).toBe('snapshot update · 0 tracked files');
  });

  it('summarizes deferred_tools_delta attachments', () => {
    expect(
      lineTextPreview({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['A', 'B', 'C', 'D', 'E'],
          removedNames: [],
        },
      }),
    ).toBe('deferred_tools_delta: +5 (A, B, C, D…)');
  });

  it('labels typed attachments without file_name', () => {
    expect(lineTextPreview({ type: 'attachment', attachment: { type: 'some_unknown_kind' } })).toBe(
      'attachment (some_unknown_kind)',
    );
  });

  it('caps very long previews with an overflow count', () => {
    const long = 'x'.repeat(3000);
    const out = lineTextPreview({ type: 'user', message: { content: long } });
    expect(out.length).toBeLessThan(long.length);
    expect(out).toMatch(/\(\+\d+ chars\)$/);
  });

  it('shows the full content inline when it fits under the preview cap', () => {
    const medium = 'x'.repeat(1000);
    expect(lineTextPreview({ type: 'user', message: { content: medium } })).toBe(medium);
  });
});

describe('lineFullBody', () => {
  it('returns the full unabridged text for long user content', () => {
    const long = 'x'.repeat(1200);
    expect(lineFullBody({ type: 'user', message: { content: long } })).toBe(long);
  });

  it('pretty-prints the tool_use input', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'd' } }],
      },
    };
    const out = lineFullBody(line);
    expect(out.startsWith('[tool_use · Bash]\n')).toBe(true);
    expect(out).toContain('"command": "ls"');
    expect(out).toContain('"description": "d"');
  });

  it('preserves a long tool_result body untruncated', () => {
    const long = 'y'.repeat(5000);
    const line = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: long, is_error: false }] },
    };
    const out = lineFullBody(line);
    expect(out.startsWith('[tool_result]\n')).toBe(true);
    expect(out).toContain(long);
  });

  it('labels error tool_results', () => {
    const line = {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'bad', is_error: true }] },
    };
    expect(lineFullBody(line)).toBe('[tool_result · error]\nbad');
  });

  it('separates multiple blocks with a visible divider', () => {
    const line = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'running' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    const out = lineFullBody(line);
    expect(out.split('\n\n---\n\n')).toHaveLength(3);
    expect(out).toContain('[thinking]\nhmm');
    expect(out).toContain('running');
    expect(out).toContain('[tool_use · Bash]');
  });

  it('annotates encrypted thinking blocks', () => {
    const line = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '', signature: 'a'.repeat(400) }] },
    };
    const out = lineFullBody(line);
    expect(out).toContain('[thinking · encrypted]');
    expect(out).toContain('400 chars of base64 signature');
  });

  it('lists tracked files in a file-history-snapshot', () => {
    const out = lineFullBody({
      type: 'file-history-snapshot',
      snapshot: { trackedFileBackups: { 'src/a.ts': {}, 'src/b.ts': {} } },
    });
    expect(out.split('\n').sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns the extracted content for a file attachment', () => {
    expect(
      lineFullBody({
        type: 'attachment',
        attachment: { file_name: 'notes.md', extracted_content: 'line1\nline2' },
      }),
    ).toBe('[attachment · notes.md]\nline1\nline2');
  });

  it('pretty-prints typed attachment payloads', () => {
    const out = lineFullBody({
      type: 'attachment',
      attachment: { type: 'deferred_tools_delta', addedNames: ['A'], removedNames: [] },
    });
    expect(out).toContain('"type": "deferred_tools_delta"');
    expect(out).toContain('"addedNames"');
  });

  it('returns just the operation string for a bare queue-operation (equals preview)', () => {
    // The caller uses equality to decide whether to render an expander.
    expect(lineFullBody({ type: 'queue-operation', operation: 'enqueue' })).toBe('enqueue');
  });

  it('expands queue-operation content when present', () => {
    expect(
      lineFullBody({ type: 'queue-operation', operation: 'enqueue', content: 'Follow-up' }),
    ).toBe('[enqueue]\nFollow-up');
  });
});

describe('shouldExpand', () => {
  it('returns false when there is no full body', () => {
    expect(shouldExpand('foo', '')).toBe(false);
  });
  it('returns false when preview and full are identical', () => {
    const s = 'x'.repeat(2000);
    expect(shouldExpand(s, s)).toBe(false);
  });
  it('returns false for small structurally-different bodies (short tool_use)', () => {
    // Preview: "Bash · ls", Full: pretty-JSON of the tool_use block.
    // Differs structurally but both are tiny — no expander.
    expect(shouldExpand('Bash · ls', '[tool_use · Bash]\n{\n  "command": "ls"\n}')).toBe(false);
  });
  it('returns true only when the full body crosses the min-char threshold', () => {
    const justUnder = 'x'.repeat(EXPANDER_MIN_CHARS);
    const justOver = 'x'.repeat(EXPANDER_MIN_CHARS + 1);
    expect(shouldExpand('short preview', justUnder)).toBe(false);
    expect(shouldExpand('short preview', justOver)).toBe(true);
  });
});
