import { describe, it, expect } from 'vitest';
import { reduceOutliers } from './reduceOutliers.js';

describe('reduceOutliers', () => {
  it('returns empty when there are no unlabeled sessions', () => {
    const labels = new Map([
      ['s1', { projectId: 'ProjectA', similarity: 0.9 }],
      ['s2', { projectId: '~git + commit + review', similarity: 0.7 }],
    ]);
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['alpha', 'beta']],
      ['s2', ['git', 'commit']],
    ]);
    const clusterTokens = new Map<string, readonly string[]>([
      ['~git + commit + review', ['git', 'commit', 'review']],
    ]);
    const result = reduceOutliers({ labels, allSessionTokens, clusterTokens });
    expect(result.size).toBe(0);
  });

  it('returns empty when no clusters were formed', () => {
    const labels = new Map([
      ['s1', { projectId: null, similarity: 0 }],
      ['s2', { projectId: null, similarity: 0 }],
    ]);
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['alpha', 'beta']],
      ['s2', ['gamma']],
    ]);
    const clusterTokens = new Map<string, readonly string[]>();
    const result = reduceOutliers({ labels, allSessionTokens, clusterTokens });
    expect(result.size).toBe(0);
  });

  it('assigns unlabeled sessions above threshold to their best cluster', () => {
    // Outlier s-outlier has heavy overlap with the ~git cluster; other
    // clusters share nothing. Corpus IDF pushes `git`, `commit` higher
    // than the single-doc `alpha`/`beta` noise.
    const labels = new Map([
      ['s1', { projectId: '~git + commit + review', similarity: 0.7 }],
      ['s2', { projectId: '~git + commit + review', similarity: 0.7 }],
      ['s3', { projectId: '~docker + compose + deploy', similarity: 0.7 }],
      ['s4', { projectId: '~docker + compose + deploy', similarity: 0.7 }],
      ['s-outlier', { projectId: null, similarity: 0.1 }],
    ]);
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['git', 'commit', 'review']],
      ['s2', ['git', 'commit', 'merge']],
      ['s3', ['docker', 'compose']],
      ['s4', ['docker', 'deploy']],
      ['s-outlier', ['git', 'commit']],
    ]);
    const clusterTokens = new Map<string, readonly string[]>([
      ['~git + commit + review', ['git', 'commit', 'review', 'git', 'commit', 'merge']],
      ['~docker + compose + deploy', ['docker', 'compose', 'docker', 'deploy']],
    ]);
    const result = reduceOutliers({
      labels,
      allSessionTokens,
      clusterTokens,
      threshold: 0.1,
    });
    expect(result.get('s-outlier')).toBeDefined();
    expect(result.get('s-outlier')?.projectId).toBe('~git + commit + review');
    expect(result.get('s-outlier')?.similarity).toBeGreaterThanOrEqual(0.1);
  });

  it('leaves sessions unlabeled when no cluster clears the threshold', () => {
    // Outlier shares no tokens with any cluster.
    const labels = new Map([
      ['s1', { projectId: '~alpha + beta + gamma', similarity: 0.7 }],
      ['s2', { projectId: '~alpha + beta + gamma', similarity: 0.7 }],
      ['s-outlier', { projectId: null, similarity: 0 }],
    ]);
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['alpha', 'beta']],
      ['s2', ['alpha', 'gamma']],
      ['s-outlier', ['zebra', 'yak']],
    ]);
    const clusterTokens = new Map<string, readonly string[]>([
      ['~alpha + beta + gamma', ['alpha', 'beta', 'alpha', 'gamma']],
    ]);
    const result = reduceOutliers({
      labels,
      allSessionTokens,
      clusterTokens,
      threshold: 0.3,
    });
    expect(result.size).toBe(0);
  });

  it('skips sessions with zero tokens without crashing', () => {
    const labels = new Map([
      ['s1', { projectId: '~git + commit + review', similarity: 0.7 }],
      ['s-empty', { projectId: null, similarity: 0 }],
    ]);
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['git', 'commit']],
      ['s-empty', []],
    ]);
    const clusterTokens = new Map<string, readonly string[]>([
      ['~git + commit + review', ['git', 'commit']],
    ]);
    const result = reduceOutliers({ labels, allSessionTokens, clusterTokens });
    expect(result.has('s-empty')).toBe(false);
  });

  it('handles a session whose only tokens all appear in every document (zero IDF)', () => {
    // Every session contains `the` and `and`. IDF(the) = IDF(and) = log(N/N) = 0.
    // The outlier's vector is all-zero → skipped, stays unlabeled.
    const labels = new Map([
      ['s1', { projectId: '~cluster + a', similarity: 0.7 }],
      ['s2', { projectId: '~cluster + a', similarity: 0.7 }],
      ['s-outlier', { projectId: null, similarity: 0 }],
    ]);
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['the', 'and', 'specific-a']],
      ['s2', ['the', 'and', 'specific-b']],
      ['s-outlier', ['the', 'and']],
    ]);
    const clusterTokens = new Map<string, readonly string[]>([
      ['~cluster + a', ['the', 'and', 'specific-a', 'the', 'and', 'specific-b']],
    ]);
    const result = reduceOutliers({ labels, allSessionTokens, clusterTokens });
    expect(result.size).toBe(0);
  });

  it('does not override existing non-null labels even on accidental call', () => {
    // The function only considers projectId === null candidates, so
    // labeled sessions should never appear in the result even if their
    // tokens match another cluster strongly.
    const labels = new Map([
      ['s1', { projectId: 'ExistingProject', similarity: 0.9 }],
      ['s2', { projectId: '~cluster + shared', similarity: 0.7 }],
    ]);
    const allSessionTokens = new Map<string, readonly string[]>([
      ['s1', ['shared', 'token']],
      ['s2', ['shared', 'cluster']],
    ]);
    const clusterTokens = new Map<string, readonly string[]>([
      ['~cluster + shared', ['shared', 'cluster', 'shared', 'token']],
    ]);
    const result = reduceOutliers({
      labels,
      allSessionTokens,
      clusterTokens,
      threshold: 0.01,
    });
    expect(result.has('s1')).toBe(false);
    expect(result.has('s2')).toBe(false);
  });
});
