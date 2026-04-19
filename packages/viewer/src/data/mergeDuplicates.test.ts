import { describe, it, expect } from 'vitest';
import {
  mergeDuplicateClusters,
  parseDuplicatesFile,
  buildSessionDuplicateIndex,
  type DuplicatesFile,
} from './mergeDuplicates.js';

function exactFile(
  clusters: { id: string; hash: string; sessionIds: string[]; sampleText: string }[],
): DuplicatesFile {
  return { version: 1, tier: 'browser', generatedAt: 0, clusters };
}

function semanticFile(
  clusters: { id: string; hash: string; sessionIds: string[]; sampleText: string }[],
): DuplicatesFile {
  return { version: 1, tier: 'local', generatedAt: 0, clusters };
}

describe('mergeDuplicateClusters', () => {
  it('(a) exact only — passes through as kind="exact"', () => {
    const merged = mergeDuplicateClusters(
      exactFile([
        { id: 'c1', hash: 'h1', sessionIds: ['s1', 's2'], sampleText: 'foo' },
        { id: 'c2', hash: 'h2', sessionIds: ['s3', 's4', 's5'], sampleText: 'bar' },
      ]),
      null,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]!.kind).toBe('exact');
    expect(merged[0]!.sessionIds).toEqual(['s1', 's2']);
    expect(merged[1]!.kind).toBe('exact');
    expect(merged[1]!.originClusterIds).toEqual(['c2']);
  });

  it('(b) semantic only — passes through as kind="semantic"', () => {
    const merged = mergeDuplicateClusters(
      null,
      semanticFile([{ id: 'sc1', hash: 'sh1', sessionIds: ['s1', 's2'], sampleText: 'x' }]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe('semantic');
  });

  it('(c) both present with overlapping members — merges into one cluster kind="exact+semantic"', () => {
    // Exact cluster {s1,s2,s3}; semantic cluster {s3,s4,s5}. Share s3 → one
    // merged cluster {s1..s5}.
    const merged = mergeDuplicateClusters(
      exactFile([{ id: 'c1', hash: 'h1', sessionIds: ['s1', 's2', 's3'], sampleText: 'ex' }]),
      semanticFile([{ id: 'sc1', hash: 'sh1', sessionIds: ['s3', 's4', 's5'], sampleText: 'sm' }]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe('exact+semantic');
    expect(new Set(merged[0]!.sessionIds)).toEqual(new Set(['s1', 's2', 's3', 's4', 's5']));
    expect(merged[0]!.originClusterIds).toEqual(['c1', 'sc1']);
  });

  it('(d) both present with disjoint members — two clusters, each single-tier kind', () => {
    const merged = mergeDuplicateClusters(
      exactFile([{ id: 'c1', hash: 'h1', sessionIds: ['a1', 'a2'], sampleText: 'ex' }]),
      semanticFile([{ id: 'sc1', hash: 'sh1', sessionIds: ['b1', 'b2'], sampleText: 'sm' }]),
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]!.kind).toBe('exact');
    expect(merged[1]!.kind).toBe('semantic');
  });

  it('transitive merge across three clusters via shared members', () => {
    // e1 = {s1,s2}; s1 = {s2,s3}; e2 = {s3,s4}; all connect through s2 and s3.
    const merged = mergeDuplicateClusters(
      exactFile([
        { id: 'e1', hash: 'h1', sessionIds: ['s1', 's2'], sampleText: 'a' },
        { id: 'e2', hash: 'h2', sessionIds: ['s3', 's4'], sampleText: 'b' },
      ]),
      semanticFile([{ id: 'sc1', hash: 'sh3', sessionIds: ['s2', 's3'], sampleText: 'c' }]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.kind).toBe('exact+semantic');
    expect(new Set(merged[0]!.sessionIds)).toEqual(new Set(['s1', 's2', 's3', 's4']));
  });

  it('both null / empty — returns empty', () => {
    expect(mergeDuplicateClusters(null, null)).toHaveLength(0);
    expect(mergeDuplicateClusters(exactFile([]), semanticFile([]))).toHaveLength(0);
  });
});

describe('parseDuplicatesFile', () => {
  it('returns null for missing / non-object input', () => {
    expect(parseDuplicatesFile(null, 'browser')).toBeNull();
    expect(parseDuplicatesFile(42, 'browser')).toBeNull();
  });

  it('returns null when clusters is missing', () => {
    expect(parseDuplicatesFile({ version: 1 }, 'browser')).toBeNull();
  });

  it('parses a valid payload', () => {
    const payload = {
      version: 1,
      tier: 'browser',
      generatedAt: 123,
      clusters: [{ id: 'c1', hash: 'h1', sessionIds: ['s1', 's2'], sampleText: 't' }],
    };
    const result = parseDuplicatesFile(payload, 'browser');
    expect(result).not.toBeNull();
    expect(result!.clusters).toHaveLength(1);
  });

  it('skips malformed cluster entries', () => {
    const payload = {
      clusters: [
        { id: 'ok', hash: 'h', sessionIds: ['s1'], sampleText: 't' },
        { id: 'bad' }, // missing fields
        null,
      ],
    };
    const result = parseDuplicatesFile(payload, 'browser');
    expect(result!.clusters).toHaveLength(1);
  });
});

describe('buildSessionDuplicateIndex', () => {
  it('maps each sessionId to its cluster with correct memberCount', () => {
    const merged = mergeDuplicateClusters(
      exactFile([{ id: 'c1', hash: 'h1', sessionIds: ['s1', 's2', 's3'], sampleText: 't' }]),
      null,
    );
    const idx = buildSessionDuplicateIndex(merged);
    expect(idx.get('s1')!.memberCount).toBe(3);
    expect(idx.get('s2')!.cluster.id).toBe('c1');
    expect(idx.get('nope')).toBeUndefined();
  });
});
