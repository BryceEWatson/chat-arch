// Tests for the Phase Rev3-F F8 meta-validation kernel.

import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from './thresholds.js';
import {
  evaluateFalsifierMetaAccuracy,
  type VerdictPair,
} from './falsifierMetaAccuracy.js';

const MS_PER_DAY = 86_400_000;
const NOW = Date.parse('2026-05-24T00:00:00Z');

function pair(
  agree: boolean,
  daysAgo: number,
): VerdictPair {
  return {
    judgedAt: NOW - daysAgo * MS_PER_DAY,
    originalVerdict: 'verified',
    reJudgedVerdict: agree ? 'verified' : 'not-verified',
  };
}

describe('evaluateFalsifierMetaAccuracy', () => {
  describe('empty + below-minN cases (banner stays off)', () => {
    it('empty input → inDrift=false, n=0, lowerBound=0', () => {
      const r = evaluateFalsifierMetaAccuracy([], { now: NOW });
      expect(r.inDrift).toBe(false);
      expect(r.n).toBe(0);
      expect(r.accuracy).toBe(0);
      expect(r.lowerBound).toBe(0);
    });

    it('does NOT fire the banner when n < minN, even with 0% agreement', () => {
      // Catastrophic agreement (0/5) but below the default n=40 floor.
      const pairs = Array.from({ length: 5 }, () => pair(false, 1));
      const r = evaluateFalsifierMetaAccuracy(pairs, { now: NOW });
      expect(r.n).toBe(5);
      expect(r.accuracy).toBe(0);
      expect(r.inDrift).toBe(false); // small-n guard
    });

    it('uses minNOverride for test convenience', () => {
      const pairs = Array.from({ length: 5 }, () => pair(false, 1));
      const r = evaluateFalsifierMetaAccuracy(pairs, {
        now: NOW,
        minNOverride: 1,
      });
      expect(r.inDrift).toBe(true); // small-n guard relaxed
    });
  });

  describe('windowing (rolling 4-week)', () => {
    it('filters pairs outside the rolling window', () => {
      // 30 pairs in-window + 30 pairs out-of-window (60 days ago,
      // well past the 4-week default). Effective n is 30.
      const inWindow = Array.from({ length: 30 }, () => pair(true, 1));
      const outOfWindow = Array.from({ length: 30 }, () => pair(false, 60));
      const r = evaluateFalsifierMetaAccuracy(
        [...inWindow, ...outOfWindow],
        { now: NOW },
      );
      expect(r.n).toBe(30);
      expect(r.agreementCount).toBe(30);
    });

    it('windowWeeksOverride works for tests', () => {
      // With a 1-week override, the 10-day-old pair drops.
      const recent = Array.from({ length: 30 }, () => pair(true, 1));
      const tooOld = Array.from({ length: 30 }, () => pair(true, 10));
      const r = evaluateFalsifierMetaAccuracy(
        [...recent, ...tooOld],
        { now: NOW, windowWeeksOverride: 1 },
      );
      expect(r.n).toBe(30);
    });

    it('cutoff is strict-greater-than (boundary excluded)', () => {
      // A pair judged exactly 4 weeks (28 days) ago — at the boundary.
      // Cutoff is `now - 4*7*MS_PER_DAY`; the check is `judgedAt > cutoff`.
      // So the pair AT the cutoff is excluded.
      const atBoundary = {
        judgedAt: NOW - 4 * 7 * MS_PER_DAY,
        originalVerdict: 'verified' as const,
        reJudgedVerdict: 'verified' as const,
      };
      const r = evaluateFalsifierMetaAccuracy([atBoundary], { now: NOW });
      expect(r.n).toBe(0);
    });

    it('non-finite judgedAt is skipped', () => {
      const dirty = {
        judgedAt: Number.NaN,
        originalVerdict: 'verified' as const,
        reJudgedVerdict: 'verified' as const,
      };
      const clean = pair(true, 1);
      const r = evaluateFalsifierMetaAccuracy([dirty, clean], { now: NOW });
      expect(r.n).toBe(1);
    });
  });

  describe('drift trigger — Wilson LB vs floor', () => {
    it('fires when sample size ≥ minN AND Wilson LB < floor', () => {
      // 40 pairs with 24/40 = 0.6 agreement (way below 0.8 floor).
      // Wilson LB on 24/40 ≈ 0.44.
      const agreement = Array.from({ length: 24 }, () => pair(true, 1));
      const disagreement = Array.from({ length: 16 }, () => pair(false, 1));
      const r = evaluateFalsifierMetaAccuracy(
        [...agreement, ...disagreement],
        { now: NOW },
      );
      expect(r.n).toBe(40);
      expect(r.accuracy).toBeCloseTo(0.6, 5);
      expect(r.lowerBound).toBeLessThan(0.8);
      expect(r.inDrift).toBe(true);
    });

    it('does NOT fire when accuracy is high enough that LB clears floor', () => {
      // 40 pairs with 38/40 = 0.95. Wilson LB ≈ 0.84 ≥ 0.8.
      const agreement = Array.from({ length: 38 }, () => pair(true, 1));
      const disagreement = Array.from({ length: 2 }, () => pair(false, 1));
      const r = evaluateFalsifierMetaAccuracy(
        [...agreement, ...disagreement],
        { now: NOW },
      );
      expect(r.n).toBe(40);
      expect(r.lowerBound).toBeGreaterThanOrEqual(0.8);
      expect(r.inDrift).toBe(false);
    });

    it('does NOT fire on the small-n noise case (plan §"point-estimate fires 26% of weeks at 0.9")', () => {
      // n=10/week point estimate at true 0.9 → fires ~26% on noise.
      // The minN floor (40) prevents that. Even 9/10 perfect
      // agreement gives Wilson LB ~0.60 — would fire under the old
      // point-estimate rule, but the minN guard blocks it.
      const agreement = Array.from({ length: 9 }, () => pair(true, 1));
      const disagreement = Array.from({ length: 1 }, () => pair(false, 1));
      const r = evaluateFalsifierMetaAccuracy(
        [...agreement, ...disagreement],
        { now: NOW },
      );
      expect(r.n).toBe(10);
      expect(r.lowerBound).toBeLessThan(0.8); // would fire on raw LB
      expect(r.inDrift).toBe(false); // but minN guard blocks
    });

    it('floorOverride lets tests exercise the boundary', () => {
      // 40 pairs, 80% agreement → Wilson LB ≈ 0.65.
      const agreement = Array.from({ length: 32 }, () => pair(true, 1));
      const disagreement = Array.from({ length: 8 }, () => pair(false, 1));
      // With a permissive floor (0.5), no drift.
      const lenient = evaluateFalsifierMetaAccuracy(
        [...agreement, ...disagreement],
        { now: NOW, floorOverride: 0.5 },
      );
      expect(lenient.inDrift).toBe(false);
      // With a strict floor (0.9), drift fires.
      const strict = evaluateFalsifierMetaAccuracy(
        [...agreement, ...disagreement],
        { now: NOW, floorOverride: 0.9 },
      );
      expect(strict.inDrift).toBe(true);
    });
  });

  describe('result shape', () => {
    it('exposes counts + ratios + thresholds', () => {
      const r = evaluateFalsifierMetaAccuracy(
        [pair(true, 1), pair(false, 1)],
        { now: NOW },
      );
      expect(r.n).toBe(2);
      expect(r.agreementCount).toBe(1);
      expect(r.accuracy).toBe(0.5);
      expect(r.floor).toBe(THRESHOLDS.curator.falsifierAccuracyFloor);
      expect(r.minN).toBe(THRESHOLDS.curator.falsifierAccuracyWindowN);
    });
  });

  describe('verdict-disagreement direction', () => {
    it('treats verified↔not-verified swaps as disagreements either way', () => {
      const pairs: VerdictPair[] = [
        // verified → not-verified
        {
          judgedAt: NOW - MS_PER_DAY,
          originalVerdict: 'verified',
          reJudgedVerdict: 'not-verified',
        },
        // not-verified → verified
        {
          judgedAt: NOW - MS_PER_DAY,
          originalVerdict: 'not-verified',
          reJudgedVerdict: 'verified',
        },
      ];
      const r = evaluateFalsifierMetaAccuracy(pairs, {
        now: NOW,
        minNOverride: 1,
      });
      expect(r.agreementCount).toBe(0);
      expect(r.accuracy).toBe(0);
    });
  });
});
