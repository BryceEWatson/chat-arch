import { describe, it, expect } from 'vitest';
import type { KnowledgeDebtCluster } from '../detectKnowledgeDebt.js';
import type { ItsResult, ItsSnapshot } from '../itsAnalysis.js';
import { THRESHOLDS } from '../thresholds.js';
import { rankTopActionItems } from './actionItems.js';

const MIN_N = THRESHOLDS.display.minNForRate;

function cluster(opts: {
  canonicalQuestion: string;
  confidence?: 'high' | 'low';
  sessionIds?: readonly string[];
}): KnowledgeDebtCluster {
  return {
    id: 'c',
    canonicalQuestion: opts.canonicalQuestion,
    labelTerms: [],
    sessionIds: opts.sessionIds ?? ['s1', 's2'],
    firstSeen: 0,
    lastSeen: 0,
    confidence: opts.confidence ?? 'low',
  };
}

function snap(n: number): ItsSnapshot {
  return { n, meanScore: 0.5, goodShare: 0.5, goodShareCI: { low: 0, high: 1 } };
}

function its(opts: {
  subject?: string;
  path?: string;
  sha?: string;
  preN?: number;
  postN?: number;
  deltaGoodShare: number;
  deltaCI: { low: number; high: number };
}): ItsResult {
  return {
    sha: opts.sha ?? 'abcdef1234',
    ts: 0,
    path: opts.path ?? 'CLAUDE.md',
    subject: opts.subject ?? '',
    windowDays: 10,
    pre: snap(opts.preN ?? MIN_N),
    post: snap(opts.postN ?? MIN_N),
    deltaGoodShare: opts.deltaGoodShare,
    deltaCI: opts.deltaCI,
    pValue: 0.01,
    qValue: 0.01,
  };
}

describe('rankTopActionItems', () => {
  it('null inputs yield no items', () => {
    expect(rankTopActionItems({ knowledgeDebt: null, its: null })).toEqual([]);
  });

  it('empty clusters and empty its results yield no items', () => {
    expect(
      rankTopActionItems({ knowledgeDebt: { clusters: [] }, its: { results: [] } }),
    ).toEqual([]);
  });

  it('emits a knowledge-debt headline for the top cluster', () => {
    const out = rankTopActionItems({
      knowledgeDebt: {
        clusters: [cluster({ canonicalQuestion: 'how do I deploy?', sessionIds: ['a', 'b', 'c'] })],
      },
      its: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('knowledge-debt');
    expect(out[0]!.headline).toBe('recurring question (3 sessions) — how do I deploy?');
    expect(out[0]!.detail).toBe('confidence low');
    expect(out[0]!.mode).toBe('insights');
  });

  it('skips slash-command clusters but keeps the next eligible one', () => {
    const out = rankTopActionItems({
      knowledgeDebt: {
        clusters: [
          cluster({ canonicalQuestion: '/shopsmith-menu', confidence: 'high', sessionIds: ['x', 'y', 'z', 'w'] }),
          cluster({ canonicalQuestion: 'why is the build slow?', sessionIds: ['a', 'b'] }),
        ],
      },
      its: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.headline).toContain('why is the build slow?');
  });

  it('ranks high-confidence cluster above a larger low-confidence one', () => {
    const out = rankTopActionItems({
      knowledgeDebt: {
        clusters: [
          cluster({ canonicalQuestion: 'low-conf big', confidence: 'low', sessionIds: ['1', '2', '3', '4', '5'] }),
          cluster({ canonicalQuestion: 'high-conf small', confidence: 'high', sessionIds: ['a', 'b'] }),
        ],
      },
      its: null,
    });
    expect(out[0]!.headline).toContain('high-conf small');
  });

  it('truncates long canonical questions to 77 chars + ellipsis', () => {
    const long = 'q'.repeat(120);
    const out = rankTopActionItems({
      knowledgeDebt: { clusters: [cluster({ canonicalQuestion: long, sessionIds: ['a'] })] },
      its: null,
    });
    expect(out[0]!.headline.endsWith('q'.repeat(77) + '…')).toBe(true);
  });

  it('drops ITS rows below the display floor', () => {
    const out = rankTopActionItems({
      knowledgeDebt: null,
      its: {
        results: [
          its({ preN: MIN_N - 1, postN: MIN_N, deltaGoodShare: 0.5, deltaCI: { low: 0.1, high: 0.9 } }),
        ],
      },
    });
    expect(out).toEqual([]);
  });

  it('drops ITS rows whose deltaCI straddles zero', () => {
    const out = rankTopActionItems({
      knowledgeDebt: null,
      its: {
        results: [its({ deltaGoodShare: 0.3, deltaCI: { low: -0.1, high: 0.5 } })],
      },
    });
    expect(out).toEqual([]);
  });

  it('emits the biggest |delta| disjoint-CI ITS contrast with pp + sha', () => {
    const out = rankTopActionItems({
      knowledgeDebt: null,
      its: {
        results: [
          its({ subject: 'small', deltaGoodShare: 0.12, deltaCI: { low: 0.01, high: 0.2 }, sha: '1111111aaa' }),
          its({ subject: 'big', deltaGoodShare: -0.4, deltaCI: { low: -0.6, high: -0.2 }, sha: '2222222bbb' }),
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('its');
    expect(out[0]!.headline).toBe('big shifted good-share -40 pp');
    expect(out[0]!.detail).toBe('commit 2222222');
    expect(out[0]!.mode).toBe('insights');
  });

  it('falls back to path when subject is empty', () => {
    const out = rankTopActionItems({
      knowledgeDebt: null,
      its: {
        results: [its({ subject: '', path: '.claude/skills/x/SKILL.md', deltaGoodShare: 0.5, deltaCI: { low: 0.2, high: 0.8 } })],
      },
    });
    expect(out[0]!.headline).toBe('.claude/skills/x/SKILL.md shifted good-share +50 pp');
  });

  it('emits both a debt and an its row when both qualify', () => {
    const out = rankTopActionItems({
      knowledgeDebt: { clusters: [cluster({ canonicalQuestion: 'q?', sessionIds: ['a'] })] },
      its: { results: [its({ subject: 'big', deltaGoodShare: 0.5, deltaCI: { low: 0.2, high: 0.8 } })] },
    });
    expect(out.map((i) => i.kind)).toEqual(['knowledge-debt', 'its']);
  });
});
