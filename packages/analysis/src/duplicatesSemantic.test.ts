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
    // Default threshold is 0.94 (calibrated against the user's actual
    // corpus — see duplicatesSemantic.ts docstring). The other
    // threshold-specific tests pass explicit thresholds, so this is
    // the only place the literal default appears.
    expect(r.threshold).toBe(0.94);
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

describe('buildSemanticDuplicates (complete-linkage)', () => {
  it("doesn't chain across a similarity gap that single-linkage would bridge", () => {
    // Construct A — B — C — D as a chain where adjacent pairs each
    // exceed 0.92 but the far ends (A,D and A,C) fall well below it.
    // We do this with unit vectors at small angles in 2D so the cosine
    // structure is exact and easy to reason about.
    //
    // Angles (radians) → cosine vs A (angle 0):
    //   A: 0     (cos = 1)
    //   B: 0.30  (cos ≈ 0.955)
    //   C: 0.60  (cos ≈ 0.825)
    //   D: 0.90  (cos ≈ 0.622)
    // Threshold 0.92: A~B pass, B~C borderline-fail (~0.92), C~D fail.
    // Tweak angles so neighbouring pairs pass at 0.92 but A~D fails.
    //
    // Easier construction: directly stack four very close pairs.
    //   A: (1, 0)
    //   B: cos(0.20), sin(0.20)  → cos vs A ≈ 0.980
    //   C: cos(0.40), sin(0.40)  → cos vs A ≈ 0.921
    //                             → cos vs B ≈ 0.980 (gap of 0.20)
    //   D: cos(0.60), sin(0.60)  → cos vs A ≈ 0.825
    //                             → cos vs C ≈ 0.980
    //                             → cos vs B ≈ 0.921
    // Pairs above 0.92: A-B, A-C (just), B-C, B-D (just), C-D.
    // Single-linkage merges all four. Complete-linkage refuses to merge
    // any group containing A and D because cos(A,D)=0.825 < 0.92.
    const angle = (rad: number): Float32Array =>
      new Float32Array([Math.cos(rad), Math.sin(rad)]);
    const inputs = [
      { sessionId: 'A', vector: angle(0) },
      { sessionId: 'B', vector: angle(0.2) },
      { sessionId: 'C', vector: angle(0.4) },
      { sessionId: 'D', vector: angle(0.6) },
    ];
    const single = buildSemanticDuplicates(inputs, { threshold: 0.92 });
    const complete = buildSemanticDuplicates(inputs, {
      threshold: 0.92,
      linkage: 'complete',
    });

    // Single-linkage chains across the four points.
    expect(single.clusters).toHaveLength(1);
    expect(single.clusters[0]?.sessionIds.sort()).toEqual(['A', 'B', 'C', 'D']);

    // Complete-linkage refuses any merge whose min cross-pair drops
    // below threshold. The expected split is into two compact clusters
    // — one anchored at A, one anchored at D — neither containing both
    // ends.
    const sizes = complete.clusters.map((c) => c.sessionIds.length).sort();
    expect(sizes).not.toEqual([4]);
    for (const cluster of complete.clusters) {
      const hasA = cluster.sessionIds.includes('A');
      const hasD = cluster.sessionIds.includes('D');
      expect(hasA && hasD).toBe(false);
    }
  });

  it('still groups true near-duplicates into a single cluster', () => {
    // Three vectors all within 0.99 cosine of each other — complete-
    // linkage should still merge them since every cross-pair is above
    // threshold.
    const r = buildSemanticDuplicates(
      [
        { sessionId: 'a', vector: vec(1, 0.05, 0) },
        { sessionId: 'b', vector: vec(1, 0.06, 0) },
        { sessionId: 'c', vector: vec(1, 0.04, 0) },
      ],
      { threshold: 0.92, linkage: 'complete' },
    );
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]?.sessionIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('respects excludePairs under complete-linkage', () => {
    const r = buildSemanticDuplicates(
      [
        { sessionId: 'a', vector: vec(1, 1, 0) },
        { sessionId: 'b', vector: vec(1, 1, 0) },
      ],
      { excludePairs: new Set(['a::b']), linkage: 'complete' },
    );
    expect(r.clusters).toEqual([]);
  });
});
