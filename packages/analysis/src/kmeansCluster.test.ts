import { describe, it, expect } from 'vitest';
import { kmeansCluster } from './kmeansCluster.js';

describe('kmeansCluster', () => {
  it('returns empty when given no inputs', () => {
    const result = kmeansCluster([], { k: 3, seed: 42 });
    expect(result).toEqual([]);
  });

  it('returns empty when k is 0', () => {
    const inputs = [
      { id: 's1', vector: [0, 0], tokens: ['a'] },
      { id: 's2', vector: [1, 1], tokens: ['b'] },
    ];
    const result = kmeansCluster(inputs, { k: 0, seed: 42 });
    expect(result).toEqual([]);
  });

  it('groups clearly-separated points into distinct clusters', () => {
    // Two obvious groups around (0,0) and (10,10).
    const inputs = [
      { id: 'a1', vector: [0.0, 0.1], tokens: ['alpha', 'origin'] },
      { id: 'a2', vector: [0.1, 0.0], tokens: ['alpha', 'origin'] },
      { id: 'a3', vector: [0.2, 0.1], tokens: ['alpha', 'near'] },
      { id: 'b1', vector: [10.0, 10.1], tokens: ['beta', 'far'] },
      { id: 'b2', vector: [10.1, 10.0], tokens: ['beta', 'far'] },
      { id: 'b3', vector: [10.2, 10.1], tokens: ['beta', 'elsewhere'] },
    ];
    const clusters = kmeansCluster(inputs, { k: 2, seed: 1, minSize: 2 });
    expect(clusters.length).toBe(2);
    const [a, b] = clusters.map((c) => new Set(c.memberIds));
    // Alpha-group members are all in the same cluster; beta-group members in the other.
    const alphaSet = new Set(['a1', 'a2', 'a3']);
    const aIsAlpha = [...(a ?? [])].every((id) => alphaSet.has(id));
    const bIsAlpha = [...(b ?? [])].every((id) => alphaSet.has(id));
    expect(aIsAlpha !== bIsAlpha).toBe(true);
  });

  it('is deterministic given the same seed', () => {
    const inputs = [
      { id: 's1', vector: [0, 0], tokens: ['x'] },
      { id: 's2', vector: [5, 5], tokens: ['y'] },
      { id: 's3', vector: [0.1, 0.1], tokens: ['x'] },
      { id: 's4', vector: [5.1, 5.1], tokens: ['y'] },
    ];
    const a = kmeansCluster(inputs, { k: 2, seed: 42 });
    const b = kmeansCluster(inputs, { k: 2, seed: 42 });
    const aKeys = a.map((c) => c.memberIds.slice().sort().join(',')).sort();
    const bKeys = b.map((c) => c.memberIds.slice().sort().join(',')).sort();
    expect(aKeys).toEqual(bKeys);
  });

  it('drops clusters below minSize', () => {
    const inputs = [
      { id: 'a1', vector: [0, 0], tokens: ['a'] },
      { id: 'a2', vector: [0.1, 0.1], tokens: ['a'] },
      { id: 'a3', vector: [0.2, 0.2], tokens: ['a'] },
      { id: 'lone', vector: [100, 100], tokens: ['lone'] },
    ];
    const clusters = kmeansCluster(inputs, { k: 2, seed: 7, minSize: 2 });
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.memberIds).not.toContain('lone');
  });
});
