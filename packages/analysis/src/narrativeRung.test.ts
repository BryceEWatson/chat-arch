// Tests for the Rev3-B B6 (computeConfidence) + B7 (effectivePrior
// fail-safe) + narrativeTier joint-gate helper + Rev3-D D1 saturation
// rule. The joint-gate feasibility constants come from
// `THRESHOLDS.narrativeRung` (pinned in PR #58); these tests freeze
// the contract so a future calibration edit can't silently invalidate
// the documented feasibility proof.

import { describe, it, expect } from 'vitest';

import {
  computeConfidence,
  effectivePriorForKernel,
  narrativePriorPenalty,
  narrativeSaturation,
  narrativeTier,
} from './narrativeRung.js';
import { THRESHOLDS } from './thresholds.js';

describe('computeConfidence (B6 — Bayesian Beta-posterior mean)', () => {
  it('returns supporting / (supporting + contradicting + prior)', () => {
    // Joint-gate feasibility proof from PR #58 / THRESHOLDS:
    // supporting=6, contradicting=1, prior=2 → 6/9 = 0.667 ≥ tier3 (0.66).
    expect(computeConfidence(6, 1, 2)).toBeCloseTo(6 / 9, 9);
    expect(computeConfidence(1, 0, 2)).toBeCloseTo(1 / 3, 9); // tier1=0.33
    expect(computeConfidence(3, 0, 3)).toBeCloseTo(0.5, 9); // tier2=0.5
  });

  it('returns 0 when supporting=0', () => {
    expect(computeConfidence(0, 5, 2)).toBe(0);
    expect(computeConfidence(0, 0, 2)).toBe(0);
  });

  it('approaches 1 as supporting dominates', () => {
    const c = computeConfidence(1000, 0, 2);
    expect(c).toBeGreaterThan(0.99);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('clamps to [0, 1] (defensive)', () => {
    const c = computeConfidence(100, 0, 2);
    expect(c).toBeLessThanOrEqual(1);
    expect(c).toBeGreaterThanOrEqual(0);
  });

  it('returns NaN on invalid inputs (negative counts, non-finite prior, prior<=0)', () => {
    expect(Number.isNaN(computeConfidence(-1, 0, 2))).toBe(true);
    expect(Number.isNaN(computeConfidence(0, -1, 2))).toBe(true);
    expect(Number.isNaN(computeConfidence(1, 0, 0))).toBe(true);
    expect(Number.isNaN(computeConfidence(1, 0, -2))).toBe(true);
    expect(Number.isNaN(computeConfidence(1, 0, Number.NaN))).toBe(true);
    expect(Number.isNaN(computeConfidence(1, 0, Number.POSITIVE_INFINITY))).toBe(true);
    expect(Number.isNaN(computeConfidence(Number.NaN, 0, 2))).toBe(true);
  });

  it('joint-gate feasibility at the count-minimum (PR #58 proof)', () => {
    // The tier-3 floor (0.66) was specifically chosen so that:
    //   supporting=tier3SupportingMin (6),
    //   contradicting=ceil(6/contradictingCapDivisor)=ceil(6/6)=1,
    //   prior=defaultPrior (2)
    // both pass the confidence gate AND the contradicting-cap gate.
    // This test fails loudly if a future calibration breaks that.
    const { tier3, tier3SupportingMin, contradictingCapDivisor, defaultPrior } =
      THRESHOLDS.narrativeRung;
    const supporting = tier3SupportingMin;
    const contradicting = Math.ceil(supporting / contradictingCapDivisor);
    const confidence = computeConfidence(supporting, contradicting, defaultPrior);
    expect(confidence).toBeGreaterThanOrEqual(tier3);
  });
});

describe('effectivePriorForKernel (B7 — calibration fail-safe)', () => {
  it('returns uncalibratedPrior when calibrationCompletedAt is null', () => {
    expect(
      effectivePriorForKernel({
        kernel: 'kernel-x',
        calibrationCompletedAt: null,
      }),
    ).toBe(THRESHOLDS.narrativeRung.uncalibratedPrior);
  });

  it('returns uncalibratedPrior when calibrationCompletedAt is undefined', () => {
    expect(
      effectivePriorForKernel({
        kernel: 'kernel-x',
        calibrationCompletedAt: undefined,
      }),
    ).toBe(THRESHOLDS.narrativeRung.uncalibratedPrior);
  });

  it('returns defaultPrior for a calibrated kernel without a per-kernel override', () => {
    // priorByKernel is empty at v1 per THRESHOLDS, so any kernel name
    // falls through to the default.
    expect(
      effectivePriorForKernel({
        kernel: 'never-overridden',
        calibrationCompletedAt: 1_700_000_000_000,
      }),
    ).toBe(THRESHOLDS.narrativeRung.defaultPrior);
  });

  it('uncalibrated prior makes tier-3 unreachable even at substantial supporting count', () => {
    // PR #58 contract: uncalibratedPrior=20 should make tier-3 unreachable
    // even at supporting=5x tier3SupportingMin (30) with 0 contradicting.
    //   confidence = 30 / (30 + 0 + 20) = 0.6 < tier3 (0.66)
    const prior = effectivePriorForKernel({
      kernel: 'k',
      calibrationCompletedAt: null,
    });
    const supporting = THRESHOLDS.narrativeRung.tier3SupportingMin * 5;
    const confidence = computeConfidence(supporting, 0, prior);
    expect(confidence).toBeLessThan(THRESHOLDS.narrativeRung.tier3);
  });
});

describe('narrativeTier (joint-gate dispatch)', () => {
  it('returns 0 when no tier is reachable', () => {
    // supporting=0 fails tier1's count gate (min=1) → tier 0.
    expect(narrativeTier(0.5, 0, 0)).toBe(0);
    // confidence below tier1 floor → tier 0 regardless of counts.
    expect(narrativeTier(0.1, 100, 0)).toBe(0);
  });

  it('returns 1 at the tier-1 minimum (supporting=1, confidence=tier1)', () => {
    const { tier1, tier1SupportingMin } = THRESHOLDS.narrativeRung;
    expect(narrativeTier(tier1, tier1SupportingMin, 0)).toBe(1);
  });

  it('returns 2 at the tier-2 minimum', () => {
    const { tier2, tier2SupportingMin } = THRESHOLDS.narrativeRung;
    expect(narrativeTier(tier2, tier2SupportingMin, 0)).toBe(2);
  });

  it('returns 3 at the tier-3 minimum with contradicting at the cap', () => {
    // The PR #58 joint-gate proof. supporting=6, contradicting=1 (cap),
    // confidence=0.667 (above floor 0.66).
    const { tier3, tier3SupportingMin, contradictingCapDivisor } =
      THRESHOLDS.narrativeRung;
    const supporting = tier3SupportingMin;
    const contradicting = Math.ceil(supporting / contradictingCapDivisor);
    // Use a confidence just above tier3 floor.
    expect(narrativeTier(tier3 + 0.001, supporting, contradicting)).toBe(3);
  });

  it('degrades from tier-3 to tier-2 when contradicting exceeds the cap', () => {
    // Same supporting=6 confidence>tier3, but contradicting=2 exceeds
    // cap of 1 → contradicting-cap gate fails → fall through to tier-2.
    expect(narrativeTier(0.7, 6, 2)).toBe(2);
  });

  it('returns 0 on invalid inputs', () => {
    expect(narrativeTier(Number.NaN, 5, 0)).toBe(0);
    expect(narrativeTier(0.5, Number.NaN, 0)).toBe(0);
    expect(narrativeTier(0.5, 5, Number.NaN)).toBe(0);
    expect(narrativeTier(-0.1, 5, 0)).toBe(0);
    expect(narrativeTier(1.1, 5, 0)).toBe(0);
    expect(narrativeTier(0.5, -1, 0)).toBe(0);
    expect(narrativeTier(0.5, 5, -1)).toBe(0);
  });

  it('end-to-end: uncalibrated kernel unreachable to tier-3 at the count-minimum and moderately above', () => {
    // The uncalibratedPrior protects against COLD-START — a kernel
    // that just started running can't promote a finding to tier-3 on
    // its first few observations. At extremely high supporting counts
    // (hundreds), the prior gets dominated by evidence — by design,
    // since at that scale the cold-start risk is over. Test the
    // load-bearing range: tier3SupportingMin through 5× minimum.
    const prior = effectivePriorForKernel({
      kernel: 'k',
      calibrationCompletedAt: null,
    });
    const min = THRESHOLDS.narrativeRung.tier3SupportingMin;
    for (const supporting of [min, min * 2, min * 3, min * 5]) {
      const confidence = computeConfidence(supporting, 0, prior);
      expect(narrativeTier(confidence, supporting, 0)).toBeLessThan(3);
    }
  });

  it('end-to-end: calibrated kernel + tier-3 minimum count reaches tier 3', () => {
    const prior = effectivePriorForKernel({
      kernel: 'k',
      calibrationCompletedAt: 1_700_000_000_000,
    });
    const supporting = THRESHOLDS.narrativeRung.tier3SupportingMin;
    const contradicting = Math.ceil(
      supporting / THRESHOLDS.narrativeRung.contradictingCapDivisor,
    );
    const confidence = computeConfidence(supporting, contradicting, prior);
    expect(narrativeTier(confidence, supporting, contradicting)).toBe(3);
  });

  // ---- V1 narrative-mining tier-cap (spec §"V1 tier-cap rule") ----
  // When opts.attributedTo === 'llm-derived', tier is clamped to ≤ 2.
  // Unconditional in V1; removed in V1.1 when the contrary-evidence
  // finder lands.

  it('V1 cap: clamps LLM-derived row to tier-2 even at would-be-tier-3 confidence', () => {
    // supporting=6, contradicting=1, prior=2 → confidence 6/9 ≈ 0.667
    // which would clear tier3 (0.66) AND tier3SupportingMin (6) AND
    // contradicting-cap (ceil(6/6)=1). Without opts the row reaches
    // tier 3.
    const supporting = THRESHOLDS.narrativeRung.tier3SupportingMin;
    const contradicting = 1;
    const confidence = 0.667;
    expect(narrativeTier(confidence, supporting, contradicting)).toBe(3);
    // With opts.attributedTo === 'llm-derived' the cap clamps to 2.
    expect(
      narrativeTier(confidence, supporting, contradicting, {
        attributedTo: 'llm-derived',
      }),
    ).toBe(2);
  });

  it('V1 cap: deterministic attribution does NOT trigger the clamp', () => {
    const supporting = THRESHOLDS.narrativeRung.tier3SupportingMin;
    const contradicting = 1;
    const confidence = 0.667;
    expect(
      narrativeTier(confidence, supporting, contradicting, {
        attributedTo: 'deterministic',
      }),
    ).toBe(3);
    expect(
      narrativeTier(confidence, supporting, contradicting, {
        attributedTo: 'deterministic-with-prior',
      }),
    ).toBe(3);
  });

  it('V1 cap: legacy callers without opts param behave identically to today', () => {
    // Back-compat: every call shape exercised above without opts must
    // continue to produce the same tier. This freezes the contract.
    expect(narrativeTier(0.5, 0, 0)).toBe(0);
    expect(narrativeTier(0.1, 100, 0)).toBe(0);
    expect(narrativeTier(0.67, 6, 1)).toBe(3);
  });

  it('V1 cap: LLM-derived row at tier-2 stays at tier-2 (cap inactive when tier already ≤ 2)', () => {
    // confidence=0.5, supporting=2, prior=2 → exactly the tier-2 floor
    // (the modal V1 LLM emission per spec §"Confidence ladder").
    expect(
      narrativeTier(0.5, 2, 0, { attributedTo: 'llm-derived' }),
    ).toBe(2);
  });

  it('V1 cap: falsifier-verified row is NOT capped (kept at its computed tier)', () => {
    // Spec §"V1 tier-cap rule": the cap clause is ONLY active on
    // attributedTo === 'llm-derived'. A row that has subsequently
    // graduated to 'falsifier-verified' bypasses the cap. (Note:
    // V1 doesn't yet emit falsifier-verified rows; this freezes the
    // signature for V1.1.)
    expect(
      narrativeTier(0.667, 6, 1, { attributedTo: 'falsifier-verified' }),
    ).toBe(3);
  });
});

describe('narrativeSaturation (D1 — Closure B saturation rule)', () => {
  const r = THRESHOLDS.narrativeRung;
  const base = THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;

  it('dismissalCount=0 returns the base multiplier and is not shelved', () => {
    const s = narrativeSaturation(0);
    expect(s.multiplier).toBe(base);
    expect(s.shelved).toBe(false);
    expect(s.dismissalsConsumed).toBe(0);
    expect(s.cap).toBe(r.maxDismissals);
  });

  it('each dismissal multiplies the bar by dismissDecay', () => {
    // The doubling sequence the THRESHOLDS comment documents:
    // 0 dismissals → base; 1 → base×decay; 2 → base×decay²; etc.
    for (let k = 0; k < r.maxDismissals; k += 1) {
      const expected = base * Math.pow(r.dismissDecay, k);
      const s = narrativeSaturation(k);
      expect(s.multiplier).toBeCloseTo(expected, 9);
      expect(s.shelved).toBe(false);
      expect(s.dismissalsConsumed).toBe(k);
    }
  });

  it('reaching maxDismissals shelves the entity (multiplier=null)', () => {
    const s = narrativeSaturation(r.maxDismissals);
    expect(s.shelved).toBe(true);
    expect(s.multiplier).toBeNull();
    expect(s.dismissalsConsumed).toBe(r.maxDismissals);
  });

  it('dismissalCount above the cap clamps to maxDismissals + stays shelved', () => {
    const s = narrativeSaturation(r.maxDismissals + 5);
    expect(s.shelved).toBe(true);
    expect(s.multiplier).toBeNull();
    expect(s.dismissalsConsumed).toBe(r.maxDismissals);
  });

  it('floors fractional dismissalCount before comparison', () => {
    // A ledger row corrupted by an off-spec writer that stored a
    // fractional counter should not silently shelve early.
    const fractionalJustUnderCap = r.maxDismissals - 0.1;
    const s = narrativeSaturation(fractionalJustUnderCap);
    expect(s.shelved).toBe(false);
    expect(s.dismissalsConsumed).toBe(Math.floor(fractionalJustUnderCap));
    expect(s.multiplier).toBeCloseTo(
      base * Math.pow(r.dismissDecay, s.dismissalsConsumed),
      9,
    );
  });

  it('negative / non-finite dismissalCount collapses to baseline (defensive)', () => {
    for (const bad of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const s = narrativeSaturation(bad);
      expect(s.multiplier).toBe(base);
      expect(s.shelved).toBe(false);
      expect(s.dismissalsConsumed).toBe(0);
    }
  });

  it('THRESHOLDS contract — saturation values are tunable but the shape is locked', () => {
    // dismissDecay must be > 1 (otherwise the bar never increases —
    // confirms the same invariant the THRESHOLDS test asserts, but
    // from the saturation kernel's perspective).
    expect(r.dismissDecay).toBeGreaterThan(1);
    // maxDismissals must be a positive integer (the saturation rule
    // would silently always-shelve at 0).
    expect(Number.isInteger(r.maxDismissals) && r.maxDismissals > 0).toBe(
      true,
    );
    // The base growth multiplier must be > 1 (otherwise re-promotion
    // would fire as soon as size hits the snapshot — no growth).
    expect(base).toBeGreaterThan(1);
  });
});

describe('narrativePriorPenalty (D2 — per-Narrative family-wise correction)', () => {
  const penalty = THRESHOLDS.narrativeRung.repromotionPenalty;

  it('returns 0 for dismissalCount=0 (no penalty before any dismissal)', () => {
    expect(narrativePriorPenalty(0)).toBe(0);
  });

  it('returns N × repromotionPenalty for positive integer N', () => {
    for (let k = 1; k <= 5; k += 1) {
      expect(narrativePriorPenalty(k)).toBe(k * penalty);
    }
  });

  it('floors fractional dismissalCount before multiplication', () => {
    expect(narrativePriorPenalty(2.9)).toBe(2 * penalty);
    expect(narrativePriorPenalty(1.01)).toBe(1 * penalty);
  });

  it('returns 0 on negative / non-finite inputs (defensive)', () => {
    for (const bad of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(narrativePriorPenalty(bad)).toBe(0);
    }
  });

  it('composes additively with effectivePriorForKernel', () => {
    // Plan-stated composition: totalPrior = basePrior + N×penalty.
    const basePrior = effectivePriorForKernel({
      kernel: 'k',
      calibrationCompletedAt: 1_700_000_000_000,
    });
    const dismissals = 3;
    const totalPrior = basePrior + narrativePriorPenalty(dismissals);
    expect(totalPrior).toBe(basePrior + dismissals * penalty);

    // The composed prior stiffens the Bayesian threshold: confidence
    // falls monotonically as dismissals accumulate (same supporting +
    // contradicting inputs). Skip the strict-inequality assertion if
    // a future calibration sets `repromotionPenalty=0` — that disables
    // the family-wise correction by design; the test should not
    // wrongly flag the disabled-state as broken.
    const supporting = 6;
    const contradicting = 1;
    const baseConfidence = computeConfidence(
      supporting,
      contradicting,
      basePrior,
    );
    const penalizedConfidence = computeConfidence(
      supporting,
      contradicting,
      totalPrior,
    );
    if (penalty > 0) {
      expect(penalizedConfidence).toBeLessThan(baseConfidence);
    } else {
      expect(penalizedConfidence).toBe(baseConfidence);
    }
  });

  it('still returns a defined penalty in the shelved regime (>= maxDismissals)', () => {
    // The JSDoc promises the function remains well-defined past the
    // saturation cap so the D3 audit table can render "if this
    // un-shelved, the prior would be X." Verify the contract holds
    // both at the cap and well above it.
    const cap = THRESHOLDS.narrativeRung.maxDismissals;
    expect(narrativePriorPenalty(cap)).toBe(cap * penalty);
    expect(narrativePriorPenalty(cap + 5)).toBe((cap + 5) * penalty);
  });

  it('THRESHOLDS contract — repromotionPenalty is non-negative finite', () => {
    expect(Number.isFinite(penalty) && penalty >= 0).toBe(true);
  });
});
