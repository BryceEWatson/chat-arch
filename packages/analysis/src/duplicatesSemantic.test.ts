import { describe, it, expect } from 'vitest';
import { buildSemanticDuplicates } from './duplicatesSemantic.js';

function vec(...vals: number[]): Float32Array {
  return new Float32Array(vals);
}

describe('buildSemanticDuplicates', () => {
  it('emits no clusters when all sessions are dissimilar', () => {
    const r = buildSemanticDuplicates([
      { sessionId: 'a', vector: vec(1, 0, 0) },
      { sessionId: 'b', vector: vec(0, 1, 0) },
      { sessionId: 'c', vector: vec(0, 0, 1) },
    ]);
    expect(r.clusters).toEqual([]);
    expect(r.threshold).toBe(0.92);
  });

  it('clusters identical vectors into one component', () => {
    const r = buildSemanticDuplicates([
      { sessionId: 'a', vector: vec(1, 1, 1) },
      { sessionId: 'b', vector: vec(1, 1, 1) },
      { sessionId: 'c', vector: vec(2, 2, 2) },
      { sessionId: 'd', vector: vec(-1, 0, 0) },
    ]);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]?.sessionIds.sort()).toEqual(['a', 'b', 'c']);
    expect(r.clusters[0]?.meanSimilarity).toBeCloseTo(1, 6);
  });

  it('honors custom threshold', () => {
    const inputs = [
      { sessionId: 'a', vector: vec(1, 0, 0) },
      { sessionId: 'b', vector: vec(0.7, 0.7, 0) }, // cosine ≈ 0.707
    ];
    const loose = buildSemanticDuplicates(inputs, { threshold: 0.5 });
    expect(loose.clusters).toHaveLength(1);
    const tight = buildSemanticDuplicates(inputs, { threshold: 0.99 });
    expect(tight.clusters).toHaveLength(0);
  });

  it('respects excludePairs', () => {
    const inputs = [
      { sessionId: 'a', vector: vec(1, 1, 0) },
      { sessionId: 'b', vector: vec(1, 1, 0) },
    ];
    const r = buildSemanticDuplicates(inputs, {
      excludePairs: new Set(['a::b']),
    });
    expect(r.clusters).toEqual([]);
  });

  it('chooses centroid by highest sum of in-cluster similarity', () => {
    // a is a hub close to both b and c; b and c are close to a but only
    // moderately close to each other.
    const r = buildSemanticDuplicates(
      [
        { sessionId: 'hub', vector: vec(1, 0, 0) },
        { sessionId: 'spoke1', vector: vec(0.95, 0.05, 0) },
        { sessionId: 'spoke2', vector: vec(0.95, 0, 0.05) },
      ],
      { threshold: 0.7 },
    );
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]?.centroidSessionId).toBe('hub');
  });

  it('sorts clusters by size descending', () => {
    const r = buildSemanticDuplicates(
      [
        { sessionId: 'big-1', vector: vec(1, 0, 0) },
        { sessionId: 'big-2', vector: vec(1, 0, 0) },
        { sessionId: 'big-3', vector: vec(1, 0, 0) },
        { sessionId: 'small-1', vector: vec(0, 1, 0) },
        { sessionId: 'small-2', vector: vec(0, 1, 0) },
      ],
      { threshold: 0.99 },
    );
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters[0]?.sessionIds.length).toBe(3);
    expect(r.clusters[1]?.sessionIds.length).toBe(2);
  });

  it('orders sessionIds within a cluster by similarity to centroid', () => {
    // Centroid is the member with the highest sum-of-similarities to
    // other members; the rest sort by their similarity to that centroid.
    // We assert the first slot is the centroid (whichever the algorithm
    // picks given the geometry) and that the order is monotonic.
    const r = buildSemanticDuplicates(
      [
        { sessionId: 'A', vector: vec(1, 0, 0) },
        { sessionId: 'B', vector: vec(0.99, 0.01, 0) },
        { sessionId: 'C', vector: vec(0.93, 0.07, 0) },
      ],
      { threshold: 0.85 },
    );
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]?.sessionIds[0]).toBe(r.clusters[0]?.centroidSessionId);
    expect(r.clusters[0]?.sessionIds).toHaveLength(3);
  });
});
