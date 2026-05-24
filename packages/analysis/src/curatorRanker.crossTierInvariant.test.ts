// Phase Rev3-G G4 — discoverable cross-ref test for the curator
// ranker's "no cross-tier promotion via correlation" invariant.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase Rev3-G
// G4:
//
//   "Curator ranker uses correlation only as tie-breaker within a
//    tier (does NOT promote across tiers)."
//
// The invariant is already enforced + tested inside `curatorRanker.
// test.ts` (the `cross-tier precedence` + `correlation as within-
// tier tie-breaker only` describe blocks). This file exists as a
// discoverable named test so anyone grepping for `cross-tier` or
// `G4` lands directly on the rule.
//
// What this guards against (real failure modes a regression could
// reintroduce):
//   1. A future "weighted composite" refactor folds correlation
//      INTO the composite — a tier-2 candidate with maxed
//      correlation could then outrank a weak tier-3.
//   2. A tier-bucket short-circuit gets reordered: e.g. composite
//      first, then tier — same effect, cross-tier override.
//   3. The tie-break itself leaks across tier buckets: e.g. ranker
//      compares correlation BEFORE confirming both items are in
//      the same tier.
//
// Each test pins one of those failure modes.

import { describe, expect, it } from 'vitest';

import {
  rankCuratorCandidates,
  type CuratorCandidate,
} from './curatorRanker.js';

function cand(
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

describe('rankCuratorCandidates — cross-tier invariant (G4)', () => {
  it('maxed tier-2 correlation NEVER outranks a tier-3 with zero correlation (FM #1: correlation folded into composite)', () => {
    const tier3Floor = cand('t3-floor', {
      tierScore: 1, // tier-3
      confidence: 0.01,
      recencyScore: 0.01,
      correlationScore: 0,
    });
    const tier2Ceiling = cand('t2-ceiling', {
      tierScore: 0.5, // tier-2
      confidence: 1,
      recencyScore: 1,
      correlationScore: 1, // maxed
    });
    const result = rankCuratorCandidates([tier2Ceiling, tier3Floor]);
    expect(result[0]!.entityId).toBe('t3-floor');
    expect(result[1]!.entityId).toBe('t2-ceiling');
    // tier-3 winning here was decided by the tier bucket — not by
    // any tie-breaker (different tier means no tie).
    expect(result[0]!.tieBrokenByCorrelation).toBe(false);
    expect(result[1]!.tieBrokenByCorrelation).toBe(false);
  });

  it('maxed tier-2 confidence + correlation NEVER outranks tier-3 (FM #2: tier sort vs composite sort order)', () => {
    // Demonstrates the tier bucket short-circuits BEFORE any
    // composite arithmetic — even when the tier-2 candidate would
    // win on every other axis simultaneously.
    const losingTier3 = cand('losing-t3', {
      tierScore: 1,
      confidence: 0,
      recencyScore: 0,
      correlationScore: 0,
    });
    const winningEverythingExceptTier2 = cand('almost-t3', {
      tierScore: 0.5,
      confidence: 1,
      recencyScore: 1,
      correlationScore: 1,
    });
    const result = rankCuratorCandidates([
      winningEverythingExceptTier2,
      losingTier3,
    ]);
    expect(result[0]!.entityId).toBe('losing-t3');
  });

  it('correlation tie-break never crosses tier boundaries (FM #3: cross-tier correlation comparison)', () => {
    // Two tier-3 candidates with identical composite, and a tier-2
    // candidate with maxed correlation. The tie-break should fire
    // BETWEEN the two tier-3s, never reach into the tier-2.
    const t3Lo = cand('t3-lo', {
      tierScore: 1,
      confidence: 0.5,
      recencyScore: 0.5,
      correlationScore: 0.2,
    });
    const t3Hi = cand('t3-hi', {
      tierScore: 1,
      confidence: 0.5,
      recencyScore: 0.5,
      correlationScore: 0.9,
    });
    const t2Maxed = cand('t2-maxed', {
      tierScore: 0.5,
      confidence: 0.5,
      recencyScore: 0.5,
      correlationScore: 1,
    });
    const result = rankCuratorCandidates([t3Lo, t2Maxed, t3Hi]);
    // Tier-3s occupy ranks 1-2; tier-2 is forced to rank 3 no
    // matter how high its correlation.
    expect(result.slice(0, 2).map((r) => r.entityId).sort()).toEqual(
      ['t3-hi', 't3-lo'],
    );
    expect(result[2]!.entityId).toBe('t2-maxed');
    // The tie-break only flagged t3-lo (the losing tier-3); t2-
    // maxed at rank 3 was NOT marked tie-broken because its
    // predecessor sits in a different tier.
    expect(result[0]!.entityId).toBe('t3-hi');
    expect(result[1]!.entityId).toBe('t3-lo');
    expect(result[1]!.tieBrokenByCorrelation).toBe(true);
    expect(result[2]!.tieBrokenByCorrelation).toBe(false);
  });

  it('cross-tier separation holds for the full tier ladder (tier-3 > tier-2 > tier-1)', () => {
    // Round-trip across all three tiers in the same call, each
    // with worse-than-perfect scores at the higher tier and
    // perfect scores at the lower tier — confirms the bucket
    // sort dominates uniformly across the whole ladder, not just
    // tier-3-vs-tier-2.
    const t1Perfect = cand('t1-perfect', {
      tierScore: 0,
      confidence: 1,
      recencyScore: 1,
      correlationScore: 1,
    });
    const t2Perfect = cand('t2-perfect', {
      tierScore: 0.5,
      confidence: 1,
      recencyScore: 1,
      correlationScore: 1,
    });
    const t3Floor = cand('t3-floor', {
      tierScore: 1,
      confidence: 0.01,
      recencyScore: 0.01,
      correlationScore: 0,
    });
    const result = rankCuratorCandidates([t1Perfect, t2Perfect, t3Floor]);
    expect(result.map((r) => r.entityId)).toEqual([
      't3-floor',
      't2-perfect',
      't1-perfect',
    ]);
  });
});
