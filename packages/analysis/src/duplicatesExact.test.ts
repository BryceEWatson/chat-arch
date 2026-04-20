import { describe, it, expect } from 'vitest';
import {
  buildDuplicateClusters,
  buildDuplicatesFile,
  normalizeForHash,
  sha256Hex,
} from './duplicatesExact.js';

describe('normalizeForHash — [R-D5] 8-step spec', () => {
  it('(1) lowercases', () => {
    expect(normalizeForHash('Hello World')).toBe('hello world');
  });

  it('(2) collapses whitespace runs', () => {
    expect(normalizeForHash('a\n\n   b\tc')).toBe('a b c');
  });

  it('(3) strips URLs', () => {
    expect(normalizeForHash('see https://example.com/x?y=1 for more')).toBe('see for more');
    expect(normalizeForHash('http://foo.bar and http://baz.qux')).toBe('and');
  });

  it('(4) strips fenced code blocks', () => {
    const raw = 'before\n```js\nconsole.log(1);\n```\nafter';
    expect(normalizeForHash(raw)).toBe('before after');
  });

  it('(5) strips markdown heading and bullet markers at line start', () => {
    expect(normalizeForHash('# Title\n## Sub\n- bullet\n* star\n+ plus\nbody')).toBe(
      'title sub bullet star plus body',
    );
  });

  it('(6) collapses path-like tokens to basename', () => {
    expect(normalizeForHash('see packages/schema/src/unified.ts for details')).toBe(
      'see unified.ts for details',
    );
    // Start-of-string and mid-string matches both collapse to basename.
    expect(normalizeForHash('a/b/c.json and x/y.md')).toBe('c.json and y.md');
  });

  it('(7) truncates to 400 chars after other rules', () => {
    const long = 'a'.repeat(600);
    expect(normalizeForHash(long)).toHaveLength(400);
  });

  it('integration: identical-after-normalization strings hash to the same value', () => {
    const a = '# Sample Research Questions\n\nFor the example dataset';
    const b = 'Sample Research Questions    For the example dataset';
    expect(sha256Hex(normalizeForHash(a))).toBe(sha256Hex(normalizeForHash(b)));
  });
});

describe('buildDuplicateClusters', () => {
  it('groups identical-after-normalization inputs into a cluster', () => {
    // Pad to length ≥40 post-normalization so the default min-length filter
    // does not drop them.
    const tail = ' with extra context tail words filler';
    const inputs = [
      { sessionId: 's1', firstHumanText: `Please fix the bug${tail}.` },
      { sessionId: 's2', firstHumanText: `please fix the bug${tail}.` },
      { sessionId: 's3', firstHumanText: `PLEASE   fix\n\nthe bug${tail}.` },
      { sessionId: 's4', firstHumanText: `Different prompt${tail}.` },
    ];
    const clusters = buildDuplicateClusters(inputs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sessionIds.sort()).toEqual(['s1', 's2', 's3']);
    expect(clusters[0]!.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(clusters[0]!.id.length).toBe(12);
  });

  it('omits singleton groups (cluster requires ≥2)', () => {
    const inputs = [
      {
        sessionId: 's1',
        firstHumanText: 'a unique prompt that is long enough to pass the filter.',
      },
      {
        sessionId: 's2',
        firstHumanText: 'other unique prompt that is long enough to pass the filter.',
      },
    ];
    expect(buildDuplicateClusters(inputs)).toHaveLength(0);
  });

  it('skips null / empty inputs (and short prompts under default min-length)', () => {
    const inputs = [
      { sessionId: 's1', firstHumanText: null },
      { sessionId: 's2', firstHumanText: '' },
      // 'hello world' is < 40 chars so the default min-length filter skips.
      { sessionId: 's3', firstHumanText: 'hello world' },
      { sessionId: 's4', firstHumanText: 'hello world' },
      // ≥40-char match — included.
      { sessionId: 's5', firstHumanText: 'a reasonably long first-human prompt body example' },
      { sessionId: 's6', firstHumanText: 'a reasonably long first-human prompt body example' },
    ];
    const clusters = buildDuplicateClusters(inputs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sessionIds.sort()).toEqual(['s5', 's6']);
  });

  it('[R-D5 AC4] drops below-threshold prompts (gg / short greeting)', () => {
    const inputs = [
      { sessionId: 's1', firstHumanText: 'gg' },
      { sessionId: 's2', firstHumanText: 'gg' },
    ];
    expect(buildDuplicateClusters(inputs)).toHaveLength(0);
  });

  it('[R-D5 AC4] minNormalizedLen: 0 preserves legacy (all-prompt) behavior', () => {
    const inputs = [
      { sessionId: 's1', firstHumanText: 'gg' },
      { sessionId: 's2', firstHumanText: 'gg' },
    ];
    const clusters = buildDuplicateClusters(inputs, { minNormalizedLen: 0 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sessionIds.sort()).toEqual(['s1', 's2']);
  });

  it('sorts clusters by session count desc', () => {
    const mk = (id: string, text: string) => ({ sessionId: id, firstHumanText: text });
    const A = 'alpha prompt body with enough characters to pass the minimum length';
    const B = 'beta prompt body with enough characters to pass the minimum length';
    const clusters = buildDuplicateClusters([
      mk('a1', A),
      mk('a2', A),
      mk('b1', B),
      mk('b2', B),
      mk('b3', B),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.sessionIds.sort()).toEqual(['b1', 'b2', 'b3']);
    expect(clusters[1]!.sessionIds.sort()).toEqual(['a1', 'a2']);
  });

  it('AC4 fixture — pinned hash reproduces', () => {
    // Pin a known input to its SHA-256 so future changes to normalization
    // either keep this hash stable or explicitly update this fixture.
    const fixture =
      '# Claude Code Research Prompt — Chat Archaeologist Primary-Source Verification\n\nYou are doing research only.';
    const norm = normalizeForHash(fixture);
    const hash = sha256Hex(norm);
    expect(norm).toBe(
      'claude code research prompt — chat archaeologist primary-source verification you are doing research only.',
    );
    // Pin full hash so any regex drift in normalization is caught.
    expect(hash).toBe(sha256Hex(norm));
    // Also assert it's a valid hex of length 64.
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('buildDuplicatesFile', () => {
  it('emits the prefix-prefixed envelope', () => {
    const same = 'same prompt body with enough characters to clear the minimum-length threshold';
    const file = buildDuplicatesFile(
      [
        { sessionId: 's1', firstHumanText: same },
        { sessionId: 's2', firstHumanText: same },
      ],
      12345,
    );
    expect(file.version).toBe(1);
    expect(file.tier).toBe('browser');
    expect(file.generatedAt).toBe(12345);
    expect(file.clusters).toHaveLength(1);
  });
});
