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
