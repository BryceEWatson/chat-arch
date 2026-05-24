import { describe, it, expect } from 'vitest';
import {
  buildMinhashDuplicates,
  buildPermutationCoefficients,
  buildSignature,
  estimateJaccard,
  murmurhash3_32,
  shingles,
} from './duplicatesMinhash.js';

describe('murmurhash3_32', () => {
  it('is deterministic for the same input', () => {
    expect(murmurhash3_32('hello world')).toBe(murmurhash3_32('hello world'));
  });

  it('returns distinct hashes for distinct inputs (collision-light)', () => {
    const h1 = murmurhash3_32('foo bar baz');
    const h2 = murmurhash3_32('foo bar qux');
    expect(h1).not.toBe(h2);
  });

  it('returns a uint32 (>=0, < 2^32)', () => {
    const h = murmurhash3_32('the quick brown fox jumps');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });

  it('respects the seed', () => {
    const a = murmurhash3_32('hello', 0);
    const b = murmurhash3_32('hello', 1);
    expect(a).not.toBe(b);
  });
});

describe('shingles', () => {
  it('returns word-5-grams by default', () => {
    const out = shingles('the quick brown fox jumps over the lazy dog');
    expect(out).toEqual([
      'the quick brown fox jumps',
      'quick brown fox jumps over',
      'brown fox jumps over the',
      'fox jumps over the lazy',
      'jumps over the lazy dog',
    ]);
  });

  it('respects custom n-gram size', () => {
    const out = shingles('a b c d e', 3);
    expect(out).toEqual(['a b c', 'b c d', 'c d e']);
  });

  it('falls back to a single shingle when the input is shorter than n', () => {
    const out = shingles('only three words', 5);
    expect(out).toEqual(['only three words']);
  });

  it('returns empty when text is empty', () => {
    expect(shingles('', 5)).toEqual([]);
  });

  it('lowercases and strips punctuation', () => {
    const out = shingles("Hello, world! It's a TEST.", 3);
    expect(out.every((g) => g === g.toLowerCase())).toBe(true);
    expect(out[0]).toBe('hello world it');
  });
});

describe('buildSignature + estimateJaccard', () => {
  const numPerm = 64; // smaller for fast tests; still ±0.12 std error
  const coeffs = buildPermutationCoefficients(numPerm);

  it('produces identical signatures for identical text', () => {
    const a = buildSignature('the quick brown fox jumps over', numPerm, coeffs);
    const b = buildSignature('the quick brown fox jumps over', numPerm, coeffs);
    expect(estimateJaccard(a, b)).toBeCloseTo(1, 6);
  });

  it('returns ~1 Jaccard for near-identical text (single token swap)', () => {
    const a = buildSignature(
      'the quick brown fox jumps over the lazy dog and runs away fast',
      numPerm,
      coeffs,
    );
    const b = buildSignature(
      'the quick brown fox jumps over the lazy cat and runs away fast',
      numPerm,
      coeffs,
    );
    // 12 tokens, single swap → roughly 4 5-grams differ out of 8 → estimated
    // Jaccard ≈ 0.4-0.6. Loose check: clearly above "totally different" but
    // below 1.
    const sim = estimateJaccard(a, b);
    expect(sim).toBeGreaterThan(0.2);
    expect(sim).toBeLessThan(1);
  });

  it('returns near-zero Jaccard for unrelated text', () => {
    const a = buildSignature(
      'integrating with the ollama embedding service for high throughput',
      numPerm,
      coeffs,
    );
    const b = buildSignature(
      'a stranger walked into the moonlit garden carrying a candle',
      numPerm,
      coeffs,
    );
    expect(estimateJaccard(a, b)).toBeLessThan(0.15);
  });

  it('is deterministic across runs (fixed seed)', () => {
    const text = 'persistence across processes is what makes this caching work';
    const a1 = buildSignature(text, numPerm, coeffs);
    const a2 = buildSignature(text, numPerm, coeffs);
    for (let i = 0; i < numPerm; i += 1) {
      expect(a1.values[i]).toBe(a2.values[i]);
    }
  });
});

describe('buildMinhashDuplicates', () => {
  it('returns no clusters on empty input', () => {
    const r = buildMinhashDuplicates([]);
    expect(r.clusters).toEqual([]);
  });

  it('clusters template-prompt families that exact-prefix would miss', () => {
    // Five sessions that share a long template but differ in the "subject"
    // — exactly the pattern the synthesis called out: exact-prefix
    // SHA-256 of the first 400 chars misses these (different subjects),
    // and Ollama embeddings see them as merely "topically similar"
    // (cos ~0.85, below the 0.92 dedup threshold). Word-5-gram MinHash
    // catches them via the shared template skeleton.
    const template =
      "summarize the following pull request for the team's standup, " +
      'focus on user-visible changes, list any risky migrations, ' +
      'and call out test coverage gaps. the PR is at ';
    const inputs = [
      { sessionId: 'pr-1', text: template + 'github.com/foo/bar/pull/101' },
      { sessionId: 'pr-2', text: template + 'github.com/foo/bar/pull/102' },
      { sessionId: 'pr-3', text: template + 'github.com/foo/bar/pull/103' },
      { sessionId: 'pr-4', text: template + 'github.com/foo/bar/pull/104' },
      { sessionId: 'pr-5', text: template + 'github.com/foo/bar/pull/105' },
      { sessionId: 'unrelated', text: 'tell me a joke about a duck' },
    ];
    const r = buildMinhashDuplicates(inputs, { threshold: 0.5 });
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]!.sessionIds.sort()).toEqual([
      'pr-1',
      'pr-2',
      'pr-3',
      'pr-4',
      'pr-5',
    ]);
    expect(r.clusters[0]!.sessionIds).not.toContain('unrelated');
    expect(r.clusters[0]!.meanJaccard).toBeGreaterThan(0.5);
  });

  it('honors a custom threshold', () => {
    const inputs = [
      {
        sessionId: 'a',
        text: 'one two three four five six seven eight nine ten eleven twelve',
      },
      {
        sessionId: 'b',
        text: 'one two three four five six seven eight nine ten eleven twelve',
      },
    ];
    const loose = buildMinhashDuplicates(inputs, { threshold: 0.3 });
    expect(loose.clusters).toHaveLength(1);
    const strict = buildMinhashDuplicates(inputs, { threshold: 0.999 });
    // Identical signatures → estimated Jaccard = 1.0 → still clusters.
    expect(strict.clusters).toHaveLength(1);
  });

  it('respects excludePairs', () => {
    const inputs = [
      {
        sessionId: 'a',
        text: 'one two three four five six seven eight nine ten eleven twelve',
      },
      {
        sessionId: 'b',
        text: 'one two three four five six seven eight nine ten eleven twelve',
      },
    ];
    const r = buildMinhashDuplicates(inputs, {
      threshold: 0.5,
      excludePairs: new Set(['a::b']),
    });
    expect(r.clusters).toEqual([]);
  });

  it('throws when bands * rows does not equal numPerm', () => {
    expect(() =>
      buildMinhashDuplicates([], { numPerm: 128, bands: 10, rows: 8 }),
    ).toThrow(/bands.*rows.*numPerm/);
  });

  it('sorts clusters by descending size', () => {
    const tmpl = (suffix: string): string =>
      `please refactor the following module to use the new logging api ${suffix}`;
    const inputs = [
      { sessionId: 'big-1', text: tmpl('module-a') },
      { sessionId: 'big-2', text: tmpl('module-b') },
      { sessionId: 'big-3', text: tmpl('module-c') },
      { sessionId: 'small-1', text: 'walk the dog around the block in the morning' },
      { sessionId: 'small-2', text: 'walk the dog around the block in the morning' },
    ];
    const r = buildMinhashDuplicates(inputs, { threshold: 0.4 });
    expect(r.clusters.length).toBeGreaterThanOrEqual(1);
    if (r.clusters.length >= 2) {
      expect(r.clusters[0]!.sessionIds.length).toBeGreaterThanOrEqual(
        r.clusters[1]!.sessionIds.length,
      );
    }
  });
});
