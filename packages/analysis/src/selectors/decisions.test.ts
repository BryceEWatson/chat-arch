import { describe, it, expect } from 'vitest';
import type {
  Decision,
  DecisionClassification,
  DecisionOutcomeRef,
} from '@chat-arch/schema';
import {
  KIND_LABEL,
  groupDecisionsByKind,
  partitionDecisions,
} from './decisions.js';

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

let seq = 0;
function decision(opts: {
  classification?: DecisionClassification | null;
  outcomeRef?: DecisionOutcomeRef | null;
}): Decision {
  seq += 1;
  return {
    candidate: {
      id: `id-${seq}`,
      sessionId: 's',
      userTurnIndex: seq,
      kind: 'imperative-choice',
      span: { phrase: 'p', startOffset: 0 },
      surroundingContext: '',
      precedingAssistantExcerpt: null,
    },
    classification: opts.classification ?? null,
    outcomeRef: opts.outcomeRef ?? null,
  };
}

describe('partitionDecisions', () => {
  it('empty input yields empty buckets', () => {
    expect(partitionDecisions([])).toEqual({ classified: [], unclassified: [] });
  });

  it('splits on classification === null', () => {
    const c = decision({ classification: classification('tool-pivot') });
    const u = decision({});
    const { classified, unclassified } = partitionDecisions([c, u]);
    expect(classified).toEqual([c]);
    expect(unclassified).toEqual([u]);
  });
});

describe('groupDecisionsByKind', () => {
  it('empty input yields no groups', () => {
    expect(groupDecisionsByKind([])).toEqual([]);
  });

  it('falls back to upper-cased key for unknown kinds and null classification → other', () => {
    // classification null → key 'other' via the ?? 'other' branch.
    const groups = groupDecisionsByKind([decision({})]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('other');
    expect(groups[0]!.label).toBe(KIND_LABEL.other);
  });

  it('counts denom only over non-neutral outcomes and landed over good', () => {
    const groups = groupDecisionsByKind([
      decision({ classification: classification('tool-pivot'), outcomeRef: outcomeRef('good') }),
      decision({ classification: classification('tool-pivot'), outcomeRef: outcomeRef('bad') }),
      decision({ classification: classification('tool-pivot'), outcomeRef: outcomeRef('neutral') }),
      decision({ classification: classification('tool-pivot'), outcomeRef: null }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g.rows).toHaveLength(4);
    expect(g.denom).toBe(2); // good + bad, neutral + null excluded
    expect(g.landed).toBe(1); // only good
    expect(g.label).toBe(KIND_LABEL['tool-pivot']);
  });

  it('sorts by row-count desc, then label asc', () => {
    const groups = groupDecisionsByKind([
      decision({ classification: classification('scope-cut') }),
      decision({ classification: classification('tool-pivot') }),
      decision({ classification: classification('tool-pivot') }),
    ]);
    // tool-pivot (2 rows) before scope-cut (1 row)
    expect(groups.map((g) => g.key)).toEqual(['tool-pivot', 'scope-cut']);
  });

  it('breaks count ties by label localeCompare', () => {
    const groups = groupDecisionsByKind([
      decision({ classification: classification('tool-pivot') }), // label TOOL PIVOT
      decision({ classification: classification('scope-cut') }), // label SCOPE CUT
    ]);
    // tie on 1 row each → SCOPE CUT < TOOL PIVOT
    expect(groups.map((g) => g.label)).toEqual([
      KIND_LABEL['scope-cut'],
      KIND_LABEL['tool-pivot'],
    ]);
  });
});
