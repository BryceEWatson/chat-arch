import { describe, it, expect } from 'vitest';
import type { AuditResult, AuditOutcome, ClaimType, SessionSource } from '@chat-arch/schema';
import {
  binaryFromScore,
  composeOutcome,
  extractPrimitives,
  logitFromPrimitives,
  weightsHashFnv,
} from './composeOutcome.js';
import { THRESHOLDS } from './thresholds.js';

const SOURCE: SessionSource = 'cowork';

function r(claimType: ClaimType, outcome: AuditOutcome, lineNumber = 1): AuditResult {
  return {
    sessionId: 's1',
    source: SOURCE,
    lineNumber,
    claimType,
    span: 'span',
    surroundingContext: 'ctx',
    outcome,
    reason: 'r',
  };
}

describe('extractPrimitives', () => {
  it('empty results → all null', () => {
    const p = extractPrimitives([]);
    expect(p.testPass).toBeNull();
    expect(p.buildPass).toBeNull();
    expect(p.prLand).toBeNull();
    expect(p.noRework).toBeNull();
    expect(p.affirmation).toBeNull();
  });

  it('passes tests + build → corresponding bools true', () => {
    const p = extractPrimitives([
      r('tests-pass-claim', 'pass'),
      r('build-pass-claim', 'pass'),
    ]);
    expect(p.testPass).toBe(true);
    expect(p.buildPass).toBe(true);
  });

  it('any-fail rule: one fail in a family flips the bool to false', () => {
    const p = extractPrimitives([
      r('tests-pass-claim', 'pass'),
      r('tests-pass-claim', 'fail'),
    ]);
    expect(p.testPass).toBe(false);
  });

  it('inconclusive only → primitive stays null', () => {
    const p = extractPrimitives([r('build-pass-claim', 'inconclusive')]);
    expect(p.buildPass).toBeNull();
  });

  it('prLand → merged when gh-pr-merged passes', () => {
    const p = extractPrimitives([
      r('gh-pr-opened', 'pass'),
      r('gh-pr-merged', 'pass'),
    ]);
    expect(p.prLand).toBe('merged');
  });

  it('prLand → closed-unmerged when gh-pr-closed-unmerged passes', () => {
    const p = extractPrimitives([
      r('gh-pr-opened', 'pass'),
      r('gh-pr-closed-unmerged', 'pass'),
    ]);
    expect(p.prLand).toBe('closed-unmerged');
  });

  it('prLand → open when only gh-pr-opened passes', () => {
    const p = extractPrimitives([r('gh-pr-opened', 'pass')]);
    expect(p.prLand).toBe('open');
  });

  it('prLand → none when gh-pr-opened fails (claim un-evidenced)', () => {
    const p = extractPrimitives([r('gh-pr-opened', 'fail')]);
    expect(p.prLand).toBe('none');
  });

  it('rework signal flips noRework to false', () => {
    const p = extractPrimitives([r('git-revert', 'pass')]);
    expect(p.noRework).toBe(false);
  });

  it('no rework signals at all → noRework null', () => {
    const p = extractPrimitives([r('tests-pass-claim', 'pass')]);
    expect(p.noRework).toBeNull();
  });

  it('affirmation pass → true; fail → false', () => {
    expect(extractPrimitives([r('affirmation', 'pass')]).affirmation).toBe(true);
    expect(extractPrimitives([r('affirmation', 'fail')]).affirmation).toBe(false);
  });
});

describe('logitFromPrimitives', () => {
  const W = THRESHOLDS.composite.weights;

  it('all-null primitives → 0 logit (sigmoid 0 = 0.5)', () => {
    const { logit } = logitFromPrimitives({
      testPass: null,
      buildPass: null,
      prLand: null,
      noRework: null,
      affirmation: null,
    });
    expect(logit).toBe(0);
  });

  it('all-positive primitives → logit = sum of positive weights', () => {
    const { logit, contributions } = logitFromPrimitives({
      testPass: true,
      buildPass: true,
      prLand: 'merged',
      noRework: true,
      affirmation: true,
    });
    // testPass + buildPass + prLandMerged + affirmation (noRework=true contributes 0)
    const expected = W.testPass + W.buildPass + W.prLandMerged + W.affirmation;
    expect(logit).toBeCloseTo(expected, 12);
    expect(contributions.testPass).toBe(W.testPass);
    expect(contributions.reworkSameSession).toBe(0);
  });

  it('all-negative primitives → logit = sum of negative weights', () => {
    const { logit } = logitFromPrimitives({
      testPass: false,
      buildPass: null,
      prLand: 'closed-unmerged',
      noRework: false,
      affirmation: null,
    });
    const expected = W.testFail + W.prLandClosedUnmerged + W.reworkSameSession;
    expect(logit).toBeCloseTo(expected, 12);
  });

  it('respects custom bias', () => {
    const { logit } = logitFromPrimitives(
      { testPass: null, buildPass: null, prLand: null, noRework: null, affirmation: null },
      undefined,
      0.5,
    );
    expect(logit).toBe(0.5);
  });
});

describe('weightsHashFnv', () => {
  it('produces a 16-char hex string', () => {
    const h = weightsHashFnv(THRESHOLDS.composite.weights);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stable across calls', () => {
    const h1 = weightsHashFnv(THRESHOLDS.composite.weights);
    const h2 = weightsHashFnv(THRESHOLDS.composite.weights);
    expect(h1).toBe(h2);
  });

  it('changes when any weight changes', () => {
    const base = weightsHashFnv(THRESHOLDS.composite.weights);
    const bumped = weightsHashFnv({
      ...THRESHOLDS.composite.weights,
      testPass: THRESHOLDS.composite.weights.testPass + 0.01,
    });
    expect(base).not.toBe(bumped);
  });

  it('stable under property-order changes (canonical-JSON guarantee)', () => {
    const a = weightsHashFnv({
      testPass: 0.3,
      testFail: -0.4,
      buildPass: 0.2,
      prLandMerged: 0.5,
      prLandClosedUnmerged: -0.3,
      reworkSameSession: -0.2,
      reworkContinuation: -0.25,
      affirmation: 0.1,
    });
    // Re-emit with reversed key insertion order.
    const b = weightsHashFnv({
      affirmation: 0.1,
      reworkContinuation: -0.25,
      reworkSameSession: -0.2,
      prLandClosedUnmerged: -0.3,
      prLandMerged: 0.5,
      buildPass: 0.2,
      testFail: -0.4,
      testPass: 0.3,
    });
    expect(a).toBe(b);
  });
});

describe('binaryFromScore', () => {
  it('above threshold → good', () => {
    expect(binaryFromScore(THRESHOLDS.composite.binaryThresholdGood + 0.01)).toBe('good');
  });
  it('below 1-threshold → bad', () => {
    expect(binaryFromScore(1 - THRESHOLDS.composite.binaryThresholdGood - 0.01)).toBe('bad');
  });
  it('exactly at threshold → unknown', () => {
    expect(binaryFromScore(THRESHOLDS.composite.binaryThresholdGood)).toBe('unknown');
  });
});

describe('composeOutcome', () => {
  it('all-pass case: score > 0.7, binary good', () => {
    const out = composeOutcome(
      'sess-good',
      SOURCE,
      [
        r('tests-pass-claim', 'pass'),
        r('build-pass-claim', 'pass'),
        r('gh-pr-opened', 'pass'),
        r('gh-pr-merged', 'pass'),
        r('affirmation', 'pass'),
      ],
      null,
    );
    expect(out.sessionId).toBe('sess-good');
    expect(out.testPass).toBe(true);
    expect(out.buildPass).toBe(true);
    expect(out.prLand).toBe('merged');
    expect(out.affirmation).toBe(true);
    expect(out.score).toBeGreaterThan(0.7);
    expect(out.binary).toBe('good');
    // Linear logit = 0.3 + 0.2 + 0.5 + 0.1 = 1.1
    expect(out.linearLogit).toBeCloseTo(1.1, 9);
  });

  it('all-fail case: score < 0.3, binary bad', () => {
    const out = composeOutcome(
      'sess-bad',
      SOURCE,
      [
        r('tests-pass-claim', 'fail'),
        r('gh-pr-opened', 'pass'),
        r('gh-pr-closed-unmerged', 'pass'),
        r('git-reset-hard', 'pass'),
      ],
      null,
    );
    expect(out.testPass).toBe(false);
    expect(out.prLand).toBe('closed-unmerged');
    expect(out.noRework).toBe(false);
    expect(out.score).toBeLessThan(0.3);
    expect(out.binary).toBe('bad');
    // Linear logit = -0.4 + -0.3 + -0.2 = -0.9
    expect(out.linearLogit).toBeCloseTo(-0.9, 9);
  });

  it('mixed case: score ~0.5, binary unknown (one pos one neg)', () => {
    const out = composeOutcome(
      'sess-mixed',
      SOURCE,
      [
        r('tests-pass-claim', 'pass'), // +0.3
        r('gh-pr-opened', 'pass'),     // +0.0 (no logit contribution alone)
        r('gh-pr-closed-unmerged', 'pass'), // -0.3
      ],
      null,
    );
    // logit = 0.3 + -0.3 = 0; sigmoid(0) = 0.5
    expect(out.linearLogit).toBeCloseTo(0, 9);
    expect(out.score).toBeCloseTo(0.5, 9);
    expect(out.binary).toBe('unknown');
  });

  it('all-null case: binary unknown regardless of score', () => {
    const out = composeOutcome('sess-empty', SOURCE, [], null);
    expect(out.testPass).toBeNull();
    expect(out.buildPass).toBeNull();
    expect(out.prLand).toBeNull();
    expect(out.noRework).toBeNull();
    expect(out.affirmation).toBeNull();
    expect(out.score).toBeCloseTo(0.5, 9);
    expect(out.binary).toBe('unknown');
  });

  it('weightsHash field is present + matches direct call', () => {
    const out = composeOutcome('s', SOURCE, [r('tests-pass-claim', 'pass')], null);
    expect(out.weightsHash).toBe(weightsHashFnv(THRESHOLDS.composite.weights));
  });

  it('respects custom weights override', () => {
    // Zero weights => logit 0 => 0.5
    const zeroWeights = {
      testPass: 0,
      testFail: 0,
      buildPass: 0,
      prLandMerged: 0,
      prLandClosedUnmerged: 0,
      reworkSameSession: 0,
      reworkContinuation: 0,
      affirmation: 0,
    };
    const out = composeOutcome(
      's',
      SOURCE,
      [r('tests-pass-claim', 'pass')],
      null,
      { weights: zeroWeights },
    );
    expect(out.linearLogit).toBe(0);
    expect(out.score).toBeCloseTo(0.5, 9);
    expect(out.weightsHash).toBe(weightsHashFnv(zeroWeights));
    expect(out.weightsHash).not.toBe(weightsHashFnv(THRESHOLDS.composite.weights));
  });

  it('inconclusive-only results behave like all-null', () => {
    const out = composeOutcome(
      's',
      SOURCE,
      [
        r('tests-pass-claim', 'inconclusive'),
        r('build-pass-claim', 'inconclusive'),
      ],
      null,
    );
    expect(out.testPass).toBeNull();
    expect(out.buildPass).toBeNull();
    expect(out.binary).toBe('unknown');
  });

  it('upgradeSnapshot is accepted (reserved for Wave 3) without throwing', () => {
    const out = composeOutcome(
      's',
      SOURCE,
      [r('tests-pass-claim', 'pass')],
      { preMean: 0.5, postMean: 0.7 },
    );
    // Snapshot is currently ignored; score depends only on audit results.
    expect(out.score).toBeGreaterThan(0.5);
  });
});
