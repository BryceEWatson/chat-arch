// Tests for the Phase Rev3-F F3 curator ranker kernel.

import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from './thresholds.js';
import {
  rankCuratorCandidates,
  type CuratorCandidate,
} from './curatorRanker.js';

function candidate(
  id: string,
  overrides: Partial<CuratorCandidate> = {},
): CuratorCandidate {
  return {
    kind: 'narrative',
    entityId: id,
    title: `Title ${id}`,
    tierScore: 1,
    confidence: 0.5,
    recencyScore: 0.5,
    correlationScore: 0,
    ...overrides,
  };
}

describe('rankCuratorCandidates', () => {
  describe('basic ranking', () => {
    it('returns empty array for empty input', () => {
      expect(rankCuratorCandidates([])).toEqual([]);
    });

    it('respects topK', () => {
      const cands = Array.from({ length: 20 }, (_, i) => candidate(`c${i}`));
      const result = rankCuratorCandidates(cands, { topK: 5 });
      expect(result.length).toBe(5);
    });

    it('defaults topK to precisionAtKWindow when omitted', () => {
      const cands = Array.from({ length: 20 }, (_, i) => candidate(`c${i}`));
      const result = rankCuratorCandidates(cands);
      expect(result.length).toBe(THRESHOLDS.curator.precisionAtKWindow);
    });

    it('assigns 1-indexed rank in returned order', () => {
      const cands = [
        candidate('high', { confidence: 0.9 }),
        candidate('mid', { confidence: 0.6 }),
        candidate('low', { confidence: 0.3 }),
      ];
      const result = rankCuratorCandidates(cands);
      expect(result[0]!.entityId).toBe('high');
      expect(result[0]!.rank).toBe(1);
      expect(result[1]!.entityId).toBe('mid');
      expect(result[1]!.rank).toBe(2);
      expect(result[2]!.entityId).toBe('low');
      expect(result[2]!.rank).toBe(3);
    });
  });

  describe('cross-tier precedence (load-bearing — no promotion via correlation)', () => {
    it('tier-3 ALWAYS beats tier-2 even when tier-2 has higher confidence + correlation', () => {
      const t3Weak = candidate('t3-weak', {
        tierScore: 1, // tier-3
        confidence: 0.5,
        recencyScore: 0.5,
        correlationScore: 0,
      });
      const t2Strong = candidate('t2-strong', {
        tierScore: 0.5, // tier-2
        confidence: 0.99,
        recencyScore: 0.99,
        correlationScore: 1, // maxed correlation
      });
      const result = rankCuratorCandidates([t2Strong, t3Weak]);
      expect(result[0]!.entityId).toBe('t3-weak');
      expect(result[1]!.entityId).toBe('t2-strong');
    });

    it('tier-1 candidates rank below tier-2 even with high scores (defensive — they should not be in the input)', () => {
      const t1 = candidate('t1', {
        tierScore: 0, // tier-1 — should have been filtered upstream
        confidence: 0.95,
        recencyScore: 0.95,
      });
      const t2 = candidate('t2', {
        tierScore: 0.5,
        confidence: 0.3,
        recencyScore: 0.3,
      });
      const result = rankCuratorCandidates([t1, t2]);
      expect(result[0]!.entityId).toBe('t2');
      expect(result[1]!.entityId).toBe('t1');
    });
  });

  describe('within-tier composite (confidence > recency)', () => {
    it('higher confidence beats higher recency at same tier', () => {
      const highConf = candidate('hc', {
        tierScore: 1,
        confidence: 0.9,
        recencyScore: 0.1,
      });
      const highRecency = candidate('hr', {
        tierScore: 1,
        confidence: 0.1,
        recencyScore: 0.9,
      });
      // Composite = 0.6*conf + 0.4*recency.
      // highConf  = 0.6*0.9 + 0.4*0.1 = 0.58
      // highRecency = 0.6*0.1 + 0.4*0.9 = 0.42
      const result = rankCuratorCandidates([highRecency, highConf]);
      expect(result[0]!.entityId).toBe('hc');
    });

    it('exposes the within-tier composite on the ranked output', () => {
      const c = candidate('x', {
        tierScore: 1,
        confidence: 0.5,
        recencyScore: 0.5,
      });
      const result = rankCuratorCandidates([c]);
      expect(result[0]!.compositeScore).toBe(0.5);
    });
  });

  describe('correlation as within-tier tie-breaker only', () => {
    it('breaks ties within a tier when composite is equal', () => {
      const a = candidate('a', {
        tierScore: 1,
        confidence: 0.5,
        recencyScore: 0.5,
        correlationScore: 0.3,
      });
      const b = candidate('b', {
        tierScore: 1,
        confidence: 0.5,
        recencyScore: 0.5,
        correlationScore: 0.7,
      });
      const result = rankCuratorCandidates([a, b]);
      // b has higher correlation → wins the tie.
      expect(result[0]!.entityId).toBe('b');
    });

    it('does NOT override composite even when correlation is maxed', () => {
      const winnerByComposite = candidate('wc', {
        tierScore: 1,
        confidence: 0.9,
        recencyScore: 0.9,
        correlationScore: 0,
      });
      const loserWithMaxCorrelation = candidate('lw', {
        tierScore: 1,
        confidence: 0.4,
        recencyScore: 0.4,
        correlationScore: 1,
      });
      const result = rankCuratorCandidates([
        loserWithMaxCorrelation,
        winnerByComposite,
      ]);
      expect(result[0]!.entityId).toBe('wc');
    });
  });

  describe('defensive contract', () => {
    it('clamps out-of-range scores to [0, 1]', () => {
      const dirty = candidate('dirty', {
        tierScore: 1.5,
        confidence: -0.3,
        recencyScore: 99,
        correlationScore: -1,
      });
      const result = rankCuratorCandidates([dirty]);
      expect(result[0]!.tierScore).toBe(1);
      expect(result[0]!.confidence).toBe(0);
      expect(result[0]!.recencyScore).toBe(1);
      expect(result[0]!.correlationScore).toBe(0);
    });

    it('treats non-finite scores as 0', () => {
      const nan = candidate('nan', {
        confidence: Number.NaN,
        recencyScore: Number.POSITIVE_INFINITY,
      });
      const result = rankCuratorCandidates([nan]);
      expect(result[0]!.confidence).toBe(0);
      expect(result[0]!.recencyScore).toBe(0);
    });
  });

  describe('stability on full ties', () => {
    it('preserves original input order when every score is identical', () => {
      const a = candidate('a');
      const b = candidate('b');
      const c = candidate('c');
      const result = rankCuratorCandidates([a, b, c]);
      expect(result.map((r) => r.entityId)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('mixed-kind ranking', () => {
    it('ranks across narrative / knowledge-debt / applied-pattern uniformly', () => {
      const narr = candidate('narr', {
        kind: 'narrative',
        tierScore: 1,
        confidence: 0.5,
      });
      const kd = candidate('kd', {
        kind: 'knowledge-debt',
        tierScore: 1,
        confidence: 0.7,
      });
      const ap = candidate('ap', {
        kind: 'applied-pattern',
        tierScore: 1,
        confidence: 0.3,
      });
      const result = rankCuratorCandidates([narr, kd, ap]);
      expect(result.map((r) => r.kind)).toEqual([
        'knowledge-debt',
        'narrative',
        'applied-pattern',
      ]);
    });
  });
});
