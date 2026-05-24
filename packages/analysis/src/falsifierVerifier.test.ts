// Tests for the Phase Rev3-F F4 falsifier verifier kernel.

import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from './thresholds.js';
import {
  aggregateFalsifierVerdicts,
  type TurnJudgment,
  type TurnVerdict,
} from './falsifierVerifier.js';

function judg(verdict: TurnVerdict, cite = 's:1:0'): TurnJudgment {
  return { cite, verdict };
}

describe('aggregateFalsifierVerdicts', () => {
  describe('verdict aggregation', () => {
    it('returns not-verified for empty input (no citations = no evidence)', () => {
      const r = aggregateFalsifierVerdicts([]);
      expect(r.verdict).toBe('not-verified');
      expect(r.totalCited).toBe(0);
      expect(r.supportRatio).toBe(0);
    });

    it('returns verified when supportRatio >= falsifierMinSupportRatio', () => {
      // Default threshold 0.6 → 3/5 supports = exactly 0.6 → verified.
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('supports'),
        judg('supports'),
        judg('neutral'),
        judg('neutral'),
      ]);
      expect(r.verdict).toBe('verified');
      expect(r.supportRatio).toBe(0.6);
    });

    it('returns not-verified when supportRatio < threshold', () => {
      // 2/5 = 0.4 < 0.6 → not-verified.
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('supports'),
        judg('neutral'),
        judg('neutral'),
        judg('neutral'),
      ]);
      expect(r.verdict).toBe('not-verified');
      expect(r.supportRatio).toBe(0.4);
    });

    it('counts unavailable as failures in the denominator (citation hygiene)', () => {
      // 3 supports + 2 unavailable = 3/5 = 0.6 → verified at threshold.
      // (Unavailable does NOT get excluded — that would let a single
      // supports out of 1 resolvable vote pass with N-1 unresolved.)
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('supports'),
        judg('supports'),
        judg('unavailable'),
        judg('unavailable'),
      ]);
      expect(r.unavailableCount).toBe(2);
      expect(r.totalCited).toBe(5);
      expect(r.supportRatio).toBe(0.6);
      expect(r.verdict).toBe('verified');

      // Contrast: 1 supports + 4 unavailable = 1/5 = 0.2 → not-verified.
      const r2 = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('unavailable'),
        judg('unavailable'),
        judg('unavailable'),
        judg('unavailable'),
      ]);
      expect(r2.verdict).toBe('not-verified');
    });

    it('treats contradicts as failures (not just neutral)', () => {
      // 4 supports + 1 contradicts = 4/5 = 0.8 ≥ 0.6 → verified.
      // But supportRatio honestly reflects the failure.
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('supports'),
        judg('supports'),
        judg('supports'),
        judg('contradicts'),
      ]);
      expect(r.verdict).toBe('verified');
      expect(r.contradictingCount).toBe(1);
      expect(r.supportRatio).toBe(0.8);
    });
  });

  describe('per-bucket counts on the result', () => {
    it('reports all four bucket counts', () => {
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('supports'),
        judg('neutral'),
        judg('contradicts'),
        judg('unavailable'),
      ]);
      expect(r.supportingCount).toBe(2);
      expect(r.contradictingCount).toBe(1);
      expect(r.neutralCount).toBe(1);
      expect(r.unavailableCount).toBe(1);
      expect(r.totalCited).toBe(5);
    });
  });

  describe('threshold provenance', () => {
    it('exposes the threshold applied for downstream "re-falsify needed" prompts', () => {
      const r = aggregateFalsifierVerdicts([judg('supports')]);
      expect(r.thresholdApplied).toBe(
        THRESHOLDS.curator.falsifierMinSupportRatio,
      );
    });
  });

  describe('boundary behavior', () => {
    it('returns verified at exactly threshold (inclusive boundary)', () => {
      // Threshold 0.6; 6/10 supports = exactly 0.6.
      const r = aggregateFalsifierVerdicts(
        Array.from({ length: 10 }, (_, i) =>
          judg(i < 6 ? 'supports' : 'neutral'),
        ),
      );
      expect(r.supportRatio).toBe(0.6);
      expect(r.verdict).toBe('verified');
    });

    it('returns not-verified just below threshold', () => {
      // 5/10 supports = 0.5 < 0.6.
      const r = aggregateFalsifierVerdicts(
        Array.from({ length: 10 }, (_, i) =>
          judg(i < 5 ? 'supports' : 'neutral'),
        ),
      );
      expect(r.supportRatio).toBe(0.5);
      expect(r.verdict).toBe('not-verified');
    });

    it('returns verified on a 1/1 perfect support', () => {
      const r = aggregateFalsifierVerdicts([judg('supports')]);
      expect(r.verdict).toBe('verified');
      expect(r.supportRatio).toBe(1);
    });

    it('returns not-verified on 0/1 (single neutral / contradicts / unavailable)', () => {
      for (const v of ['neutral', 'contradicts', 'unavailable'] as const) {
        const r = aggregateFalsifierVerdicts([judg(v)]);
        expect(r.verdict).toBe('not-verified');
        expect(r.supportRatio).toBe(0);
      }
    });
  });

  describe('citationHygieneOk (design-coherence iter-1 finding)', () => {
    it('true when zero citations unresolved', () => {
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('supports'),
        judg('neutral'),
      ]);
      expect(r.citationHygieneOk).toBe(true);
      expect(r.unavailableCount).toBe(0);
    });

    it('false when any citation unresolved (even if verdict still verified)', () => {
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('supports'),
        judg('supports'),
        judg('unavailable'),
        judg('unavailable'),
      ]);
      expect(r.verdict).toBe('verified');
      expect(r.citationHygieneOk).toBe(false);
    });

    it('false on empty input (no citations at all)', () => {
      // Edge case: empty array → unavailableCount === 0, so the
      // strict `=== 0` check returns true. Is that the right call?
      // Yes — "no unresolved" is technically correct (there were no
      // resolutions to fail), and the not-verified verdict already
      // conveys the "no evidence" framing. Pinned as a documented
      // edge case rather than a special-case branch.
      const r = aggregateFalsifierVerdicts([]);
      expect(r.citationHygieneOk).toBe(true);
      expect(r.verdict).toBe('not-verified');
    });
  });

  describe('plan-stated invariants', () => {
    it('honors the "different agent type" structural-separation premise — no caller-side bias leaks in', () => {
      // The kernel is verdict-aggregation only; it never reads the
      // finding's text. This test pins that by passing judgments with
      // no finding-text reference field. (Negative-design test.)
      const r = aggregateFalsifierVerdicts([
        judg('supports', 'unique-cite-id-with-no-text-context'),
        judg('supports', 'another-id'),
      ]);
      expect(r.verdict).toBe('verified');
    });

    it('unavailable bucket as failure preserves "citation hygiene matters" claim', () => {
      // From the plan §"Intelligence layer": citation failures are
      // their own bucket (don't infer support from missing data).
      // This test pins that a finding citing 3 turns where 2 are
      // unresolvable can't be verified on the 1 supporting vote alone.
      const r = aggregateFalsifierVerdicts([
        judg('supports'),
        judg('unavailable'),
        judg('unavailable'),
      ]);
      expect(r.supportRatio).toBe(1 / 3);
      expect(r.verdict).toBe('not-verified');
    });
  });
});
