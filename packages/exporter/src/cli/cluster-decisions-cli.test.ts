import { describe, it, expect, vi } from 'vitest';
import { THRESHOLDS } from '@chat-arch/analysis';
import {
  buildClustersFileOrSkip,
  buildDecisionClusters,
  normalizeDecision,
  parseArgs,
  type ClassifiedDecisionInput,
} from './cluster-decisions-cli.js';

function unitVec(values: number[]): Float32Array {
  let sq = 0;
  for (const v of values) sq += v * v;
  const n = Math.sqrt(sq) || 1;
  return Float32Array.from(values.map((v) => v / n));
}

function dec(
  id: string,
  sessionId: string,
  distilledDecision: string,
  binaryClass: ClassifiedDecisionInput['binaryClass'] = null,
  updatedAt?: number,
): ClassifiedDecisionInput {
  return {
    id,
    sessionId,
    distilledDecision,
    binaryClass,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

const OPTS = { clusterThreshold: 0.65, minOccurrences: 2, landedRateMinN: 2 };

describe('normalizeDecision', () => {
  it('lowercases, collapses whitespace, strips trailing punctuation', () => {
    expect(normalizeDecision('Use  Ripgrep instead of grep.')).toBe(
      'use ripgrep instead of grep',
    );
  });
});

describe('buildDecisionClusters', () => {
  it('clusters near-identical decisions across sessions into one pattern', () => {
    const decisions = [
      dec('d1', 'sessA', 'use ripgrep instead of grep', 'good', 100),
      dec('d2', 'sessB', 'switch from grep to ripgrep', 'bad', 300),
    ];
    const vectors = [unitVec([1, 0, 0]), unitVec([1, 0, 0])];
    const out = buildDecisionClusters(decisions, vectors, OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]?.occurrenceCount).toBe(2);
    expect(out[0]?.instanceIds).toEqual(expect.arrayContaining(['d1', 'd2']));
    // Canonical = alphabetically-first distilled text (deterministic).
    expect(out[0]?.canonicalDecision).toBe('switch from grep to ripgrep');
    expect(out[0]?.id).toMatch(/^dpat_[0-9a-f]{12}$/);
    expect(out[0]?.firstSeen).toBe(100);
    expect(out[0]?.lastSeen).toBe(300);
  });

  it('drops clusters below the distinct-session floor', () => {
    // Two identical vectors but SAME session → 1 distinct session < 2.
    const decisions = [
      dec('d1', 'sessA', 'use ripgrep', 'good'),
      dec('d2', 'sessA', 'use ripgrep', 'good'),
    ];
    const vectors = [unitVec([1, 0, 0]), unitVec([1, 0, 0])];
    expect(buildDecisionClusters(decisions, vectors, OPTS)).toHaveLength(0);
  });

  it('keeps distinct decisions in separate clusters (singletons dropped)', () => {
    const decisions = [
      dec('d1', 'sessA', 'use ripgrep'),
      dec('d2', 'sessB', 'drop the staging server'),
    ];
    const vectors = [unitVec([1, 0, 0]), unitVec([0, 1, 0])];
    // Orthogonal → two singleton clusters → both below min-occurrences.
    expect(buildDecisionClusters(decisions, vectors, OPTS)).toHaveLength(0);
  });

  it('computes landedRate over non-neutral members when ≥ minN', () => {
    const decisions = [
      dec('d1', 'sessA', 'use ripgrep', 'good'),
      dec('d2', 'sessB', 'use ripgrep', 'bad'),
    ];
    const vectors = [unitVec([1, 0, 0]), unitVec([1, 0, 0])];
    const out = buildDecisionClusters(decisions, vectors, OPTS);
    expect(out[0]?.landedRate).toBeCloseTo(0.5, 5);
    expect(out[0]?.landedDenom).toBe(2);
  });

  it('returns null landedRate when too few members have a joined outcome', () => {
    const decisions = [
      dec('d1', 'sessA', 'use ripgrep', 'good'),
      dec('d2', 'sessB', 'use ripgrep', null), // unjoined
    ];
    const vectors = [unitVec([1, 0, 0]), unitVec([1, 0, 0])];
    const out = buildDecisionClusters(decisions, vectors, OPTS);
    expect(out[0]?.landedRate).toBeNull();
  });

  it('throws on a vectors/decisions length mismatch', () => {
    expect(() =>
      buildDecisionClusters([dec('d1', 'sessA', 'x')], [], OPTS),
    ).toThrow(/length mismatch/);
  });

  it('returns [] for empty input', () => {
    expect(buildDecisionClusters([], [], OPTS)).toEqual([]);
  });
});

describe('buildClustersFileOrSkip — soft skip on embed failure (issue #122)', () => {
  const FILE_OPTS = {
    clusterThreshold: 0.65,
    minOccurrences: 2,
    landedRateMinN: 2,
    model: 'mxbai-embed-large',
  };

  it('returns a visible skip marker (no throw) when embeddings are unavailable', async () => {
    const embedFn = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });
    const decisions = [
      dec('d1', 'sessA', 'use ripgrep instead of grep'),
      dec('d2', 'sessB', 'switch from grep to ripgrep'),
    ];
    const out = await buildClustersFileOrSkip(decisions, FILE_OPTS, embedFn, 1234);
    expect(out.skipped).toBe(true);
    expect(out.skipReason).toBe('embeddings-unavailable');
    expect(out.clusters).toEqual([]);
    expect(out.generatedAt).toBe(1234);
    expect(embedFn).toHaveBeenCalledOnce();
  });

  it('does NOT mark empty input as skipped (honest empty result, embedFn never called)', async () => {
    const embedFn = vi.fn(async () => [] as Float32Array[]);
    const out = await buildClustersFileOrSkip([], FILE_OPTS, embedFn, 9);
    expect(out.skipped).toBeUndefined();
    expect(out.skipReason).toBeUndefined();
    expect(out.clusters).toEqual([]);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('builds real clusters (no skip marker) when embeddings succeed', async () => {
    const embedFn = vi.fn(async (texts: string[]) =>
      texts.map(() => unitVec([1, 0, 0])),
    );
    const decisions = [
      dec('d1', 'sessA', 'use ripgrep instead of grep', 'good', 100),
      dec('d2', 'sessB', 'switch from grep to ripgrep', 'bad', 300),
    ];
    const out = await buildClustersFileOrSkip(decisions, FILE_OPTS, embedFn, 7);
    expect(out.skipped).toBeUndefined();
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0]?.occurrenceCount).toBe(2);
  });

  it('still throws on a genuine length mismatch from a successful embed (hard-fail)', async () => {
    // embedFn returns the wrong number of vectors — a bug, not an
    // availability problem, so it must NOT be soft-skipped.
    const embedFn = vi.fn(async () => [unitVec([1, 0, 0])]);
    const decisions = [dec('d1', 'sessA', 'a'), dec('d2', 'sessB', 'b')];
    await expect(
      buildClustersFileOrSkip(decisions, FILE_OPTS, embedFn, 1),
    ).rejects.toThrow(/length mismatch/);
  });
});

describe('parseArgs', () => {
  it('requires --classified and --output', () => {
    expect(() => parseArgs(['--classified', 'a.json'])).toThrow();
    expect(() => parseArgs(['--output', 'o.json'])).toThrow();
  });

  it('applies decision-tuned defaults (min-occurrences 2, rate floor = display floor)', () => {
    const a = parseArgs(['--classified', 'a.json', '--output', 'o.json']);
    expect(a.minOccurrences).toBe(2);
    expect(a.clusterThreshold).toBeCloseTo(0.65, 5);
    // landed-rate floor is pinned to the viewer's display floor so a
    // small-n cluster never reports a misleadingly-precise rate.
    expect(a.landedRateMinN).toBe(THRESHOLDS.display.minNForRate);
  });

  it('rejects an out-of-range cluster threshold', () => {
    expect(() =>
      parseArgs(['--classified', 'a.json', '--output', 'o.json', '--cluster-threshold', '2']),
    ).toThrow(/cluster-threshold/);
  });
});
