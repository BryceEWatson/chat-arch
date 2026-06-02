import { describe, it, expect } from 'vitest';
import type {
  Decision,
  DecisionClassification,
  DecisionOutcomeRef,
  DecisionTrustCalibration,
} from '@chat-arch/schema';
import { THRESHOLDS } from '../thresholds.js';
import {
  build2x2,
  cisDisjoint,
  deriveTrustSignal,
  deriveTrustSignalExplicitOnly,
  isTrustMisCalibrated,
} from './trust.js';

const MIN_N = THRESHOLDS.trustCell.minN;

function classification(
  kind: DecisionClassification['kind'],
): DecisionClassification {
  return {
    kind,
    distilledDecision: 'd',
    chosen: ['a'],
    rejected: [],
    rationale: '',
    confidence: 1,
    actionable: true,
  };
}

function outcomeRef(binaryClass: DecisionOutcomeRef['binaryClass']): DecisionOutcomeRef {
  return { sessionId: 's', compositeScore: 0.5, binaryClass };
}

function decision(opts: {
  trustCalibration?: DecisionTrustCalibration | null;
  classification?: DecisionClassification | null;
  outcomeRef?: DecisionOutcomeRef | null;
}): Decision {
  return {
    candidate: {
      id: 'id',
      sessionId: 's',
      userTurnIndex: 0,
      kind: 'imperative-choice',
      span: { phrase: 'p', startOffset: 0 },
      surroundingContext: '',
      precedingAssistantExcerpt: null,
    },
    classification: opts.classification ?? null,
    outcomeRef: opts.outcomeRef ?? null,
    ...(opts.trustCalibration !== undefined
      ? { trustCalibration: opts.trustCalibration }
      : {}),
  };
}

/** N decisions with an explicit trustCalibration cell. */
function tc(accepted: boolean, landed: boolean, n: number): Decision[] {
  return Array.from({ length: n }, () =>
    decision({ trustCalibration: { acceptedAssistant: accepted, landed } }),
  );
}

describe('deriveTrustSignal', () => {
  it('prefers the explicit trustCalibration field', () => {
    expect(
      deriveTrustSignal(decision({ trustCalibration: { acceptedAssistant: true, landed: false } })),
    ).toEqual({ accepted: true, landed: false });
  });

  it('returns null when no signal path resolves (null classification + outcome)', () => {
    expect(deriveTrustSignal(decision({}))).toBeNull();
  });

  it('returns null for a neutral fallback outcome', () => {
    expect(
      deriveTrustSignal(
        decision({
          classification: classification('alternative-block'),
          outcomeRef: outcomeRef('neutral'),
        }),
      ),
    ).toBeNull();
  });

  it('fallback: alternative-block counts as accepted, good == landed', () => {
    expect(
      deriveTrustSignal(
        decision({
          classification: classification('alternative-block'),
          outcomeRef: outcomeRef('good'),
        }),
      ),
    ).toEqual({ accepted: true, landed: true });
  });

  it('fallback: imperative-choice counts as override (not accepted)', () => {
    expect(
      deriveTrustSignal(
        decision({
          classification: classification('imperative-choice'),
          outcomeRef: outcomeRef('bad'),
        }),
      ),
    ).toEqual({ accepted: false, landed: false });
  });

  it('fallback: other kinds (not alternative-block / imperative-choice) skip', () => {
    expect(
      deriveTrustSignal(
        decision({
          classification: classification('tool-pivot'),
          outcomeRef: outcomeRef('good'),
        }),
      ),
    ).toBeNull();
  });
});

describe('deriveTrustSignalExplicitOnly', () => {
  it('returns the explicit trustCalibration signal when present', () => {
    expect(
      deriveTrustSignalExplicitOnly(
        decision({ trustCalibration: { acceptedAssistant: false, landed: true } }),
      ),
    ).toEqual({ accepted: false, landed: true });
  });

  it('returns null when trustCalibration is absent — NO fallback (unlike deriveTrustSignal)', () => {
    // A decision that deriveTrustSignal WOULD resolve via the fallback path…
    const d = decision({
      classification: classification('alternative-block'),
      outcomeRef: outcomeRef('good'),
    });
    expect(deriveTrustSignal(d)).toEqual({ accepted: true, landed: true });
    // …explicit-only ignores it (preserves the banner's pre-centralization count).
    expect(deriveTrustSignalExplicitOnly(d)).toBeNull();
  });

  it('build2x2 with explicit-only derive excludes fallback rows', () => {
    const decisions = [
      ...tc(true, true, 2),
      // fallback-resolvable rows that explicit-only must ignore:
      decision({ classification: classification('alternative-block'), outcomeRef: outcomeRef('good') }),
      decision({ classification: classification('imperative-choice'), outcomeRef: outcomeRef('bad') }),
    ];
    const withFallback = build2x2(decisions);
    const explicitOnly = build2x2(decisions, deriveTrustSignalExplicitOnly);
    expect(withFallback.totalUsable).toBe(4);
    expect(explicitOnly.totalUsable).toBe(2);
  });
});

describe('build2x2', () => {
  it('empty input yields zeroed cells and totalUsable 0', () => {
    const t = build2x2([]);
    expect(t.totalUsable).toBe(0);
    expect(t.cells['accept-land'].n).toBe(0);
    expect(t.acceptRow.total).toBe(0);
    expect(t.acceptRow.pHat).toBe(0);
    expect(t.acceptRow.meetsCellN).toBe(false);
    // wilsonCI(0,0) => [0,1]
    expect(t.acceptRow.ci).toEqual({ low: 0, high: 1 });
  });

  it('skips null-signal decisions but counts usable ones', () => {
    const t = build2x2([
      decision({}), // null signal — skipped
      ...tc(true, true, 1),
      ...tc(false, false, 1),
    ]);
    expect(t.totalUsable).toBe(2);
    expect(t.cells['accept-land'].n).toBe(1);
    expect(t.cells['override-noland'].n).toBe(1);
  });

  it('computes per-row pHat and meetsCellN against minN', () => {
    const t = build2x2([
      ...tc(true, true, MIN_N),
      ...tc(true, false, MIN_N),
      ...tc(false, true, 1),
      ...tc(false, false, 1),
    ]);
    expect(t.acceptRow.total).toBe(MIN_N * 2);
    expect(t.acceptRow.landed).toBe(MIN_N);
    expect(t.acceptRow.pHat).toBeCloseTo(0.5, 10);
    expect(t.acceptRow.meetsCellN).toBe(true);
    // override row cells are below minN
    expect(t.overrideRow.meetsCellN).toBe(false);
  });
});

describe('cisDisjoint', () => {
  it('disjoint when one upper < other lower', () => {
    expect(cisDisjoint({ low: 0, high: 0.2 }, { low: 0.3, high: 0.5 })).toBe(true);
  });
  it('overlapping returns false', () => {
    expect(cisDisjoint({ low: 0, high: 0.4 }, { low: 0.3, high: 0.5 })).toBe(false);
  });
});

describe('isTrustMisCalibrated', () => {
  it('false when either row is below minN even if rates differ', () => {
    const t = build2x2([
      ...tc(true, true, 1),
      ...tc(true, false, 1),
      ...tc(false, false, MIN_N),
      ...tc(false, true, MIN_N),
    ]);
    expect(isTrustMisCalibrated(t)).toBe(false);
  });

  it('false when both rows qualify but CIs overlap (same rate)', () => {
    const t = build2x2([
      ...tc(true, true, MIN_N),
      ...tc(true, false, MIN_N),
      ...tc(false, true, MIN_N),
      ...tc(false, false, MIN_N),
    ]);
    // both rows ~50% with identical CIs => overlap
    expect(isTrustMisCalibrated(t)).toBe(false);
  });

  it('true when both rows qualify and landed-rate CIs are disjoint', () => {
    // accept row: almost all landed; override row: almost none landed,
    // with large n so the CIs separate.
    const big = MIN_N * 20;
    const t = build2x2([
      ...tc(true, true, big),
      ...tc(true, false, MIN_N),
      ...tc(false, true, MIN_N),
      ...tc(false, false, big),
    ]);
    expect(isTrustMisCalibrated(t)).toBe(true);
  });
});
