import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { buildBlogCandidates } from './blogCandidates.js';

function s(
  id: string,
  overrides: Partial<UnifiedSessionEntry> = {},
): UnifiedSessionEntry {
  return {
    id,
    source: 'cowork',
    rawSessionId: id,
    startedAt: Date.parse('2026-05-10T00:00:00Z'),
    updatedAt: Date.parse('2026-05-10T01:00:00Z'),
    durationMs: 3_600_000,
    title: `Title ${id}`,
    titleSource: 'fallback',
    preview: null,
    userTurns: 5,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    discoveryScore: 0.85,
    ...overrides,
  };
}

function vec(dim: number, axis: number): Float32Array {
  const v = new Float32Array(dim);
  v[axis] = 1;
  return v;
}

describe('buildBlogCandidates', () => {
  it('returns empty when too few sessions clear the discovery threshold', () => {
    const r = buildBlogCandidates(
      [s('a', { discoveryScore: 0.5 })],
      new Map([['a', vec(8, 0)]]),
    );
    expect(r.candidates).toEqual([]);
  });

  it('emits a candidate when ≥2 sessions cluster + span ≥3 days', () => {
    const sessions = [
      s('a', { startedAt: Date.parse('2026-05-10T00:00:00Z'), updatedAt: Date.parse('2026-05-10T01:00:00Z') }),
      s('b', { startedAt: Date.parse('2026-05-14T00:00:00Z'), updatedAt: Date.parse('2026-05-14T01:00:00Z') }),
    ];
    const r = buildBlogCandidates(
      sessions,
      new Map([
        ['a', vec(8, 0)],
        ['b', vec(8, 0)],
      ]),
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.clusterSessionIds).toContain('a');
    expect(r.candidates[0]?.clusterSessionIds).toContain('b');
    expect(r.candidates[0]?.spanDays).toBeGreaterThanOrEqual(3);
  });

  it('drops clusters whose span is below the arc threshold', () => {
    const sessions = [
      s('a', { startedAt: 100, updatedAt: 200 }),
      s('b', { startedAt: 300, updatedAt: 400 }),
    ];
    const r = buildBlogCandidates(
      sessions,
      new Map([
        ['a', vec(8, 0)],
        ['b', vec(8, 0)],
      ]),
    );
    expect(r.candidates).toEqual([]);
  });

  it('weights audit pass rate when provided', () => {
    const sessions = [
      s('hi-a', { startedAt: 0, updatedAt: 0 }),
      s('hi-b', { startedAt: 4 * 86_400_000, updatedAt: 4 * 86_400_000 }),
      s('lo-a', { startedAt: 0, updatedAt: 0 }),
      s('lo-b', { startedAt: 4 * 86_400_000, updatedAt: 4 * 86_400_000 }),
    ];
    const embeddings = new Map([
      ['hi-a', vec(8, 0)],
      ['hi-b', vec(8, 0)],
      ['lo-a', vec(8, 1)],
      ['lo-b', vec(8, 1)],
    ]);
    const r = buildBlogCandidates(sessions, embeddings, {
      sessionAuditPassRate: new Map([
        ['hi-a', 0.95],
        ['hi-b', 0.95],
        ['lo-a', 0.1],
        ['lo-b', 0.1],
      ]),
    });
    expect(r.candidates).toHaveLength(2);
    // Highest-pass-rate cluster should rank first.
    expect(r.candidates[0]?.clusterSessionIds).toContain('hi-a');
  });

  it('computes noveltyScore = 1 - max-cosine against references', () => {
    const sessions = [
      s('a', { startedAt: 0, updatedAt: 0 }),
      s('b', { startedAt: 4 * 86_400_000, updatedAt: 4 * 86_400_000 }),
    ];
    const embeddings = new Map([
      ['a', vec(8, 0)],
      ['b', vec(8, 0)],
    ]);
    const refs = [vec(8, 0)]; // Identical to cluster centroid → not novel.
    const r = buildBlogCandidates(sessions, embeddings, {
      noveltyReferenceVectors: refs,
    });
    expect(r.candidates[0]?.noveltyScore).toBeCloseTo(0, 6);
  });
});
