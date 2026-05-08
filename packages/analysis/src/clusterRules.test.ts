import { describe, it, expect } from 'vitest';
import { clusterByThreshold } from './clusterRules.js';

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

function unitVec(values: number[]): Float32Array {
  let sq = 0;
  for (const v of values) sq += v * v;
  const n = Math.sqrt(sq) || 1;
  return Float32Array.from(values.map((v) => v / n));
}

describe('clusterByThreshold', () => {
  it('returns empty for empty input', () => {
    expect(clusterByThreshold([], 0.5)).toEqual([]);
  });

  it('returns [0] for a single vector', () => {
    expect(clusterByThreshold([vec([1, 0, 0])], 0.5)).toEqual([0]);
  });

  it('keeps low-similarity points isolated', () => {
    const vectors = [
      unitVec([1, 0, 0]),
      unitVec([0, 1, 0]),
      unitVec([0, 0, 1]),
    ];
    const result = clusterByThreshold(vectors, 0.5);
    // All pairwise similarities are 0 < 0.5; expect three distinct clusters.
    const unique = new Set(result);
    expect(unique.size).toBe(3);
    expect(result).toEqual([0, 1, 2]);
  });

  it('merges all-similar points into one cluster', () => {
    const vectors = [
      unitVec([1, 0.01, 0]),
      unitVec([1, 0.02, 0]),
      unitVec([1, 0, 0.01]),
      unitVec([1, 0.005, 0.005]),
    ];
    const result = clusterByThreshold(vectors, 0.9);
    expect(new Set(result).size).toBe(1);
    expect(result).toEqual([0, 0, 0, 0]);
  });

  it('separates two distinct groups', () => {
    const vectors = [
      unitVec([1, 0.01, 0]),
      unitVec([1, 0, 0.02]),
      unitVec([0, 1, 0.01]),
      unitVec([0.01, 1, 0]),
    ];
    const result = clusterByThreshold(vectors, 0.9);
    expect(new Set(result).size).toBe(2);
    // First two share a cluster, last two share a cluster.
    expect(result[0]).toBe(result[1]);
    expect(result[2]).toBe(result[3]);
    expect(result[0]).not.toBe(result[2]);
    // Dense, 0-indexed.
    expect(result[0]).toBe(0);
    expect(result[2]).toBe(1);
  });

  it('treats similarity exactly at threshold as a merge', () => {
    // Two vectors with a known integer-arithmetic cosine similarity.
    // Use values that store exactly in Float32 so the cosine equals
    // the threshold to within representable precision.
    const a = vec([1, 0]);
    const b = vec([1, 0]);
    // sim = 1 exactly. Threshold = 1 should still merge.
    expect(clusterByThreshold([a, b], 1)).toEqual([0, 0]);

    // And a non-degenerate case: vectors differ but the similarity
    // matches the threshold exactly.
    const c = vec([2, 0]);
    const d = vec([1, 0]);
    expect(clusterByThreshold([c, d], 1)).toEqual([0, 0]);
  });

  it('chains via single-linkage: A-B + B-C merge even when A-C is below threshold', () => {
    // A-B sim ~0.95, B-C sim ~0.95, A-C sim ~0.80. Threshold 0.9 should
    // still merge all three because B bridges them.
    const a = unitVec([1, 0]);
    const b = unitVec([Math.cos(Math.PI / 12), Math.sin(Math.PI / 12)]); // 15deg
    const c = unitVec([Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]); // 30deg

    const simAC = a[0]! * c[0]! + a[1]! * c[1]!;
    expect(simAC).toBeLessThan(0.9);

    const result = clusterByThreshold([a, b, c], 0.9);
    expect(new Set(result).size).toBe(1);
    expect(result).toEqual([0, 0, 0]);
  });
});
