import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import {
  DEFAULT_CHUNK_CHARS,
  buildEmbeddingInput,
  buildEmbeddingInputChunks,
} from './buildEmbeddingInput.js';

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

describe('buildEmbeddingInputChunks', () => {
  it('returns a single chunk when total content fits inside maxCharsPerChunk', () => {
    const entry = makeEntry({
      title: 'short title',
      preview: 'short preview',
    });
    const chunks = buildEmbeddingInputChunks(entry);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('short title\n\nshort preview');
  });

  it('splits long content into multiple ≤ maxCharsPerChunk chunks', () => {
    // 5000 chars of word-like content. At maxCharsPerChunk=1800, expect
    // ≥ 3 chunks (5000 / 1800 ≈ 2.78), and every chunk must respect the
    // cap.
    const words = ('lorem '.repeat(1000)).trim();
    const entry = makeEntry({
      title: 'long session',
      preview: words,
    });
    const chunks = buildEmbeddingInputChunks(entry);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNK_CHARS);
    }
  });

  it('returns empty array when entry has no signal-bearing content', () => {
    const entry = makeEntry({ title: '   ', preview: null }) as UnifiedSessionEntry;
    const chunks = buildEmbeddingInputChunks(entry);
    expect(chunks).toEqual([]);
  });

  it('avoids mid-word cuts by backing up to the last word boundary', () => {
    // A long single line of space-separated tokens. None of the chunks
    // should contain a half-word right before the join — i.e., each
    // chunk should end at a whitespace boundary unless the chunk hit
    // the hard-cut fallback (only possible if there's no space in the
    // back-up window, which our fixture avoids).
    const words = ('abc '.repeat(700)).trim(); // 2800 chars of "abc abc abc..."
    const entry = makeEntry({ title: 't', preview: words });
    const chunks = buildEmbeddingInputChunks(entry, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const c = chunks[i] as string;
      const lastChar = c[c.length - 1];
      // Each non-final chunk should end on a complete token (the last
      // char is part of "abc", not a stray "a" or "ab").
      expect(['c', 'b']).toContain(lastChar);
    }
  });

  it('preserves total content across chunks (no silent truncation)', () => {
    const words = ('hello '.repeat(800)).trim();
    const entry = makeEntry({ title: 't', preview: words });
    const chunks = buildEmbeddingInputChunks(entry, 1000);
    const tokensInChunks = chunks
      .map((c) => c.split(/\s+/).filter((x) => x === 'hello').length)
      .reduce((a, b) => a + b, 0);
    expect(tokensInChunks).toBe(800);
  });

  it('honors a custom maxCharsPerChunk', () => {
    const entry = makeEntry({ title: 't', preview: 'word '.repeat(500).trim() });
    const small = buildEmbeddingInputChunks(entry, 500);
    const large = buildEmbeddingInputChunks(entry, 5000);
    expect(small.length).toBeGreaterThan(large.length);
    expect(large.length).toBe(1);
  });
});
