import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { buildEmbeddingInput } from './buildEmbeddingInput.js';

function makeEntry(overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  const base: UnifiedSessionEntry = {
    id: 'sid-1',
    source: 'cli-direct',
    rawSessionId: 'sid-1',
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: 'Example title',
    titleSource: 'first-prompt',
    preview: null,
    userTurns: 0,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
  };
  return { ...base, ...overrides };
}

describe('buildEmbeddingInput', () => {
  it('concatenates title, summary, preview, userTextSamples with blank-line separators', () => {
    const entry = makeEntry({
      title: 'Refactor the embedding pipeline',
      summary: 'User asks Claude to consolidate the embeddings code path.',
      preview: 'I want to rip the embeddings out of the legacy CLI.',
      userTextSamples: [
        'Let me start by reading the existing embeddings module.',
        'Now I want a buildEmbeddingInput helper.',
      ],
    });

    const out = buildEmbeddingInput(entry);
    expect(out).toBe(
      'Refactor the embedding pipeline' +
        '\n\n' +
        'User asks Claude to consolidate the embeddings code path.' +
        '\n\n' +
        'I want to rip the embeddings out of the legacy CLI.' +
        '\n\n' +
        'Let me start by reading the existing embeddings module.' +
        '\n\n' +
        'Now I want a buildEmbeddingInput helper.',
    );
  });

  it('omits absent summary / preview / userTextSamples without leaving stray separators', () => {
    const entry = makeEntry({
      title: 'Just a title',
    });
    expect(buildEmbeddingInput(entry)).toBe('Just a title');
  });

  it('omits empty userTextSamples entries cleanly', () => {
    const entry = makeEntry({
      title: 'T',
      preview: 'P',
      userTextSamples: ['', '   ', 'real sample'],
    });
    expect(buildEmbeddingInput(entry)).toBe('T\n\nP\n\nreal sample');
  });

  it('truncates at exactly 2000 characters', () => {
    const longBody = 'x'.repeat(3000);
    const entry = makeEntry({
      title: 'T',
      preview: longBody,
    });
    const out = buildEmbeddingInput(entry);
    expect(out.length).toBe(2000);
    // First three chars come from "T\n\n", then the long body.
    expect(out.slice(0, 3)).toBe('T\n\n');
    expect(out.slice(3, 10)).toBe('xxxxxxx');
  });

  it('returns empty string when every signal-bearing field is empty/whitespace', () => {
    // Cast: we deliberately violate UnifiedSessionEntry's "title is never
    // empty" contract to exercise the defensive branch — buildEmbeddingInput
    // must not embed only whitespace even if a caller hands it a degenerate
    // entry.
    const entry = makeEntry({
      title: '   ',
      preview: null,
    }) as UnifiedSessionEntry;
    expect(buildEmbeddingInput(entry)).toBe('');
  });
});
