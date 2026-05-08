import { describe, it, expect } from 'vitest';
import type { Correction, CorrectionClassification } from '@chat-arch/schema';
import {
  buildPatterns,
  filterClassified,
  normalizeRule,
  type SentenceRef,
} from './cluster-corrections-cli.js';

function unitVec(values: number[]): Float32Array {
  let sq = 0;
  for (const v of values) sq += v * v;
  const n = Math.sqrt(sq) || 1;
  return Float32Array.from(values.map((v) => v / n));
}

function makeCorrection(
  id: string,
  sessionId: string,
  rule: string,
  classOverrides: Partial<CorrectionClassification> = {},
): Correction {
  return {
    id,
    sessionId,
    userTurnIndex: 0,
    excerpt: "don't do that",
    precedingAssistantExcerpt: null,
    signals: [{ kind: 'explicit-no', phrase: "don't" }],
    classification: {
      kind: 'behavior-rule',
      distilledRule: rule,
      confidence: 0.8,
      actionable: true,
      ...classOverrides,
    },
  };
}

describe('normalizeRule', () => {
  it('lowercases', () => {
    expect(normalizeRule('Do Not Add Docstrings')).toBe('do not add docstrings');
  });

  it('collapses whitespace', () => {
    expect(normalizeRule('use   bullets   not\tparagraphs')).toBe(
      'use bullets not paragraphs',
    );
  });

  it('strips trailing punctuation', () => {
    expect(normalizeRule('use bullets not paragraphs.')).toBe('use bullets not paragraphs');
    expect(normalizeRule('really stop!!')).toBe('really stop');
    expect(normalizeRule('  do this;  ')).toBe('do this');
  });

  it('preserves internal punctuation', () => {
    expect(normalizeRule("Don't use grep, use ripgrep.")).toBe(
      "don't use grep, use ripgrep",
    );
  });
});

describe('filterClassified', () => {
  it('drops null classification, non-actionable, and below-threshold confidence', () => {
    const a = makeCorrection('a', 's1', 'rule a');
    const b: Correction = { ...makeCorrection('b', 's2', 'rule b'), classification: null };
    const c = makeCorrection('c', 's3', 'rule c', { actionable: false });
    const d = makeCorrection('d', 's4', 'rule d', { confidence: 0.4 });
    const e = makeCorrection('e', 's5', 'rule e', { confidence: 0.5 });

    const out = filterClassified([a, b, c, d, e]);
    expect(out.map((x) => x.id)).toEqual(['a', 'e']);
  });
});

describe('buildPatterns', () => {
  const opts = {
    clusterThreshold: 0.9,
    alreadyEncodedThreshold: 0.85,
    minOccurrences: 3,
  };

  it('returns empty when no corrections', () => {
    expect(buildPatterns([], [], [], [], opts)).toEqual([]);
  });

  it('drops clusters below min-occurrences (distinct sessionIds)', () => {
    // Two corrections, both same session — even if they cluster, count = 1.
    const c1 = makeCorrection('c1', 'sX', 'do not add docstrings');
    const c2 = makeCorrection('c2', 'sX', 'do not add docstrings');
    const v = unitVec([1, 0, 0]);
    const patterns = buildPatterns([c1, c2], [v, v], [], [], opts);
    expect(patterns).toEqual([]);
  });

  it('counts distinct sessionIds, not raw instances', () => {
    const corrs = [
      makeCorrection('c1', 's1', 'no docstrings'),
      makeCorrection('c2', 's1', 'no docstrings'), // duplicate session
      makeCorrection('c3', 's2', 'no docstrings'),
      makeCorrection('c4', 's3', 'no docstrings'),
    ];
    const v = unitVec([1, 0, 0]);
    const patterns = buildPatterns(corrs, [v, v, v, v], [], [], opts);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.occurrenceCount).toBe(3);
    expect(patterns[0]!.instanceIds).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('picks canonical by highest confidence; tiebreak alphabetical', () => {
    const corrs = [
      makeCorrection('c1', 's1', 'zzz rule', { confidence: 0.9 }),
      makeCorrection('c2', 's2', 'aaa rule', { confidence: 0.9 }),
      makeCorrection('c3', 's3', 'mmm rule', { confidence: 0.95 }),
    ];
    const v = unitVec([1, 0, 0]);
    const patterns = buildPatterns(corrs, [v, v, v], [], [], opts);
    expect(patterns[0]!.canonicalRule).toBe('mmm rule');
  });

  it('canonical id derives from normalized rule (case/punct insensitive)', () => {
    const corrsA = [
      makeCorrection('a1', 's1', 'No Docstrings.', { confidence: 0.9 }),
      makeCorrection('a2', 's2', 'No Docstrings.', { confidence: 0.9 }),
      makeCorrection('a3', 's3', 'No Docstrings.', { confidence: 0.9 }),
    ];
    const corrsB = [
      makeCorrection('b1', 's1', 'no docstrings', { confidence: 0.9 }),
      makeCorrection('b2', 's2', 'no docstrings', { confidence: 0.9 }),
      makeCorrection('b3', 's3', 'no docstrings', { confidence: 0.9 }),
    ];
    const v = unitVec([1, 0, 0]);
    const a = buildPatterns(corrsA, [v, v, v], [], [], opts);
    const b = buildPatterns(corrsB, [v, v, v], [], [], opts);
    expect(a[0]!.id).toBe(b[0]!.id);
    // Display rule preserves the un-normalized form.
    expect(a[0]!.canonicalRule).toBe('No Docstrings.');
  });

  it('separates dissimilar rules into distinct patterns', () => {
    const corrs = [
      makeCorrection('c1', 's1', 'no docstrings'),
      makeCorrection('c2', 's2', 'no docstrings'),
      makeCorrection('c3', 's3', 'no docstrings'),
      makeCorrection('c4', 's4', 'use bullets'),
      makeCorrection('c5', 's5', 'use bullets'),
      makeCorrection('c6', 's6', 'use bullets'),
    ];
    const a = unitVec([1, 0, 0]);
    const b = unitVec([0, 1, 0]);
    const patterns = buildPatterns(corrs, [a, a, a, b, b, b], [], [], opts);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]!.id).not.toBe(patterns[1]!.id);
  });

  it('flags alreadyEncoded when centroid matches a config sentence above threshold', () => {
    const corrs = [
      makeCorrection('c1', 's1', 'no docstrings'),
      makeCorrection('c2', 's2', 'no docstrings'),
      makeCorrection('c3', 's3', 'no docstrings'),
    ];
    const ruleV = unitVec([1, 0, 0]);
    const matchingSentence = unitVec([1, 0.01, 0]); // ~1.0 cosine
    const sentenceRefs: SentenceRef[] = [{ configDocId: 'doc1', sentenceIndex: 0 }];
    const patterns = buildPatterns(
      corrs,
      [ruleV, ruleV, ruleV],
      [matchingSentence],
      sentenceRefs,
      opts,
    );
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.alreadyEncoded).toBe(true);
  });

  it('does not flag alreadyEncoded when no config sentence is similar enough', () => {
    const corrs = [
      makeCorrection('c1', 's1', 'no docstrings'),
      makeCorrection('c2', 's2', 'no docstrings'),
      makeCorrection('c3', 's3', 'no docstrings'),
    ];
    const ruleV = unitVec([1, 0, 0]);
    const orthogonalSentence = unitVec([0, 1, 0]);
    const patterns = buildPatterns(corrs, [ruleV, ruleV, ruleV], [orthogonalSentence], [
      { configDocId: 'doc1', sentenceIndex: 0 },
    ], opts);
    expect(patterns[0]!.alreadyEncoded).toBe(false);
  });

  it('alreadyEncoded reduces confidence by 0.9x', () => {
    const corrs = [
      makeCorrection('c1', 's1', 'no docstrings', { confidence: 1 }),
      makeCorrection('c2', 's2', 'no docstrings', { confidence: 1 }),
      makeCorrection('c3', 's3', 'no docstrings', { confidence: 1 }),
      makeCorrection('c4', 's4', 'no docstrings', { confidence: 1 }),
      makeCorrection('c5', 's5', 'no docstrings', { confidence: 1 }),
    ];
    const ruleV = unitVec([1, 0, 0]);
    const matchSentence = unitVec([1, 0, 0]);
    const noMatch = unitVec([0, 1, 0]);

    const withMatch = buildPatterns(
      corrs,
      [ruleV, ruleV, ruleV, ruleV, ruleV],
      [matchSentence],
      [{ configDocId: 'doc1', sentenceIndex: 0 }],
      opts,
    );
    const without = buildPatterns(
      corrs,
      [ruleV, ruleV, ruleV, ruleV, ruleV],
      [noMatch],
      [{ configDocId: 'doc1', sentenceIndex: 0 }],
      opts,
    );

    // mean confidence = 1, occurrenceCount = 5 → min(1, 5/5)=1 → base = 1.
    // alreadyEncoded multiplies by 0.9.
    expect(without[0]!.confidence).toBeCloseTo(1, 6);
    expect(withMatch[0]!.confidence).toBeCloseTo(0.9, 6);
  });

  it('confidence factor caps occurrenceCount/5 at 1', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        makeCorrection(`c${i}`, `s${i}`, 'rule', { confidence: 1 }),
      );
    const v = unitVec([1, 0, 0]);
    const three = mk(3);
    const ten = mk(10);
    const pThree = buildPatterns(three, three.map(() => v), [], [], opts);
    const pTen = buildPatterns(ten, ten.map(() => v), [], [], opts);
    expect(pThree[0]!.confidence).toBeCloseTo(0.6, 6); // 1 * 3/5
    expect(pTen[0]!.confidence).toBeCloseTo(1, 6); // 1 * min(1, 10/5)
  });

  it('sorts by confidence desc, then occurrenceCount desc', () => {
    // Two clusters: A has 3 sessions with mean confidence 0.6 → 0.6 * 3/5 = 0.36
    //               B has 5 sessions with mean confidence 0.5 → 0.5 * 1 = 0.5
    const cA = [
      makeCorrection('a1', 's1', 'rule a', { confidence: 0.6 }),
      makeCorrection('a2', 's2', 'rule a', { confidence: 0.6 }),
      makeCorrection('a3', 's3', 'rule a', { confidence: 0.6 }),
    ];
    const cB = [
      makeCorrection('b1', 't1', 'rule b', { confidence: 0.5 }),
      makeCorrection('b2', 't2', 'rule b', { confidence: 0.5 }),
      makeCorrection('b3', 't3', 'rule b', { confidence: 0.5 }),
      makeCorrection('b4', 't4', 'rule b', { confidence: 0.5 }),
      makeCorrection('b5', 't5', 'rule b', { confidence: 0.5 }),
    ];
    const a = unitVec([1, 0, 0]);
    const b = unitVec([0, 1, 0]);
    const patterns = buildPatterns(
      [...cA, ...cB],
      [a, a, a, b, b, b, b, b],
      [],
      [],
      opts,
    );
    expect(patterns).toHaveLength(2);
    expect(patterns[0]!.canonicalRule).toBe('rule b');
    expect(patterns[1]!.canonicalRule).toBe('rule a');
  });

  it('emits placeholder firstSeen=0/lastSeen=0/scope=global/proposedUpgrades=[]', () => {
    const corrs = [
      makeCorrection('c1', 's1', 'rule'),
      makeCorrection('c2', 's2', 'rule'),
      makeCorrection('c3', 's3', 'rule'),
    ];
    const v = unitVec([1, 0, 0]);
    const p = buildPatterns(corrs, [v, v, v], [], [], opts)[0]!;
    expect(p.firstSeen).toBe(0);
    expect(p.lastSeen).toBe(0);
    expect(p.scope).toEqual({ kind: 'global' });
    expect(p.proposedUpgrades).toEqual([]);
    expect(p.recurringPostApplication).toBe(false);
    expect(p.id.startsWith('pat_')).toBe(true);
    expect(p.id).toHaveLength('pat_'.length + 12);
  });
});
