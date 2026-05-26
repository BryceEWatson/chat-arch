// Tests for Rev3 THRESHOLDS additions (sub-task A7 — narrativeRung,
// curator, appliedRuleWatcher). The plan pins specific values for
// stat-rigor reasons; these tests freeze that contract so a casual
// edit doesn't silently break the joint-gate feasibility proof.

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

  it('maxDismissals is a positive int + repromotionPenalty is non-negative', () => {
    const { maxDismissals, repromotionPenalty } = THRESHOLDS.narrativeRung;
    expect(Number.isInteger(maxDismissals) && maxDismissals > 0).toBe(true);
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

describe('THRESHOLDS.persona (per-project persona generation V1)', () => {
  // Smoke checks — these catch typos so egregious they'd break every
  // consumer immediately. The real V1→V2 calibration harness lives
  // separately (cite-overlap-on-shared-patterns between bryce.md and
  // the auto-gen output once mine-persona runs against the same
  // corpus).

  it('minSessionsForGeneration ≥ 1 (no thin personas)', () => {
    expect(THRESHOLDS.persona.minSessionsForGeneration).toBeGreaterThanOrEqual(1);
  });

  it('maxSessionsForCorpus ≥ minSessionsForGeneration (cap must accommodate the floor)', () => {
    const { minSessionsForGeneration, maxSessionsForCorpus } = THRESHOLDS.persona;
    expect(maxSessionsForCorpus).toBeGreaterThanOrEqual(minSessionsForGeneration);
  });

  it('maxLlmUsdPerProject > 0 (a $0 cap would skip every project)', () => {
    expect(THRESHOLDS.persona.maxLlmUsdPerProject).toBeGreaterThan(0);
  });

  it('maxSessionsForCorpus divisible by 4 (4-quartile stratified sample takes maxN/4 from each bucket)', () => {
    // The Stage-1 stratified sampler splits the project's session list
    // into 4 recency quartiles and draws maxSessionsForCorpus/4 from
    // each. A cap not divisible by 4 means one bucket carries an
    // off-by-one — survivable, but worth catching when someone tunes
    // the cap.
    expect(THRESHOLDS.persona.maxSessionsForCorpus % 4).toBe(0);
  });

  it('candidateBudgetProxy ≈ 6 buckets × maxCandidatesPerBucket (budget arithmetic balanced)', () => {
    // Stage-2 sees at most 6 buckets × maxCandidatesPerBucket
    // candidates per project. The budget proxy gates skip-on-overflow
    // and should track that ceiling so the documented relationship is
    // self-consistent.
    const { candidateBudgetProxy, maxCandidatesPerBucket } = THRESHOLDS.persona;
    const ceiling = 6 * maxCandidatesPerBucket;
    expect(candidateBudgetProxy).toBeGreaterThanOrEqual(ceiling * 0.5);
    expect(candidateBudgetProxy).toBeLessThanOrEqual(ceiling * 10);
  });
});

describe('THRESHOLDS.narrative (per-project narrative-mining V1)', () => {
  it('minSessionsForLlm ≥ 1 (no thin LLM stage)', () => {
    expect(THRESHOLDS.narrative.minSessionsForLlm).toBeGreaterThanOrEqual(1);
  });

  it('maxSessionsForCorpus ≥ minSessionsForLlm (cap must accommodate the floor)', () => {
    const { minSessionsForLlm, maxSessionsForCorpus } = THRESHOLDS.narrative;
    expect(maxSessionsForCorpus).toBeGreaterThanOrEqual(minSessionsForLlm);
  });

  it('maxSessionsForCorpus divisible by 4 (4-quartile stratified sampler)', () => {
    expect(THRESHOLDS.narrative.maxSessionsForCorpus % 4).toBe(0);
  });

  it('maxLlmUsdPerProject > 0 (a $0 cap would skip every project)', () => {
    expect(THRESHOLDS.narrative.maxLlmUsdPerProject).toBeGreaterThan(0);
  });

  it('minPerProject ≤ maxPerProject (count bounds well-ordered)', () => {
    const { minPerProject, maxPerProject } = THRESHOLDS.narrative;
    expect(minPerProject).toBeLessThanOrEqual(maxPerProject);
    expect(minPerProject).toBeGreaterThanOrEqual(1);
  });

  it('evidenceMinPerNarrative ≥ 2 (single-session narratives are anecdotes, not themes)', () => {
    expect(THRESHOLDS.narrative.evidenceMinPerNarrative).toBeGreaterThanOrEqual(2);
  });

  it('maxCandidatesPerRecencyBucket > 0', () => {
    expect(THRESHOLDS.narrative.maxCandidatesPerRecencyBucket).toBeGreaterThan(0);
  });

  it('narrative block does NOT expose candidateBudgetProxy in V1 (deliberately absent — see spec)', () => {
    // Persona has it; narrative does NOT. Iter-4 spec audit found the
    // proxy unreachable as designed (200 sessions × 1 candidate/session
    // < proxy=1200). Re-introduce in V1.1 once per-recency-bucket
    // candidate counts justify the bound.
    expect(
      (THRESHOLDS.narrative as Record<string, unknown>)['candidateBudgetProxy'],
    ).toBeUndefined();
  });
});

describe('THRESHOLDS.appliedRuleWatcher (Rev3 applied-rule outcome watcher — Closure C)', () => {
  it('watcher caps are positive: N sessions, wall-clock days, stale-project days', () => {
    const { watcherSessionsN, watcherWallClockDays, staleProjectDays } =
      THRESHOLDS.appliedRuleWatcher;
    expect(watcherSessionsN).toBeGreaterThan(0);
    expect(watcherWallClockDays).toBeGreaterThan(0);
    expect(staleProjectDays).toBeGreaterThan(0);
  });

  it('staleProjectDays < watcherWallClockDays (stale-out must precede wall-clock close)', () => {
    // Otherwise a project that goes idle at day 31 still has the
    // watcher running until day 60 — no early-invalidation.
    const { watcherWallClockDays, staleProjectDays } = THRESHOLDS.appliedRuleWatcher;
    expect(staleProjectDays).toBeLessThan(watcherWallClockDays);
  });
});
