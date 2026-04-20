import { describe, it, expect } from 'vitest';
import {
  discoverClusters,
  pickDistinctiveTerms,
  type ClusterInput,
  type Embedding,
} from './discoverClusters.js';

/**
 * Build a unit vector in 3-D so the tests read like geometry rather than
 * ML implementation. MiniLM would produce 384-D vectors in production;
 * the clustering math is dimension-independent.
 */
function basis(idx: 0 | 1 | 2): Embedding {
  const v = new Float32Array(3);
  v[idx] = 1;
  return v;
}

function mix(...components: Array<[0 | 1 | 2, number]>): Embedding {
  const v = new Float32Array(3);
  for (const [axis, w] of components) {
    v[axis] = (v[axis] ?? 0) + w;
  }
  let sq = 0;
  for (const x of v) sq += x * x;
  const n = Math.sqrt(sq);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] as number) / n;
  return out;
}

function doc(id: string, vector: Embedding, tokens: string[]): ClusterInput {
  return { id, vector, tokens };
}

describe('discoverClusters', () => {
  it('returns no clusters below minSize', () => {
    // Two near-identical docs, but minSize=3 → nothing surfaced.
    const docs = [
      doc('a', basis(0), ['foo', 'bar']),
      doc('b', basis(0), ['foo', 'bar']),
    ];
    const out = discoverClusters(docs, { threshold: 0.9, minSize: 3 });
    expect(out).toEqual([]);
  });

  it('groups near-identical documents into a single cluster with TF-IDF label', () => {
    // Four docs along basis(0) with a distinctive shared term "jwt",
    // plus three orthogonal docs with unrelated tokens.
    const docs = [
      doc('a', basis(0), ['jwt', 'auth', 'token']),
      doc('b', basis(0), ['jwt', 'auth', 'refresh']),
      doc('c', basis(0), ['jwt', 'middleware']),
      doc('d', basis(1), ['paint', 'canvas']),
      doc('e', basis(1), ['paint', 'brush']),
      doc('f', basis(2), ['migration', 'postgres']),
    ];
    const out = discoverClusters(docs, { threshold: 0.9, minSize: 3 });
    // Only the 'jwt' cluster is big enough to surface.
    expect(out).toHaveLength(1);
    expect(out[0]!.memberIds.sort()).toEqual(['a', 'b', 'c']);
    // `jwt` appears in 3 of 6 docs → high IDF weight; should lead the label.
    expect(out[0]!.labelTerms).toContain('jwt');
  });

  it('complete-linkage resists the single-linkage chain effect', () => {
    // Four docs arranged so a chain of pairwise matches exists BUT
    // the endpoints are far apart:
    //   a ~ b (sim 0.95), b ~ c (sim 0.95), c ~ d (sim 0.95),
    //   but a ~ d (sim 0.4) — below threshold.
    //
    // Complete-linkage MUST NOT merge all four into one cluster,
    // because the a-d pair violates the min-pairwise constraint.
    // Single-linkage would gleefully chain them. This is the whole
    // reason we chose complete-linkage on real data.
    function tilted(axis: 0 | 1 | 2, t: number): Embedding {
      // Unit vector mostly along `axis`, slightly rotated toward axis+1.
      const nextAxis = ((axis + 1) % 3) as 0 | 1 | 2;
      return mix([axis, 1 - t], [nextAxis, t]);
    }
    const docs = [
      doc('a', tilted(0, 0.0), ['alpha']),
      doc('b', tilted(0, 0.3), ['beta']),
      doc('c', tilted(0, 0.6), ['gamma']),
      doc('d', tilted(0, 0.9), ['delta']),
    ];
    const out = discoverClusters(docs, { threshold: 0.8, minSize: 2 });
    // We should NOT see one 4-member cluster. Either smaller clusters
    // form (if pairwise sim is high enough) or none do.
    for (const c of out) {
      expect(c.memberIds.length).toBeLessThan(4);
    }
  });

  it('produces deterministic cluster ids across re-runs on the same input', () => {
    const docs = [
      doc('a', basis(0), ['one', 'two']),
      doc('b', basis(0), ['one', 'three']),
      doc('c', basis(0), ['one', 'four']),
    ];
    const a = discoverClusters(docs, { threshold: 0.9, minSize: 3 });
    const b = discoverClusters(docs, { threshold: 0.9, minSize: 3 });
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('sorts output by cluster size desc', () => {
    // Big cluster (4 docs) + small cluster (3 docs).
    const docs = [
      doc('a1', basis(0), ['x']),
      doc('a2', basis(0), ['x']),
      doc('a3', basis(0), ['x']),
      doc('a4', basis(0), ['x']),
      doc('b1', basis(1), ['y']),
      doc('b2', basis(1), ['y']),
      doc('b3', basis(1), ['y']),
    ];
    const out = discoverClusters(docs, { threshold: 0.9, minSize: 3 });
    expect(out.map((c) => c.memberIds.length)).toEqual([4, 3]);
  });

  it('handles empty input', () => {
    expect(discoverClusters([])).toEqual([]);
  });
});

describe('pickDistinctiveTerms (TF-IDF weighting)', () => {
  it('ranks rare-in-corpus tokens above common ones', () => {
    const corpusSize = 100;
    // "jwt" appears in 3 of 100 docs; "the" appears in 95 of 100.
    const df = new Map<string, number>([
      ['jwt', 3],
      ['the', 95],
      ['auth', 5],
    ]);
    // Three cluster members all carry both tokens.
    const memberTokens: Set<string>[] = [
      new Set(['jwt', 'the', 'auth']),
      new Set(['jwt', 'the']),
      new Set(['jwt', 'auth']),
    ];
    const terms = pickDistinctiveTerms(memberTokens, df, corpusSize, 2);
    // "jwt" (rarest) and "auth" (second rarest) win over "the".
    expect(terms).toContain('jwt');
    expect(terms).toContain('auth');
    expect(terms).not.toContain('the');
  });
});
