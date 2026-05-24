// Phase Rev3-G G6 — gate test.
//
// Plan exit criterion for Phase Rev3-G:
//   "correlation tags visible only when |Δ|/SE exceeds threshold;
//    tie-breaker only fires on evidence ≥ 5."
//
// What this gate composes (the Rev3-G kernels on top of the F3
// curator ranker):
//
//   1. **G1 Welch's t** (`welchsTTest`) — produces `{t, valid}` from
//      a (cited, uncited) outcome sample.
//   2. **G2 visibility gate** (`evaluateCorrelationTagVisibility`) —
//      decides whether the correlation tag is shown on the surfaced
//      item, gated on `|t| ≥ outcomeCorrelationSignificance` AND
//      `evidence.length ≥ outcomeCorrelationEvidenceMinLength`.
//   3. **F3 + G4 ranker** (`rankCuratorCandidates`) — uses
//      `correlationScore` only as a within-tier tie-breaker. The
//      kernel's contract says the CALLER must zero the score when
//      the G2 gate fails; this gate test pins that wiring.
//   4. **G5 permutation test** (`permutationTestDelta`) — the
//      falsifier's non-parametric back-stop for small-n, heavy-
//      tailed samples. The gate confirms it agrees with Welch on
//      the visibility outcome at the bracket boundary.
//
// Why integration-shaped (not just unit tests on each kernel): each
// kernel has its own tests, but the load-bearing invariant — that
// the tie-breaker ONLY fires after the G2 gate passes — emerges
// from how the pieces are wired, not from any one kernel's
// behavior. This gate pins the wiring contract.

import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from './thresholds.js';
import { welchsTTest } from './welchsTTest.js';
import {
  evaluateCorrelationTagVisibility,
} from './correlationTagGate.js';
import {
  rankCuratorCandidates,
  type CuratorCandidate,
} from './curatorRanker.js';
import { permutationTestDelta } from './correlationPermutation.js';

/**
 * Mirrors the curator pipeline's correlation-score wiring: run the
 * G2 gate; if it hides the tag, the correlation tie-breaker MUST
 * not fire — caller zeros the score. Otherwise pass `rawScore`
 * through.
 *
 * This is the wiring contract G4 (cross-tier invariant) + G6 (the
 * tie-breaker evidence gate) jointly pin.
 */
function gatedCorrelationScore(
  cited: readonly number[],
  uncited: readonly number[],
  rawScore: number,
): number {
  const stat = welchsTTest(cited, uncited);
  const visibility = evaluateCorrelationTagVisibility({
    stat: { t: stat.t, valid: stat.valid },
    evidenceLength: cited.length + uncited.length,
  });
  return visibility.visible ? rawScore : 0;
}

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

describe('Phase Rev3-G G6 — correlation visibility + tie-breaker gate', () => {
  describe('visibility gate (G2): correlation tags visible only when |Δ|/SE > threshold AND evidence ≥ 5', () => {
    it('shows tag when both rails pass: large effect + enough evidence', () => {
      // Large clear separation, n_total = 12 ≥ 5.
      const cited = [10, 11, 12, 10, 11, 12];
      const uncited = [1, 2, 3, 1, 2, 3];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length + uncited.length,
      });
      expect(visibility.visible).toBe(true);
    });

    it('hides tag with insufficient-evidence reason when evidence < 5 (even if effect is huge)', () => {
      // Maximally separated samples; only n=4 evidence — too few.
      const cited = [100, 101];
      const uncited = [1, 2];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length + uncited.length,
      });
      expect(visibility.visible).toBe(false);
      if (!visibility.visible) {
        expect(visibility.reason).toBe('insufficient-evidence');
      }
    });

    it('hides tag with below-significance reason when effect too small (even if evidence is plentiful)', () => {
      // Heavy overlap, |t| << 1.96, n_total = 20.
      const cited = [4, 5, 6, 5, 5, 5, 5, 6, 4, 5];
      const uncited = [5, 5, 5, 5, 5, 6, 4, 5, 5, 5];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length + uncited.length,
      });
      expect(visibility.visible).toBe(false);
      if (!visibility.visible) {
        // Could be 'below-significance' OR 'invalid-stat' if the
        // means coincide exactly (zero variance both sides). Both
        // are correct gate decisions; the load-bearing claim is
        // simply "tag is NOT visible".
        expect(['below-significance', 'invalid-stat']).toContain(
          visibility.reason,
        );
      }
    });

    it('honors the exact evidence boundary at outcomeCorrelationEvidenceMinLength (inclusive pass)', () => {
      const minN = THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength;
      // Construct samples summing to exactly minN with large effect.
      const halfMin = Math.ceil(minN / 2);
      const otherHalf = minN - halfMin;
      const cited = Array.from({ length: halfMin }, (_, i) => 100 + i);
      const uncited = Array.from({ length: otherHalf }, (_, i) => i);
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length + uncited.length,
      });
      expect(cited.length + uncited.length).toBe(minN);
      expect(visibility.visible).toBe(true);
    });

    it('one below evidence boundary still hides (strict-less-than)', () => {
      const minN = THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength;
      const total = minN - 1;
      const halfMin = Math.ceil(total / 2);
      const otherHalf = total - halfMin;
      const cited = Array.from({ length: halfMin }, (_, i) => 100 + i);
      const uncited = Array.from({ length: otherHalf }, (_, i) => i);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: welchsTTest(cited, uncited).t, valid: true },
        evidenceLength: cited.length + uncited.length,
      });
      expect(visibility.visible).toBe(false);
      if (!visibility.visible) {
        expect(visibility.reason).toBe('insufficient-evidence');
      }
    });
  });

  describe('tie-breaker gate (G6 load-bearing): ranker tie-break only fires when evidence ≥ 5', () => {
    // Two tier-3 candidates with identical composite (same confidence
    // + recency). The "winner" has the larger RAW correlation. The
    // question: does the tie-break promote it?
    //
    //   - When evidence ≥ 5 AND |t| > threshold → G2 gate passes →
    //     correlationScore preserved → tie-break fires → A wins.
    //   - When evidence < 5 → G2 gate hides → correlationScore
    //     zeroed → tie-break can't decide → stable sort preserves
    //     input order → B (passed in first) wins.

    it('tie-break FIRES when evidence ≥ 5 and effect is significant', () => {
      const winnerCited = [10, 11, 12, 10, 11, 12]; // n=6 ≥ 5
      const winnerUncited = [1, 2, 3, 1, 2, 3];
      const loserCited = [5, 5, 5, 5, 5, 5];
      const loserUncited = [5, 5, 5, 5, 5, 5];

      const winner = cand('winner', {
        correlationScore: gatedCorrelationScore(
          winnerCited,
          winnerUncited,
          0.9,
        ),
      });
      const loser = cand('loser', {
        correlationScore: gatedCorrelationScore(
          loserCited,
          loserUncited,
          0.2,
        ),
      });
      // Input order LOSER first so we know the tie-break (not
      // stable sort) put winner on top.
      const ranked = rankCuratorCandidates([loser, winner]);
      expect(ranked[0]!.entityId).toBe('winner');
      expect(ranked[0]!.correlationScore).toBe(0.9);
      expect(ranked[1]!.tieBrokenByCorrelation).toBe(true);
    });

    it('tie-break DOES NOT influence rank order when evidence < 5 — correlationScore zeroed by G2 gate', () => {
      // Both candidates have evidence n=4 < 5; gate hides both
      // even though their raw effect would otherwise be huge.
      // Load-bearing claim: with correlation zeroed, the ranker
      // CANNOT promote A over B — input order must win. We prove
      // this by swapping input order and confirming output order
      // swaps too.
      const aCited = [100, 101];
      const aUncited = [1, 2];
      const bCited = [50, 51];
      const bUncited = [10, 11];

      const buildA = () => cand('a-high-raw', {
        correlationScore: gatedCorrelationScore(aCited, aUncited, 0.9),
      });
      const buildB = () => cand('b-low-raw', {
        correlationScore: gatedCorrelationScore(bCited, bUncited, 0.2),
      });
      expect(buildA().correlationScore).toBe(0);
      expect(buildB().correlationScore).toBe(0);

      const aThenB = rankCuratorCandidates([buildA(), buildB()]);
      expect(aThenB[0]!.entityId).toBe('a-high-raw');
      const bThenA = rankCuratorCandidates([buildB(), buildA()]);
      expect(bThenA[0]!.entityId).toBe('b-low-raw');
      // Note: `tieBrokenByCorrelation` is set whenever the within-
      // tier composite ties — including this degenerate "both
      // zeroed → stable-sort fallback" case. The flag is a UI
      // attribution hint, not the load-bearing invariant. The
      // invariant is the swap-test above: raw correlation doesn't
      // touch the rank when G2 gates it away.
    });

    it('tie-break DOES NOT influence rank order when evidence ≥ 5 but |t| below significance', () => {
      // Plenty of evidence (n=20), but means coincide — |t| ≈ 0,
      // below 1.96. G2 hides → correlationScore zeroed. Same
      // swap-test as above proves the rank invariant.
      const flat = Array.from({ length: 10 }, () => 5);
      const buildA = () => cand('a-raw', {
        correlationScore: gatedCorrelationScore(flat, flat, 0.9),
      });
      const buildB = () => cand('b-raw', {
        correlationScore: gatedCorrelationScore(flat, flat, 0.2),
      });
      expect(buildA().correlationScore).toBe(0);
      expect(buildB().correlationScore).toBe(0);

      const aThenB = rankCuratorCandidates([buildA(), buildB()]);
      expect(aThenB[0]!.entityId).toBe('a-raw');
      const bThenA = rankCuratorCandidates([buildB(), buildA()]);
      expect(bThenA[0]!.entityId).toBe('b-raw');
    });

    it('control: when G2 gate PASSES, the same swap-test does NOT swap output (rank is correlation-decided)', () => {
      // Mirror of the previous two tests with evidence sufficient
      // + effect significant — proves the swap-test is sensitive,
      // not vacuous. The high-raw candidate wins regardless of
      // input position.
      const winCited = [10, 11, 12, 10, 11, 12];
      const winUncited = [1, 2, 3, 1, 2, 3];
      const buildHi = () => cand('hi-raw', {
        correlationScore: gatedCorrelationScore(winCited, winUncited, 0.9),
      });
      const buildLo = () => cand('lo-raw', {
        correlationScore: gatedCorrelationScore(winCited, winUncited, 0.2),
      });
      expect(buildHi().correlationScore).toBe(0.9);
      expect(buildLo().correlationScore).toBe(0.2);

      const hiThenLo = rankCuratorCandidates([buildHi(), buildLo()]);
      expect(hiThenLo[0]!.entityId).toBe('hi-raw');
      const loThenHi = rankCuratorCandidates([buildLo(), buildHi()]);
      // Tie-break wins again regardless of input order.
      expect(loThenHi[0]!.entityId).toBe('hi-raw');
    });

    it('boundary: exactly at evidence min (n=5) passes the gate AND fires the tie-break', () => {
      const minN = THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength;
      // Construct paired samples summing to exactly minN with a
      // large effect so |t| clears the significance threshold.
      const halfMin = Math.ceil(minN / 2);
      const otherHalf = minN - halfMin;
      const winnerCited = Array.from({ length: halfMin }, (_, i) => 100 + i);
      const winnerUncited = Array.from({ length: otherHalf }, (_, i) => i);

      const winner = cand('winner-at-boundary', {
        correlationScore: gatedCorrelationScore(
          winnerCited,
          winnerUncited,
          0.8,
        ),
      });
      const loser = cand('loser-at-boundary', {
        // Same shape as winner (large effect, n=5) so G2 also
        // passes — different raw score breaks the tie.
        correlationScore: gatedCorrelationScore(
          winnerCited,
          winnerUncited,
          0.3,
        ),
      });
      expect(winnerCited.length + winnerUncited.length).toBe(minN);
      expect(winner.correlationScore).toBe(0.8);
      expect(loser.correlationScore).toBe(0.3);
      const ranked = rankCuratorCandidates([loser, winner]);
      expect(ranked[0]!.entityId).toBe('winner-at-boundary');
      expect(ranked[1]!.tieBrokenByCorrelation).toBe(true);
    });
  });

  describe('falsifier back-stop (G5 permutation): agrees with Welch on visibility decision', () => {
    it('large clear effect: both Welch and permutation hide nothing, tag visible', () => {
      const cited = [10, 11, 12, 10, 11, 12, 10, 11, 12];
      const uncited = [1, 2, 3, 1, 2, 3, 1, 2, 3];
      const welch = welchsTTest(cited, uncited);
      const perm = permutationTestDelta(cited, uncited, {
        permutations: 1_000,
      });
      // Welch says significant.
      expect(Math.abs(welch.t)).toBeGreaterThan(
        THRESHOLDS.curator.outcomeCorrelationSignificance,
      );
      // Permutation also says significant (p well below 0.05).
      expect(perm.pValueTwoSided).toBeLessThan(0.05);
      // And the visibility gate confirms tag is shown.
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: welch.t, valid: welch.valid },
        evidenceLength: cited.length + uncited.length,
      });
      expect(visibility.visible).toBe(true);
    });

    it('heavy overlap: both Welch and permutation flag insignificant; tag hidden', () => {
      const cited = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const uncited = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const welch = welchsTTest(cited, uncited);
      const perm = permutationTestDelta(cited, uncited, {
        permutations: 2_000,
        seed: 12345,
      });
      // Welch |t| should fall below the 1.96 significance threshold.
      expect(Math.abs(welch.t)).toBeLessThan(
        THRESHOLDS.curator.outcomeCorrelationSignificance,
      );
      // Permutation p > 0.05 — agrees on no effect.
      expect(perm.pValueTwoSided).toBeGreaterThan(0.05);
      // G2 hides the tag.
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: welch.t, valid: welch.valid },
        evidenceLength: cited.length + uncited.length,
      });
      expect(visibility.visible).toBe(false);
    });
  });
});
