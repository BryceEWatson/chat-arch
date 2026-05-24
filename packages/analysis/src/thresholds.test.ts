// Tests for Rev3 THRESHOLDS additions (sub-task A7 — narrativeRung,
// curator, closureC). The plan pins specific values for stat-rigor
// reasons; these tests freeze that contract so a casual edit doesn't
// silently break the joint-gate feasibility proof.

import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from './thresholds.js';

describe('THRESHOLDS.narrativeRung (Rev3 confidence ladder)', () => {
  it('exposes the three rung confidence floors in ascending order', () => {
    const { tier1, tier2, tier3 } = THRESHOLDS.narrativeRung;
    expect(tier1).toBeLessThan(tier2);
    expect(tier2).toBeLessThan(tier3);
    expect(tier1).toBeGreaterThan(0);
    expect(tier3).toBeLessThan(1);
  });

  it('exposes ascending supporting-count gates per rung', () => {
    const { tier1SupportingMin, tier2SupportingMin, tier3SupportingMin } =
      THRESHOLDS.narrativeRung;
    expect(tier1SupportingMin).toBeLessThanOrEqual(tier2SupportingMin);
    expect(tier2SupportingMin).toBeLessThanOrEqual(tier3SupportingMin);
    expect(tier1SupportingMin).toBeGreaterThanOrEqual(1);
  });

  it('tier-3 confidence + contradicting-cap gates are jointly satisfiable at the count-minimum', () => {
    // Plan §Confidence ladder: tier3 uses 0.66 (not 0.75) so the
    // confidence gate AND the contradicting cap are both satisfiable
    // at supporting=6, contradicting=1 with defaultPrior=2.
    //   confidence = 6 / (6 + 1 + 2) = 6/9 = 0.667
    //   contradicting cap = ceil(6 / contradictingCapDivisor)
    const {
      tier3,
      tier3SupportingMin,
      contradictingCapDivisor,
      defaultPrior,
    } = THRESHOLDS.narrativeRung;
    const supporting = tier3SupportingMin;
    const contradictingCap = Math.ceil(supporting / contradictingCapDivisor);
    const confidence = supporting / (supporting + contradictingCap + defaultPrior);
    expect(confidence).toBeGreaterThanOrEqual(tier3);
    // And the cap must allow ≥ 1 contradicting at the minimum
    // supporting — otherwise tier-3 is unreachable for any kernel
    // that ever surfaces a single counter-example.
    expect(contradictingCap).toBeGreaterThanOrEqual(1);
  });

  it('uncalibratedPrior makes tier-3 unreachable until a kernel is calibrated', () => {
    const { tier3, tier3SupportingMin, uncalibratedPrior } =
      THRESHOLDS.narrativeRung;
    // Even with maximum-feasible supporting and zero contradicting,
    // confidence = s / (s + 0 + uncalibratedPrior) must fall below
    // tier3. Test at supporting = 5 × tier3SupportingMin to give the
    // kernel substantial headroom.
    const supporting = tier3SupportingMin * 5;
    const confidence = supporting / (supporting + 0 + uncalibratedPrior);
    expect(confidence).toBeLessThan(tier3);
  });

  it('dismissDecay > 1 (re-emergence requires growth, not just stasis)', () => {
    expect(THRESHOLDS.narrativeRung.dismissDecay).toBeGreaterThan(1);
  });

  it('maxDismissals + maxRepromotionAttempts are positive ints', () => {
    const { maxDismissals, maxRepromotionAttempts, repromotionPenalty } =
      THRESHOLDS.narrativeRung;
    expect(Number.isInteger(maxDismissals) && maxDismissals > 0).toBe(true);
    expect(
      Number.isInteger(maxRepromotionAttempts) && maxRepromotionAttempts > 0,
    ).toBe(true);
    expect(repromotionPenalty).toBeGreaterThanOrEqual(0);
  });

  it('priorByKernel + minSessionsByKernel are empty at v1 (calibration not yet run)', () => {
    expect(Object.keys(THRESHOLDS.narrativeRung.priorByKernel)).toEqual([]);
    expect(Object.keys(THRESHOLDS.narrativeRung.minSessionsByKernel)).toEqual([]);
  });
});

describe('THRESHOLDS.curator (Rev3 curator / falsifier metrics)', () => {
  it('precision@k has a positive k and horizon, target in (0, 1)', () => {
    const { precisionAtKWindow, precisionAtKHorizonDays, precisionAtKTarget } =
      THRESHOLDS.curator;
    expect(precisionAtKWindow).toBeGreaterThan(0);
    expect(precisionAtKHorizonDays).toBeGreaterThan(0);
    expect(precisionAtKTarget).toBeGreaterThan(0);
    expect(precisionAtKTarget).toBeLessThan(1);
  });

  it('falsifierRejectionBracket is a [lo, hi] tuple with lo < hi, both in (0, 1)', () => {
    const [lo, hi] = THRESHOLDS.curator.falsifierRejectionBracket;
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(hi);
    expect(hi).toBeLessThan(1);
  });

  it('falsifier accuracy floor is in (0.5, 1) — under-the-coin-flip floors are nonsense', () => {
    const { falsifierAccuracyFloor } = THRESHOLDS.curator;
    expect(falsifierAccuracyFloor).toBeGreaterThan(0.5);
    expect(falsifierAccuracyFloor).toBeLessThan(1);
  });

  it('outcome-correlation significance is the two-sided α=0.05 z-critical or stricter', () => {
    // 1.96 is the two-sided α=0.05 normal critical value. Anything
    // smaller would let noise slip through to the SourceAttribution
    // tag and undermine the "correlation, not causation" disclosure.
    expect(
      THRESHOLDS.curator.outcomeCorrelationSignificance,
    ).toBeGreaterThanOrEqual(1.96);
  });

  it('outcome-correlation evidence-length floor is at least 5 (per iter-1 finding)', () => {
    expect(
      THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength,
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('THRESHOLDS.closureC (Rev3 applied-rule outcome watcher)', () => {
  it('watcher caps are positive: N sessions, wall-clock days, stale-project days', () => {
    const { watcherSessionsN, watcherWallClockDays, staleProjectDays } =
      THRESHOLDS.closureC;
    expect(watcherSessionsN).toBeGreaterThan(0);
    expect(watcherWallClockDays).toBeGreaterThan(0);
    expect(staleProjectDays).toBeGreaterThan(0);
  });

  it('staleProjectDays < watcherWallClockDays (stale-out must precede wall-clock close)', () => {
    // Otherwise a project that goes idle at day 31 still has the
    // watcher running until day 60 — no early-invalidation.
    const { watcherWallClockDays, staleProjectDays } = THRESHOLDS.closureC;
    expect(staleProjectDays).toBeLessThan(watcherWallClockDays);
  });
});
