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
//      the visibility outcome at the EXTREMES (clear-signal and
//      clear-no-signal regions). Boundary disagreement near
//      |t| ≈ 1.96 is exactly where the permutation back-stop
//      earns its keep, but pinning specific boundary outcomes
//      risks RNG-seed flake; see `correlationPermutation.test.ts`
//      for the kernel's own boundary-region tests.
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
 * Specifies the contract the future curator pipeline caller MUST
 * implement when wiring G2 visibility into the F3 ranker: run the
 * G2 gate; if it hides the tag, the correlation tie-breaker MUST
 * not fire — caller zeros the score. Otherwise pass `rawScore`
 * through.
 *
 * IMPORTANT — `evidenceLength` semantics: G2's contract
 * (`correlationTagGate.ts` `CorrelationTagInput.evidenceLength`)
 * documents this as "Number of evidence rows the candidate cites"
 * — i.e., the CITED side only, NOT cited + uncited. The "cited"
 * sample IS the narrative's supporting evidence; "uncited" is the
 * rest of the project's session pool used as a baseline for the
 * Welch Δ test. These are different quantities. The G6 plan-exit
 * phrase "evidence ≥ 5" refers to the narrative's supporting-
 * evidence count, which equals `cited.length`.
 *
 * This is the wiring contract G4 (cross-tier invariant) + G6 (the
 * tie-breaker evidence gate) jointly pin.
 *
 * NOTE: there is currently NO production caller doing this wiring
 * (welchsTTest has zero non-test callers as of PR #92). When the
 * curator pipeline lands a real caller, the production code SHOULD
 * use the same `cited.length`-as-evidenceLength rule this helper
 * encodes, or update the G2 docstring to clarify a different
 * semantic. The drift-risk is real; see the "discussion of future
 * caller" comment in `curatorRanker.ts`.
 */
function gatedCorrelationScore(
  cited: readonly number[],
  uncited: readonly number[],
  rawScore: number,
): number {
  const stat = welchsTTest(cited, uncited);
  const visibility = evaluateCorrelationTagVisibility({
    stat: { t: stat.t, valid: stat.valid },
    evidenceLength: cited.length, // G2 docstring: "rows the candidate cites" = cited side only
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
    it('shows tag when both rails pass: large effect + enough cited evidence', () => {
      // Large clear separation; cited.length = 6 ≥ 5 (the gate's
      // evidence rail). Uncited size doesn't matter for the gate.
      const cited = [10, 11, 12, 10, 11, 12];
      const uncited = [1, 2, 3, 1, 2, 3];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length,
      });
      expect(visibility.visible).toBe(true);
    });

    it('hides tag with insufficient-evidence reason when cited.length < 5 (even if effect is huge)', () => {
      // Maximally separated samples; only n=2 CITED evidence rows
      // (uncited can be any size — it doesn't count toward the
      // evidence rail per G2's contract).
      const cited = [100, 101];
      const uncited = [1, 2, 3, 4, 5, 6, 7, 8];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length,
      });
      expect(visibility.visible).toBe(false);
      if (!visibility.visible) {
        expect(visibility.reason).toBe('insufficient-evidence');
      }
    });

    it('hides tag with below-significance reason when effect too small (even if cited.length ≥ 5)', () => {
      // Heavy overlap, non-zero variance on both sides, means
      // close but not identical → |t| < 1.96 → 'below-significance'
      // (NOT 'invalid-stat'; we deliberately pick a non-flat
      // fixture so the path under test is genuinely the
      // significance gate, not the degenerate-stat short-circuit).
      const cited = [4, 5, 6, 5, 4, 6, 5, 5, 4, 6];
      const uncited = [5, 6, 4, 6, 5, 4, 6, 5, 5, 5];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length,
      });
      expect(stat.valid).toBe(true); // pins this is the below-sig path, not invalid-stat
      expect(Math.abs(stat.t)).toBeLessThan(
        THRESHOLDS.curator.outcomeCorrelationSignificance,
      );
      expect(visibility.visible).toBe(false);
      if (!visibility.visible) {
        expect(visibility.reason).toBe('below-significance');
      }
    });

    it('honors the exact evidence boundary at outcomeCorrelationEvidenceMinLength (inclusive pass)', () => {
      const minN = THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength;
      // The threshold currently = 5. Test math requires minN ≥ 2
      // for Welch to be `valid` (n ≥ 2 on each side). If calibration
      // ever drops minN below 2 this test should fail loudly rather
      // than silently invert.
      expect(minN).toBeGreaterThanOrEqual(2);
      // cited.length = minN (exactly at the gate boundary); uncited
      // can be any size ≥ 2. Use ≥2 on uncited so Welch is valid.
      const cited = Array.from({ length: minN }, (_, i) => 100 + i);
      const uncited = [0, 1];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length,
      });
      expect(cited.length).toBe(minN);
      expect(visibility.visible).toBe(true);
    });

    it('one below evidence boundary still hides (strict-less-than)', () => {
      const minN = THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength;
      // Same precondition as above.
      expect(minN).toBeGreaterThanOrEqual(2);
      // cited.length = minN - 1 (one short of the gate). Uncited
      // still ≥ 2 for valid Welch.
      const cited = Array.from({ length: minN - 1 }, (_, i) => 100 + i);
      const uncited = [0, 1];
      const stat = welchsTTest(cited, uncited);
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: stat.t, valid: stat.valid },
        evidenceLength: cited.length,
      });
      expect(cited.length).toBe(minN - 1);
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
    //   - When cited.length ≥ 5 AND |t| > threshold → G2 gate passes →
    //     correlationScore preserved → tie-break fires → A wins.
    //   - When cited.length < 5 → G2 gate hides → correlationScore
    //     zeroed → tie-break can't decide → stable sort preserves
    //     input order → B (passed in first) wins.
    //
    // `cited.length` is the gate's evidence rail per G2's contract
    // (see `gatedCorrelationScore` docstring above for full
    // semantic discussion).

    it('tie-break FIRES when cited.length ≥ 5 and effect is significant', () => {
      const winnerCited = [10, 11, 12, 10, 11, 12]; // cited.length = 6 ≥ 5
      const winnerUncited = [1, 2, 3, 1, 2, 3];
      // Loser uses an n=2 cited sample so G2 hides ITS tag and
      // zeros its score. The asymmetry isn't strictly required for
      // the FIRES claim (the test would still work with two passing
      // candidates of differing rawScore), but it does double-duty
      // verifying that the loser's zero score loses to the
      // winner's preserved 0.9 — a small belt-and-suspenders check
      // that gated zeros really lose to gated rawScores.
      const loserCited = [5, 5];
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
      expect(winner.correlationScore).toBe(0.9);
      expect(loser.correlationScore).toBe(0); // gated to 0 (cited.length=2 < 5)
      const ranked = rankCuratorCandidates([loser, winner]);
      expect(ranked[0]!.entityId).toBe('winner');
      expect(ranked[0]!.correlationScore).toBe(0.9);
      expect(ranked[1]!.tieBrokenByCorrelation).toBe(true);
    });

    it('tie-break DOES NOT influence rank order when cited.length < 5 — correlationScore zeroed by G2 gate', () => {
      // Both candidates have cited.length = 2 < 5; gate hides both
      // even though their raw effect would otherwise be huge.
      // Load-bearing claim: with correlation zeroed, the ranker
      // CANNOT promote A over B — input order must win. We prove
      // this by swapping input order and confirming output order
      // swaps too.
      const aCited = [100, 101]; // cited.length = 2 < 5
      const aUncited = [1, 2, 3, 4];
      const bCited = [50, 51]; // cited.length = 2 < 5
      const bUncited = [10, 11, 12, 13];

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

    it('tie-break DOES NOT influence rank order when cited.length ≥ 5 but |t| below significance', () => {
      // Plenty of cited evidence (length=10), means close but not
      // identical, non-zero variance both sides → |t| < 1.96 →
      // 'below-significance' path (deterministically, NOT the
      // 'invalid-stat' short-circuit). G2 hides → correlationScore
      // zeroed.
      const noisyA = [4, 5, 6, 5, 4, 6, 5, 5, 4, 6];
      const noisyB = [5, 6, 4, 6, 5, 4, 6, 5, 5, 5];
      // Sanity: this fixture lands on the below-sig path, not
      // invalid-stat.
      const probeStat = welchsTTest(noisyA, noisyB);
      expect(probeStat.valid).toBe(true);
      expect(Math.abs(probeStat.t)).toBeLessThan(
        THRESHOLDS.curator.outcomeCorrelationSignificance,
      );

      const buildA = () => cand('a-raw', {
        correlationScore: gatedCorrelationScore(noisyA, noisyB, 0.9),
      });
      const buildB = () => cand('b-raw', {
        correlationScore: gatedCorrelationScore(noisyB, noisyA, 0.2),
      });
      expect(buildA().correlationScore).toBe(0);
      expect(buildB().correlationScore).toBe(0);

      const aThenB = rankCuratorCandidates([buildA(), buildB()]);
      expect(aThenB[0]!.entityId).toBe('a-raw');
      const bThenA = rankCuratorCandidates([buildB(), buildA()]);
      expect(bThenA[0]!.entityId).toBe('b-raw');
    });

    it('control: when G2 gate PASSES, the same swap-test does NOT swap output (rank is correlation-decided)', () => {
      // Mirror of the previous two tests with cited.length ≥ 5
      // + effect significant — proves the swap-test is sensitive,
      // not vacuous. The high-raw candidate wins regardless of
      // input position.
      const winCited = [10, 11, 12, 10, 11, 12]; // cited.length = 6 ≥ 5
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

    it('boundary: exactly at cited.length=minN (5) passes the gate AND fires the tie-break', () => {
      const minN = THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength;
      // Precondition: Welch needs n≥2 on each side; minN must be
      // ≥2 for this fixture's `cited.length=minN` shape to produce
      // a valid stat at all.
      expect(minN).toBeGreaterThanOrEqual(2);
      // cited.length = minN exactly; uncited size ≥ 2 for Welch
      // validity. Large effect so |t| clears 1.96.
      const winnerCited = Array.from({ length: minN }, (_, i) => 100 + i);
      const winnerUncited = [0, 1];

      const winner = cand('winner-at-boundary', {
        correlationScore: gatedCorrelationScore(
          winnerCited,
          winnerUncited,
          0.8,
        ),
      });
      const loser = cand('loser-at-boundary', {
        // Same shape as winner (cited.length=minN, large effect)
        // so G2 also passes — different raw score breaks the tie.
        correlationScore: gatedCorrelationScore(
          winnerCited,
          winnerUncited,
          0.3,
        ),
      });
      expect(winnerCited.length).toBe(minN);
      expect(winner.correlationScore).toBe(0.8);
      expect(loser.correlationScore).toBe(0.3);
      const ranked = rankCuratorCandidates([loser, winner]);
      expect(ranked[0]!.entityId).toBe('winner-at-boundary');
      expect(ranked[1]!.tieBrokenByCorrelation).toBe(true);
    });
  });

  describe('falsifier back-stop (G5 permutation): agrees with Welch on visibility decision in the clear-signal / clear-no-signal regions', () => {
    // NOTE: this describe block tests agreement at the EXTREMES
    // (huge clear effect, heavy overlap). Welch and permutation
    // can plausibly disagree near the |t| ≈ 1.96 bracket boundary
    // with small-n heavy-tailed samples — that's exactly where the
    // permutation back-stop earns its keep — but pinning specific
    // boundary outcomes risks RNG-seed flake. The G5 kernel's own
    // tests (`correlationPermutation.test.ts` Welch-vs-permutation
    // consistency block) cover the extremes too; this composition
    // confirms the agreement carries through the gate.

    it('large clear effect: both Welch and permutation flag significant; tag visible', () => {
      const cited = [10, 11, 12, 10, 11, 12, 10, 11, 12]; // cited.length = 9 ≥ 5
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
        evidenceLength: cited.length,
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
      // G2 hides the tag. (cited.length = 10 ≥ 5, so this is the
      // below-significance path — not insufficient-evidence.)
      const visibility = evaluateCorrelationTagVisibility({
        stat: { t: welch.t, valid: welch.valid },
        evidenceLength: cited.length,
      });
      expect(visibility.visible).toBe(false);
    });
  });
});
