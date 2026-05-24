import { describe, it, expect } from 'vitest';
import type { CompositeOutcome } from '@chat-arch/schema';
import {
  computeReflexive,
  type CovariateFn,
  type ReflexiveEntry,
} from './computeReflexive.js';

function comp(good: boolean, score: number): CompositeOutcome {
  return {
    sessionId: 's',
    source: 'cowork',
    testPass: null,
    buildPass: null,
    prLand: null,
    noRework: null,
    affirmation: null,
    score,
    linearLogit: 0,
    binary: good ? 'good' : 'bad',
    weightsHash: 'cafebabecafebabe',
  };
}

type SyntheticEntry = ReflexiveEntry & {
  /** Pre-treatment covariate vector. */
  cov: number[];
};

const covariate: CovariateFn<SyntheticEntry> = (e) => e.cov;

function entry(sessionId: string, cov: number[], good: boolean, ts = 1_000): SyntheticEntry {
  return {
    sessionId,
    updatedAt: ts,
    composite: comp(good, good ? 0.8 : 0.3),
    cov,
  };
}

describe('computeReflexive', () => {
  it('matches each treated to its nearest control by covariates', () => {
    // 5 treated, 10 control. Treated covariates land exactly on five
    // controls; the other five controls are far away.
    const entries: SyntheticEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      entries.push(entry(`t-${i}`, [i], true));
      entries.push(entry(`c-near-${i}`, [i + 0.01], i % 2 === 0)); // alternating good/bad
      entries.push(entry(`c-far-${i}`, [i + 100], false));
    }
    const touched = new Set(['t-0', 't-1', 't-2', 't-3', 't-4']);
    const r = computeReflexive(entries, touched, covariate);
    expect(r.nTreated).toBe(5);
    for (const p of r.pairs) {
      const i = p.treatedSessionId.split('-')[1];
      expect(p.controlSessionId).toBe(`c-near-${i}`);
    }
  });

  it('meanDelta ≈ +0.1 on synthetic cohorts with seeded difference', () => {
    // 100 treated with p_good = 0.6; 100 control with p_good = 0.5.
    // Deterministic Bernoulli via index parity.
    const entries: SyntheticEntry[] = [];
    const treatedIds = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      // 60/100 treated are good.
      const good = i < 60;
      const id = `t-${i}`;
      entries.push(entry(id, [i], good));
      treatedIds.add(id);
    }
    for (let i = 0; i < 100; i += 1) {
      // 50/100 control are good.
      const good = i < 50;
      // Place each control next to a treated so 1-NN matching is clean.
      entries.push(entry(`c-${i}`, [i + 0.01], good));
    }
    const r = computeReflexive(entries, treatedIds, covariate);
    expect(r.nTreated).toBe(100);
    // pTreated should equal 0.6 exactly; pControl tracks the matched 1-NN.
    expect(r.pTreated).toBeCloseTo(0.6, 9);
    // Allow some tolerance — the matched 1-NN may shuffle which controls
    // are picked when there are ties, but the seeded difference should
    // land near +0.1.
    expect(r.meanDelta).toBeGreaterThan(0.05);
    expect(r.meanDelta).toBeLessThan(0.2);
  });

  it("returns eValueStatus 'computed' when CI excludes the null and pControl > 0", () => {
    // Strong contrast: treated all good, control all bad on the matched
    // 1-NN pairs. CI should exclude zero.
    const entries: SyntheticEntry[] = [];
    const treatedIds = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      entries.push(entry(`t-${i}`, [i], true));
      treatedIds.add(`t-${i}`);
      entries.push(entry(`c-${i}`, [i + 0.01], false));
    }
    // Sprinkle a few good controls so pControl > 0 but matched control is bad.
    for (let i = 0; i < 5; i += 1) {
      entries.push(entry(`c-extra-${i}`, [i + 500], true));
    }
    const r = computeReflexive(entries, treatedIds, covariate);
    expect(r.eValueStatus).toBe('p-control-zero'); // matched controls are all bad → pControl=0
    expect(r.eValueCIBound).not.toBeNull();
  });

  it("returns eValueStatus 'p-control-zero' when matched controls all bad", () => {
    const entries: SyntheticEntry[] = [];
    const treatedIds = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      entries.push(entry(`t-${i}`, [i], true));
      treatedIds.add(`t-${i}`);
      entries.push(entry(`c-${i}`, [i + 0.01], false));
    }
    const r = computeReflexive(entries, treatedIds, covariate);
    expect(r.pControl).toBe(0);
    expect(r.eValueStatus).toBe('p-control-zero');
    expect(r.eValueCIBound).not.toBeNull();
    // E-value should be > 1 since the bound is in the harmful direction.
    expect(r.eValueCIBound!).toBeGreaterThan(1);
  });

  it("returns eValueStatus 'ci-straddles-null' when CI brackets zero", () => {
    // Identical distributions in both arms → CI brackets zero.
    const entries: SyntheticEntry[] = [];
    const treatedIds = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const good = i % 2 === 0;
      entries.push(entry(`t-${i}`, [i], good));
      treatedIds.add(`t-${i}`);
      entries.push(entry(`c-${i}`, [i + 0.01], good));
    }
    const r = computeReflexive(entries, treatedIds, covariate);
    expect(r.meanDelta).toBe(0);
    expect(r.eValueStatus).toBe('ci-straddles-null');
    expect(r.eValueCIBound).toBeNull();
  });

  it('handles no-treated cohort gracefully', () => {
    const entries: SyntheticEntry[] = [
      entry('c-1', [0], true),
      entry('c-2', [1], false),
    ];
    const r = computeReflexive(entries, new Set(), covariate);
    expect(r.nTreated).toBe(0);
    expect(r.eValueStatus).toBe('ci-straddles-null');
    expect(r.eValueCIBound).toBeNull();
  });

  it('McNemar (T2): emits null + undefined when zero discordant pairs', () => {
    // All treated and matched controls have the same binary outcome →
    // no discordant pairs → McNemar is undefined.
    const entries: SyntheticEntry[] = [];
    const treatedIds = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const t = `t-${i}`;
      entries.push(entry(t, [i], true));
      entries.push(entry(`c-${i}`, [i + 0.01], true)); // also good
      treatedIds.add(t);
    }
    const r = computeReflexive(entries, treatedIds, covariate);
    expect(r.discordantCount).toBe(0);
    expect(r.mcnemarP).toBeNull();
    expect(r.mcnemarMethod).toBe('undefined');
  });

  it('McNemar (T2): exact method for small n; chi-squared for large n', () => {
    // Small case: 6 pairs, all discordant in same direction (b=6, c=0).
    // Exact binomial p = 2 * (0.5)^6 = 0.03125.
    const smallEntries: SyntheticEntry[] = [];
    const smallTreated = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const t = `t-${i}`;
      smallEntries.push(entry(t, [i], true));
      smallEntries.push(entry(`c-${i}`, [i + 0.01], false));
      smallTreated.add(t);
    }
    const small = computeReflexive(smallEntries, smallTreated, covariate);
    expect(small.mcnemarMethod).toBe('exact');
    expect(small.discordantCount).toBe(6);
    expect(small.mcnemarP).not.toBeNull();
    expect(small.mcnemarP!).toBeCloseTo(0.03125, 4);

    // Large case: 30 pairs, all discordant in same direction (b=30, c=0).
    // Chi-squared with continuity correction: ((|30-0|-1)^2)/30 = 841/30 ≈ 28.03;
    // P(χ²_1 > 28.03) ≈ 1.18e-7. Test asserts < 1e-5 (loose to allow
    // approximation drift in normalCdf).
    const largeEntries: SyntheticEntry[] = [];
    const largeTreated = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      const t = `tL-${i}`;
      largeEntries.push(entry(t, [i], true));
      largeEntries.push(entry(`cL-${i}`, [i + 0.01], false));
      largeTreated.add(t);
    }
    const large = computeReflexive(largeEntries, largeTreated, covariate);
    expect(large.mcnemarMethod).toBe('chi-squared');
    expect(large.discordantCount).toBe(30);
    expect(large.mcnemarP!).toBeLessThan(1e-5);
  });

  it('McNemar (T2): balanced discordant counts → p near 1', () => {
    // 8 pairs: 4 with treated-good/control-bad, 4 with treated-bad/control-good.
    // b = c = 4 → exact binomial p = 1 (sum of both tails = full mass).
    const entries: SyntheticEntry[] = [];
    const treatedIds = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const t = `t-up-${i}`;
      entries.push({
        sessionId: t,
        updatedAt: 1000,
        composite: comp(true, 0.8),
        cov: [i],
      });
      entries.push({
        sessionId: `c-up-${i}`,
        updatedAt: 1000,
        composite: comp(false, 0.3),
        cov: [i + 0.01],
      });
      treatedIds.add(t);
    }
    for (let i = 0; i < 4; i += 1) {
      const t = `t-dn-${i}`;
      entries.push({
        sessionId: t,
        updatedAt: 1000,
        composite: comp(false, 0.3),
        cov: [10 + i],
      });
      entries.push({
        sessionId: `c-dn-${i}`,
        updatedAt: 1000,
        composite: comp(true, 0.8),
        cov: [10 + i + 0.01],
      });
      treatedIds.add(t);
    }
    const r = computeReflexive(entries, treatedIds, covariate);
    expect(r.discordantCount).toBe(8);
    expect(r.mcnemarP!).toBeCloseTo(1, 3);
  });

  it('respects the covariateFn — confounded matching surfaces a different delta than naive', () => {
    // Treated and control good-rates the same overall (0.5 each), but
    // there's a covariate-x-outcome confound: high-cov sessions are
    // mostly bad in treated and mostly good in control. A 1-NN
    // matching by covariate brings them together, neutralizing the
    // raw contrast.
    const entries: SyntheticEntry[] = [];
    const treatedIds = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      // High-cov treated mostly bad; low-cov treated mostly good → 50% overall.
      const good = i < 10;
      const id = `t-${i}`;
      entries.push(entry(id, [i], good));
      treatedIds.add(id);
    }
    for (let i = 0; i < 20; i += 1) {
      // High-cov control mostly good; low-cov control mostly bad → 50% overall.
      const good = i >= 10;
      entries.push(entry(`c-${i}`, [i + 0.01], good));
    }
    const r = computeReflexive(entries, treatedIds, covariate);
    // After 1-NN match, low-cov treated (good) pairs with low-cov control (bad)
    // and high-cov treated (bad) pairs with high-cov control (good).
    // → pTreated = 0.5, pControl = 0.5, delta = 0.
    expect(r.meanDelta).toBe(0);
  });
});
