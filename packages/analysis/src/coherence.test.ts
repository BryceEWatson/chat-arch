import { describe, it, expect } from 'vitest';
import { computeCoherence } from './coherence.js';

describe('computeCoherence', () => {
  it('returns empty when the corpus is empty', () => {
    const result = computeCoherence({
      clusterTopTerms: new Map([['~a + b', ['a', 'b']]]),
      allSessionTokens: new Map(),
    });
    expect(result.size).toBe(0);
  });

  it('omits clusters with fewer than 2 top-terms (no pair to score)', () => {
    const result = computeCoherence({
      clusterTopTerms: new Map([
        ['~lonely', ['solo']],
        ['~empty', []],
      ]),
      allSessionTokens: new Map([['s1', ['solo']]]),
    });
    expect(result.size).toBe(0);
  });

  it('gives a higher (less-negative) score when top-terms co-occur frequently', () => {
    // Cluster A: "git" and "commit" always co-occur → high coherence.
    // Cluster B: "alpha" and "omega" never co-occur → low coherence.
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['git', 'commit', 'branch']],
      ['s2', ['git', 'commit', 'merge']],
      ['s3', ['git', 'commit', 'push']],
      ['s4', ['alpha']],
      ['s5', ['omega']],
      ['s6', ['alpha', 'beta']],
      ['s7', ['omega', 'beta']],
    ]);
    const result = computeCoherence({
      clusterTopTerms: new Map([
        ['~A', ['git', 'commit']],
        ['~B', ['alpha', 'omega']],
      ]),
      allSessionTokens,
    });
    const a = result.get('~A');
    const b = result.get('~B');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!).toBeGreaterThan(b!);
  });

  it('is deterministic on identical input', () => {
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['x', 'y', 'z']],
      ['s2', ['x', 'y']],
      ['s3', ['z']],
    ]);
    const topTerms = new Map([['~c', ['x', 'y', 'z']]]);
    const a = computeCoherence({ clusterTopTerms: topTerms, allSessionTokens });
    const b = computeCoherence({ clusterTopTerms: topTerms, allSessionTokens });
    expect(a.get('~c')).toBe(b.get('~c'));
  });
});

describe('computeCoherence (NPMI metric)', () => {
  it('returns empty when the corpus is empty', () => {
    const result = computeCoherence({
      clusterTopTerms: new Map([['~a + b', ['a', 'b']]]),
      allSessionTokens: new Map(),
      metric: 'npmi',
    });
    expect(result.size).toBe(0);
  });

  it('scores in [-1, 1]', () => {
    // Mixed: some pairs co-occur, some don't.
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['git', 'commit', 'branch']],
      ['s2', ['git', 'commit', 'merge']],
      ['s3', ['git', 'commit', 'push']],
      ['s4', ['git', 'commit']],
      ['s5', ['alpha']],
      ['s6', ['omega']],
      ['s7', ['alpha', 'beta']],
      ['s8', ['omega', 'beta']],
    ]);
    const result = computeCoherence({
      clusterTopTerms: new Map([
        ['~git', ['git', 'commit']],
        ['~mixed', ['alpha', 'omega']],
      ]),
      allSessionTokens,
      metric: 'npmi',
    });
    for (const score of result.values()) {
      expect(score).toBeGreaterThanOrEqual(-1);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('floors at -1 when top-terms never co-occur', () => {
    // alpha and omega appear in disjoint sessions — co-df is zero.
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['alpha', 'one']],
      ['s2', ['alpha', 'two']],
      ['s3', ['omega', 'three']],
      ['s4', ['omega', 'four']],
    ]);
    const result = computeCoherence({
      clusterTopTerms: new Map([['~disjoint', ['alpha', 'omega']]]),
      allSessionTokens,
      metric: 'npmi',
    });
    expect(result.get('~disjoint')).toBe(-1);
  });

  it('reaches the upper bound when top-terms always co-occur', () => {
    // git and commit appear in every session — co-df equals corpus size.
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['git', 'commit']],
      ['s2', ['git', 'commit', 'branch']],
      ['s3', ['git', 'commit', 'merge']],
      ['s4', ['git', 'commit', 'push']],
    ]);
    const result = computeCoherence({
      clusterTopTerms: new Map([['~git', ['git', 'commit']]]),
      allSessionTokens,
      metric: 'npmi',
    });
    expect(result.get('~git')).toBe(1);
  });

  it('ranks coherent clusters above incoherent ones', () => {
    // Same fixture as the UMass ranking test — both metrics should
    // agree on the *order* even when their absolute values differ.
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['git', 'commit', 'branch']],
      ['s2', ['git', 'commit', 'merge']],
      ['s3', ['git', 'commit', 'push']],
      ['s4', ['alpha']],
      ['s5', ['omega']],
      ['s6', ['alpha', 'beta']],
      ['s7', ['omega', 'beta']],
    ]);
    const result = computeCoherence({
      clusterTopTerms: new Map([
        ['~A', ['git', 'commit']],
        ['~B', ['alpha', 'omega']],
      ]),
      allSessionTokens,
      metric: 'npmi',
    });
    const a = result.get('~A');
    const b = result.get('~B');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!).toBeGreaterThan(b!);
  });

  it('produces different absolute scores than UMass on the same input', () => {
    // Cheap sanity check that the metric switch is wired and not a no-op.
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['x', 'y']],
      ['s2', ['x', 'y', 'z']],
      ['s3', ['z']],
    ]);
    const topTerms = new Map([['~c', ['x', 'y', 'z']]]);
    const umass = computeCoherence({ clusterTopTerms: topTerms, allSessionTokens });
    const npmi = computeCoherence({
      clusterTopTerms: topTerms,
      allSessionTokens,
      metric: 'npmi',
    });
    expect(umass.get('~c')).not.toBe(npmi.get('~c'));
  });

  it('is deterministic on identical input', () => {
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['x', 'y', 'z']],
      ['s2', ['x', 'y']],
      ['s3', ['z']],
    ]);
    const topTerms = new Map([['~c', ['x', 'y', 'z']]]);
    const a = computeCoherence({
      clusterTopTerms: topTerms,
      allSessionTokens,
      metric: 'npmi',
    });
    const b = computeCoherence({
      clusterTopTerms: topTerms,
      allSessionTokens,
      metric: 'npmi',
    });
    expect(a.get('~c')).toBe(b.get('~c'));
  });
});
