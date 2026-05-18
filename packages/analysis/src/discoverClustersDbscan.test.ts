import { describe, it, expect } from 'vitest';
import { discoverClustersDbscan } from './discoverClustersDbscan.js';
import type { ClusterInput } from './discoverClusters.js';

/**
 * Build a unit vector in 2D from a polar angle. Lets us construct test
 * fixtures where cosine distance maps directly onto angular separation:
 *   cos(θ_a − θ_b) is the cosine similarity of the two unit vectors.
 * That makes the test failure modes easy to read: a 0.5 threshold cuts
 * at ~60° separation.
 */
function angle(rad: number, id: string, tokens: string[] = ['t']): ClusterInput {
  return {
    id,
    vector: new Float32Array([Math.cos(rad), Math.sin(rad)]),
    tokens,
  };
}

describe('discoverClustersDbscan', () => {
  it('returns no clusters and empty noise when given no input', () => {
    const r = discoverClustersDbscan([]);
    expect(r.clusters).toEqual([]);
    expect(r.noiseIds).toEqual([]);
  });

  it('groups a dense neighborhood into one cluster and flags isolated points as noise', () => {
    // Three vectors within ~10° of each other (cosine ≥ 0.98) → one
    // cluster. Two outliers at 90° and 180° → noise. The labeler should
    // pick distinctive tokens per cluster.
    const docs: ClusterInput[] = [
      angle(0.00, 'a', ['git', 'commit']),
      angle(0.05, 'b', ['git', 'commit', 'merge']),
      angle(0.10, 'c', ['git', 'commit', 'push']),
      angle(Math.PI / 2, 'outlier-1', ['ocean']),
      angle(Math.PI, 'outlier-2', ['kitchen']),
    ];
    const r = discoverClustersDbscan(docs, { epsCosine: 0.9, minPoints: 3 });
    expect(r.clusters).toHaveLength(1);
    const cluster = r.clusters[0]!;
    expect(cluster.memberIds.sort()).toEqual(['a', 'b', 'c']);
    // Tokens with highest IDF (rarest in corpus) should win; 'commit' +
    // 'git' both appear in all 3 in-cluster docs — at minimum the label
    // should be non-empty and reference one of them.
    expect(cluster.labelTerms.length).toBeGreaterThan(0);
    expect(cluster.label.length).toBeGreaterThan(0);
    expect(r.noiseIds.sort()).toEqual(['outlier-1', 'outlier-2']);
  });

  it('discards clusters smaller than minPoints', () => {
    // A "cluster" of 2 members at minPoints=3 should be discarded.
    const docs: ClusterInput[] = [
      angle(0.0, 'a', ['x']),
      angle(0.05, 'b', ['x']),
      angle(Math.PI / 2, 'c', ['y']),
    ];
    const r = discoverClustersDbscan(docs, { epsCosine: 0.9, minPoints: 3 });
    expect(r.clusters).toEqual([]);
  });

  it('sorts clusters by descending size', () => {
    // Three sessions near angle 0 (big), two sessions near angle π/2 (small).
    const docs: ClusterInput[] = [
      angle(0.0, 'a1', ['x']),
      angle(0.05, 'a2', ['x']),
      angle(0.1, 'a3', ['x']),
      angle(0.15, 'a4', ['x']),
      angle(Math.PI / 2, 'b1', ['y']),
      angle(Math.PI / 2 + 0.05, 'b2', ['y']),
      angle(Math.PI / 2 + 0.1, 'b3', ['y']),
    ];
    const r = discoverClustersDbscan(docs, { epsCosine: 0.9, minPoints: 3 });
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters[0]!.memberIds.length).toBeGreaterThanOrEqual(
      r.clusters[1]!.memberIds.length,
    );
  });

  it('records the cosine threshold on output clusters (not the internal squared-euclidean)', () => {
    const docs: ClusterInput[] = [
      angle(0.0, 'a', ['x']),
      angle(0.05, 'b', ['x']),
      angle(0.1, 'c', ['x']),
    ];
    const r = discoverClustersDbscan(docs, { epsCosine: 0.85, minPoints: 3 });
    expect(r.clusters[0]?.threshold).toBe(0.85);
  });

  it('respects labelStrategy="centroid-title"', () => {
    const docs: ClusterInput[] = [
      { ...angle(0.0, 'hub', ['git']), text: 'centroid hub session' },
      { ...angle(0.03, 'spoke1', ['git']), text: 'spoke 1' },
      { ...angle(0.05, 'spoke2', ['git']), text: 'spoke 2' },
    ];
    const r = discoverClustersDbscan(docs, {
      epsCosine: 0.95,
      minPoints: 3,
      labelStrategy: 'centroid-title',
    });
    expect(r.clusters).toHaveLength(1);
    // The centroid member is whoever sits closest to the mean. With three
    // points at angles 0, 0.03, 0.05 the centroid is near 0.027, so
    // either 'hub' (closest at 0) or 'spoke1' (at 0.03) wins. Either way
    // the label is the member's TEXT, not a token bag.
    const label = r.clusters[0]!.label;
    expect(label.startsWith('centroid hub') || label.startsWith('spoke')).toBe(true);
    expect(label.includes('+')).toBe(false); // not the TF-IDF tag-bag shape
  });

  it('passes through all-noise input (all sessions far apart)', () => {
    const docs: ClusterInput[] = [
      angle(0.0, 'a', ['x']),
      angle(Math.PI / 3, 'b', ['y']),
      angle((2 * Math.PI) / 3, 'c', ['z']),
      angle(Math.PI, 'd', ['w']),
    ];
    const r = discoverClustersDbscan(docs, { epsCosine: 0.9, minPoints: 2 });
    expect(r.clusters).toEqual([]);
    expect(r.noiseIds.sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
