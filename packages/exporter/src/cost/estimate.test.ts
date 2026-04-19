import { describe, it, expect } from 'vitest';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import {
  RATE_TABLE,
  DEFAULT_MODEL_ID,
  estimateCost,
  pickModelForRate,
  collectUnknownModels,
} from './estimate.js';

// Canonical hand-calculated ground truth for AC2. All five canonical sessions
// use token counts pulled from `apps/standalone/public/chat-arch-data/manifest.json`.
// Hand-math is in the test body. Tolerance: ±2% per `[R-AC2]`.
//
// Source: Opus rates are $15/$75/$18.75/$1.50 per 1M for
// input/output/cacheWrite/cacheRead. claude-opus-4-6 and claude-opus-4-7 share
// rates so ground truth is stable across both.

function baseEntry(
  overrides: Partial<UnifiedSessionEntry>,
): Pick<UnifiedSessionEntry, 'totalCostUsd' | 'tokenTotals' | 'model' | 'modelsUsed'> {
  return {
    totalCostUsd: null,
    model: null,
    ...overrides,
  } as Pick<UnifiedSessionEntry, 'totalCostUsd' | 'tokenTotals' | 'model' | 'modelsUsed'>;
}

describe('RATE_TABLE coverage (AC1)', () => {
  it('covers the required minimum 6 models from the revised plan', () => {
    const required = [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-5-sonnet-20241022',
    ];
    for (const m of required) {
      expect(RATE_TABLE.rates[m], `missing rate for ${m}`).toBeDefined();
      const r = RATE_TABLE.rates[m]!;
      expect(r.inputPerM).toBeGreaterThan(0);
      expect(r.outputPerM).toBeGreaterThan(0);
      // Cache fields required by Decision 3.
      expect(r.cacheWritePerM).toBeGreaterThan(0);
      expect(r.cacheReadPerM).toBeGreaterThan(0);
    }
  });

  it('declares the default model (Q2 override: claude-opus-4-6)', () => {
    expect(DEFAULT_MODEL_ID).toBe('claude-opus-4-6');
    expect(RATE_TABLE.rates[DEFAULT_MODEL_ID]).toBeDefined();
  });
});

describe('estimateCost — exact cost path', () => {
  it('returns totalCostUsd unchanged when present, costIsEstimate=false', () => {
    const r = estimateCost(
      baseEntry({
        totalCostUsd: 12.34,
        tokenTotals: {
          input: 100,
          output: 200,
          cacheCreation: 0,
          cacheRead: 0,
        },
        modelsUsed: ['claude-opus-4-7'],
      }),
    );
    expect(r.costEstimatedUsd).toBe(12.34);
    expect(r.costIsEstimate).toBe(false);
    expect(r.breakdown).toBeUndefined();
  });

  it('AC3: exact wins even when model is unknown', () => {
    const r = estimateCost(baseEntry({ totalCostUsd: 5.0, model: 'no-such-model' }));
    expect(r.costEstimatedUsd).toBe(5.0);
    expect(r.costIsEstimate).toBe(false);
  });
});

describe('estimateCost — AC2 canonical sessions (hand-calc within ±2%)', () => {
  // Session 825350ad-...: Opus 4.7
  // input=478, output=375328, cacheCreation=1505286, cacheRead=28855031
  // Hand-math (Opus rates): input=478*15/1e6 = $0.00717
  //   output=375328*75/1e6 = $28.1496
  //   cacheWrite=1505286*18.75/1e6 = $28.2241
  //   cacheRead=28855031*1.5/1e6 = $43.2825
  //   total ≈ $99.663
  it('825350ad — Opus 4.7, cli-desktop', () => {
    const r = estimateCost(
      baseEntry({
        model: 'claude-opus-4-7',
        modelsUsed: ['claude-opus-4-7'],
        tokenTotals: {
          input: 478,
          output: 375328,
          cacheCreation: 1505286,
          cacheRead: 28855031,
        },
      }),
    );
    expect(r.costIsEstimate).toBe(true);
    expect(r.costEstimatedUsd).not.toBeNull();
    const est = r.costEstimatedUsd!;
    const expected = 99.663;
    expect(Math.abs(est - expected) / expected).toBeLessThan(0.02);
    expect(r.breakdown?.modelIdUsed).toBe('claude-opus-4-7');
  });

  // Session 5699e762: Opus 4.7
  // input=796, output=110758, cacheCreation=255965, cacheRead=7865996
  // Hand-math: 796*15/1e6=$0.01194, 110758*75/1e6=$8.30685,
  //   255965*18.75/1e6=$4.79934, 7865996*1.5/1e6=$11.79899
  //   total ≈ $24.9171
  it('5699e762 — Opus 4.7, cli-desktop', () => {
    const r = estimateCost(
      baseEntry({
        model: 'claude-opus-4-7',
        modelsUsed: ['claude-opus-4-7'],
        tokenTotals: {
          input: 796,
          output: 110758,
          cacheCreation: 255965,
          cacheRead: 7865996,
        },
      }),
    );
    const est = r.costEstimatedUsd!;
    const expected = 24.917;
    expect(Math.abs(est - expected) / expected).toBeLessThan(0.02);
  });

  // Session 233318ec — Opus 4.6, cli-direct.
  // input=2081, output=17966, cacheCreation=129601, cacheRead=696364
  // Hand-math: 2081*15/1e6=$0.031215, 17966*75/1e6=$1.34745,
  //   129601*18.75/1e6=$2.4300, 696364*1.5/1e6=$1.04455
  //   total ≈ $4.853
  it('233318ec — Opus 4.6, cli-direct', () => {
    const r = estimateCost(
      baseEntry({
        model: 'claude-opus-4-6',
        modelsUsed: ['claude-opus-4-6'],
        tokenTotals: {
          input: 2081,
          output: 17966,
          cacheCreation: 129601,
          cacheRead: 696364,
        },
      }),
    );
    const est = r.costEstimatedUsd!;
    const expected = 4.853;
    expect(Math.abs(est - expected) / expected).toBeLessThan(0.02);
  });

  // Session 1a9a5233 — Opus 4.7, cli-desktop (the near-duplicate of 5699e762).
  // input=26, output=2583, cacheCreation=120161, cacheRead=313367
  // Hand-math (Opus rates): 26*15/1e6=$0.00039, 2583*75/1e6=$0.193725,
  //   120161*18.75/1e6=$2.25302, 313367*1.5/1e6=$0.47005
  //   total ≈ $2.9172
  it('1a9a5233 — Opus 4.7, cli-desktop', () => {
    const r = estimateCost(
      baseEntry({
        model: 'claude-opus-4-7',
        modelsUsed: ['claude-opus-4-7'],
        tokenTotals: {
          input: 26,
          output: 2583,
          cacheCreation: 120161,
          cacheRead: 313367,
        },
      }),
    );
    expect(r.costIsEstimate).toBe(true);
    const est = r.costEstimatedUsd!;
    const expected = 2.9172;
    expect(Math.abs(est - expected) / expected).toBeLessThan(0.02);
    expect(r.breakdown?.modelIdUsed).toBe('claude-opus-4-7');
  });

  // Cowork session f5c0f3df-… — "Deep competitor analysis", Opus 4.6, totalCostUsd
  // populated by Cowork runtime. The exact-cost short-circuit (AC3) says
  // `totalCostUsd` always wins when present. Ground truth = totalCostUsd
  // itself; estimatedUsd must match exactly (not ±2%).
  it('f5c0f3df (Cowork) — exact-cost short-circuit ($149.11316735)', () => {
    const r = estimateCost(
      baseEntry({
        totalCostUsd: 149.11316735,
        model: 'claude-opus-4-6',
        modelsUsed: ['claude-opus-4-6', 'claude-haiku-4-5-20251001'],
        tokenTotals: {
          // Not used on the exact-cost path, but included to mirror the
          // real Cowork session's shape.
          input: 1000,
          output: 1000,
          cacheCreation: 0,
          cacheRead: 0,
        },
      }),
    );
    expect(r.costIsEstimate).toBe(false);
    expect(r.costEstimatedUsd).toBe(149.11316735);
    expect(r.breakdown).toBeUndefined();
  });
});

describe('estimateCost — unknown model', () => {
  it('returns null cost (not $0) and surfaces unknownModelId — Decision 3', () => {
    const r = estimateCost(
      baseEntry({
        model: 'claude-made-up-model-9000',
        modelsUsed: ['claude-made-up-model-9000'],
        tokenTotals: {
          input: 1000,
          output: 1000,
          cacheCreation: 0,
          cacheRead: 0,
        },
      }),
    );
    expect(r.costEstimatedUsd).toBeNull();
    expect(r.costIsEstimate).toBe(false);
    expect(r.unknownModelId).toBe('claude-made-up-model-9000');
  });
});

describe('pickModelForRate — [R-D4] cost-weighted multi-model', () => {
  it('single-model: returns that model with no note', () => {
    const p = pickModelForRate({
      model: 'claude-sonnet-4-5',
      modelsUsed: ['claude-sonnet-4-5'],
    });
    expect(p.modelId).toBe('claude-sonnet-4-5');
    expect(p.note).toBeUndefined();
  });

  it('multi-model: picks the most expensive (Opus beats Haiku)', () => {
    const p = pickModelForRate({
      model: 'claude-haiku-4-5',
      modelsUsed: ['claude-haiku-4-5', 'claude-opus-4-7'],
    });
    expect(p.modelId).toBe('claude-opus-4-7');
    expect(p.note).toBe('cost-weighted model selection');
  });

  it('multi-model tie on outputPerM: prefers session.model when it matches', () => {
    // Opus 4-6 and Opus 4-7 tie on outputPerM. Tie-break on session.model.
    const p = pickModelForRate({
      model: 'claude-opus-4-6',
      modelsUsed: ['claude-opus-4-7', 'claude-opus-4-6'],
    });
    expect(p.modelId).toBe('claude-opus-4-6');
  });
});

describe('pickModelForRate — [R-Q2] default model for missing modelsUsed', () => {
  it('falls back to claude-opus-4-6 and marks assumed_model', () => {
    const p = pickModelForRate({ model: null });
    expect(p.modelId).toBe('claude-opus-4-6');
    expect(p.note).toBe('assumed_model');
  });

  it('uses entry.model when modelsUsed is missing but model is present', () => {
    const p = pickModelForRate({ model: 'claude-sonnet-4-6' });
    expect(p.modelId).toBe('claude-sonnet-4-6');
    expect(p.note).toBeUndefined();
  });
});

describe('estimateCost — no-tokenTotals path', () => {
  it('returns null when no totalCostUsd and no tokenTotals', () => {
    const r = estimateCost(baseEntry({ model: 'claude-opus-4-7' }));
    expect(r.costEstimatedUsd).toBeNull();
    expect(r.costIsEstimate).toBe(false);
  });
});

describe('collectUnknownModels', () => {
  it('tallies unknown-model counts across entries', () => {
    const mk = (model: string, totalCostUsd: number | null = null): UnifiedSessionEntry =>
      ({
        id: model,
        source: 'cloud',
        rawSessionId: model,
        startedAt: 0,
        updatedAt: 0,
        durationMs: 0,
        title: 't',
        titleSource: 'fallback',
        preview: null,
        userTurns: 0,
        model,
        modelsUsed: [model],
        cwdKind: 'none',
        totalCostUsd,
        tokenTotals: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
      }) as unknown as UnifiedSessionEntry;

    const entries: UnifiedSessionEntry[] = [
      mk('claude-opus-4-7'),
      mk('bogus-model-x'),
      mk('bogus-model-x'),
      mk('bogus-model-y'),
      // Exact cost short-circuits; unknown model irrelevant.
      mk('bogus-model-z', 1.23),
    ];

    const counts = collectUnknownModels(entries);
    expect(counts.get('bogus-model-x')).toBe(2);
    expect(counts.get('bogus-model-y')).toBe(1);
    expect(counts.has('bogus-model-z')).toBe(false);
    expect(counts.has('claude-opus-4-7')).toBe(false);
  });
});
