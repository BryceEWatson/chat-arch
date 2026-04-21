import { describe, it, expect } from 'vitest';
import {
  classifyBatch,
  classifyOne,
  cosineSimilarityNormalized,
  type Embedding,
  type ProjectCentroid,
} from './classifyByEmbedding.js';

/**
 * Helper: build a unit vector pointing along one of the basis directions
 * in a 3-dim space so tests can reason about similarity intuitively
 * without having to memorize actual MiniLM outputs. Real deployments use
 * 384-dim MiniLM vectors; the math is identical.
 */
function basis(idx: 0 | 1 | 2): Embedding {
  const v = new Float32Array(3);
  v[idx] = 1;
  return v;
}

function mix(a: Embedding, b: Embedding, wa: number, wb: number): Embedding {
  // Produce a (not necessarily normalized) linear combination. Tests below
  // renormalize when they need a proper unit vector.
  const v = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    v[i] = wa * (a[i] as number) + wb * (b[i] as number);
  }
  return v;
}

function normalize(v: Embedding): Embedding {
  let sq = 0;
  for (const x of v) sq += x * x;
  const n = Math.sqrt(sq);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] as number) / n;
  return out;
}

describe('cosineSimilarityNormalized', () => {
  it('returns 1 for identical unit vectors', () => {
    const a = basis(0);
    expect(cosineSimilarityNormalized(a, a)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal unit vectors', () => {
    expect(cosineSimilarityNormalized(basis(0), basis(1))).toBe(0);
  });

  it('matches sin/cos of the angle between unit vectors', () => {
    // 45° between two basis directions → cos(45°) ≈ 0.707
    const v = normalize(mix(basis(0), basis(1), 1, 1));
    expect(cosineSimilarityNormalized(basis(0), v)).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

describe('classifyOne', () => {
  const centroids: ProjectCentroid[] = [
    { id: 'alpha', vector: basis(0) },
    { id: 'beta', vector: basis(1) },
    { id: 'gamma', vector: basis(2) },
  ];

  it('assigns a document to the nearest centroid when above threshold', () => {
    const r = classifyOne(basis(1), centroids, { threshold: 0.5, margin: 0 });
    expect(r.projectId).toBe('beta');
    expect(r.similarity).toBeCloseTo(1, 6);
    expect(r.runnerUpSimilarity).toBeCloseTo(0, 6);
  });

  it('returns null when the best similarity is below threshold', () => {
    // Document orthogonal to every centroid — similarity is 0 everywhere.
    const orphan = new Float32Array([0, 0, 0]);
    const r = classifyOne(orphan, centroids, { threshold: 0.1, margin: 0 });
    expect(r.projectId).toBeNull();
  });

  it('abstains when top match is within margin of runner-up (ambiguous)', () => {
    // 45°-between-alpha-and-beta — equidistant from both.
    const ambig = normalize(mix(basis(0), basis(1), 1, 1));
    const r = classifyOne(ambig, centroids, { threshold: 0.5, margin: 0.05 });
    // Both hit ~0.707; margin = 0 < 0.05, so we abstain.
    expect(r.projectId).toBeNull();
    // But similarity is still reported for audit.
    expect(r.similarity).toBeCloseTo(Math.SQRT1_2, 3);
    expect(r.runnerUpSimilarity).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it('assigns when margin is comfortable', () => {
    // Mostly-alpha with a little beta — top wins clearly.
    const mostlyAlpha = normalize(mix(basis(0), basis(1), 3, 1));
    const r = classifyOne(mostlyAlpha, centroids, { threshold: 0.5, margin: 0.1 });
    expect(r.projectId).toBe('alpha');
  });

  it('uses default threshold (0.4) when omitted', () => {
    // Similarity 0.5 — above the 0.4 default.
    const v = normalize(mix(basis(0), basis(1), 1, 0.5));
    const r = classifyOne(v, centroids);
    expect(r.projectId).toBe('alpha');
  });

  it('returns null when centroids list is empty', () => {
    const r = classifyOne(basis(0), [], {});
    expect(r.projectId).toBeNull();
    expect(Number.isFinite(r.similarity)).toBe(true);
  });
});

describe('classifyBatch', () => {
  const centroids: ProjectCentroid[] = [
    { id: 'alpha', vector: basis(0) },
    { id: 'beta', vector: basis(1) },
  ];

  it('preserves index alignment with input docs', () => {
    const docs = [basis(0), basis(1), basis(2)];
    const results = classifyBatch(docs, centroids, { threshold: 0.5, margin: 0 });
    expect(results.map((r) => r.projectId)).toEqual(['alpha', 'beta', null]);
  });

  it('handles empty input', () => {
    expect(classifyBatch([], centroids)).toEqual([]);
  });
});
