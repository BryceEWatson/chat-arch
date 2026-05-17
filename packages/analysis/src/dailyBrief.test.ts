import { describe, it, expect } from 'vitest';
import type {
  AuditResult,
  ContinuumHealth,
  CorrectionPattern,
  ProposedUpgrade,
} from '@chat-arch/schema';
import { buildDailyBrief } from './dailyBrief.js';

const NOW = Date.parse('2026-05-16T04:00:00Z');

function upgrade(overrides: Partial<ProposedUpgrade> = {}): ProposedUpgrade {
  return {
    target: 'global-claude-md',
    targetPath: '~/.claude/CLAUDE.md',
    patch: 'p',
    rationale: 'r',
    applied: false,
    appliedAt: null,
    ...overrides,
  };
}

function pattern(overrides: Partial<CorrectionPattern> = {}): CorrectionPattern {
  return {
    id: 'p1',
    canonicalRule: 'always run lint before committing',
    instanceIds: ['c1', 'c2', 'c3'],
    occurrenceCount: 3,
    firstSeen: NOW - 14 * 86_400_000,
    lastSeen: NOW - 1 * 86_400_000,
    scope: { kind: 'global' },
    proposedUpgrades: [upgrade({ headline: 'Run lint before each commit' })],
    confidence: 0.9,
    recurringPostApplication: false,
    alreadyEncoded: false,
    ...overrides,
  };
}

describe('buildDailyBrief', () => {
  it('emits an empty-but-valid brief when nothing is happening', () => {
    const r = buildDailyBrief({
      date: '2026-05-16',
      now: NOW,
      patterns: [],
      upgradeOutcomes: [],
      blogDrafts: [],
      auditResults: [],
      auditSummary: null,
      continuumHealth: null,
    });
    expect(r.markdown).toContain('TODAY · 2026-05-16');
    expect(r.markdown).toContain('auto-generated brief');
    expect(r.counts.patternsShifted).toBe(0);
  });

  it('includes patterns whose lastSeen is within the recency window', () => {
    const r = buildDailyBrief({
      date: '2026-05-16',
      now: NOW,
      patterns: [
        pattern({ id: 'recent', canonicalRule: 'recent rule', lastSeen: NOW - 86_400_000 }),
        pattern({ id: 'old', canonicalRule: 'old rule', lastSeen: NOW - 30 * 86_400_000 }),
      ],
      upgradeOutcomes: [],
      blogDrafts: [],
      auditResults: [],
      auditSummary: null,
      continuumHealth: null,
    });
    expect(r.markdown).toContain('recent rule');
    expect(r.markdown).not.toContain('old rule');
    expect(r.counts.patternsShifted).toBe(1);
  });

  it('lists upgrades to propose, prioritizing recurring-unfollowed', () => {
    const r = buildDailyBrief({
      date: '2026-05-16',
      now: NOW,
      patterns: [
        pattern({
          id: 'normal',
          confidence: 0.95,
          recurringPostApplication: false,
          proposedUpgrades: [upgrade({ headline: 'normal upgrade' })],
        }),
        pattern({
          id: 'recurring',
          confidence: 0.7,
          recurringPostApplication: true,
          proposedUpgrades: [upgrade({ headline: 'recurring upgrade' })],
        }),
      ],
      upgradeOutcomes: [],
      blogDrafts: [],
      auditResults: [],
      auditSummary: null,
      continuumHealth: null,
    });
    const recurringIdx = r.markdown.indexOf('recurring upgrade');
    const normalIdx = r.markdown.indexOf('normal upgrade');
    expect(recurringIdx).toBeGreaterThan(-1);
    expect(normalIdx).toBeGreaterThan(-1);
    expect(recurringIdx).toBeLessThan(normalIdx);
  });

  it('includes audit failures with their reason', () => {
    const fail: AuditResult = {
      sessionId: 'sid-abc',
      source: 'cowork',
      lineNumber: 42,
      claimType: 'tests-pass-claim',
      span: 'all tests pass',
      surroundingContext: 'ctx',
      outcome: 'fail',
      reason: 'Bash exited 1 at line 45',
    };
    const r = buildDailyBrief({
      date: '2026-05-16',
      now: NOW,
      patterns: [],
      upgradeOutcomes: [],
      blogDrafts: [],
      auditResults: [fail],
      auditSummary: null,
      continuumHealth: null,
    });
    expect(r.markdown).toContain('[SID:sid-abc]');
    expect(r.markdown).toContain('all tests pass');
    expect(r.markdown).toContain('Bash exited 1');
  });

  it('renders continuum health with warnings when present', () => {
    const health: ContinuumHealth = {
      version: 1,
      lastScanAt: '2026-05-16T03:00:00Z',
      lastSuccessfulScanAt: '2026-05-16T03:00:00Z',
      consecutiveSuccesses: 14,
      sourcesScanned: ['cowork', 'cli-direct'],
      entriesByStatus: { ok: 100, missing: 5, crashed: 0, pruned: 10 },
      newSessionsSinceLast: 2,
      warnings: [{ source: 'cli-direct', kind: 'missing-rate-high', value: 0.25, threshold: 0.2 }],
    };
    const r = buildDailyBrief({
      date: '2026-05-16',
      now: NOW,
      patterns: [],
      upgradeOutcomes: [],
      blogDrafts: [],
      auditResults: [],
      auditSummary: null,
      continuumHealth: health,
    });
    expect(r.markdown).toContain('Continuum health: warning');
    expect(r.markdown).toContain('14 consecutive');
    expect(r.markdown).toContain('cli-direct: missing-rate-high');
  });

  it('blog drafts sort by passRate descending', () => {
    const r = buildDailyBrief({
      date: '2026-05-16',
      now: NOW,
      patterns: [],
      upgradeOutcomes: [],
      blogDrafts: [
        {
          slug: 'low',
          generatedAt: NOW,
          candidateId: 'c1',
          citedSessionIds: ['s1'],
          audit: { totalClaims: 10, passed: 4, failed: 4, inconclusive: 2, passRate: 0.4 },
          draftPath: 'analysis/blog-drafts/low.md',
          title: 'Low confidence draft',
        },
        {
          slug: 'high',
          generatedAt: NOW,
          candidateId: 'c2',
          citedSessionIds: ['s2'],
          audit: { totalClaims: 10, passed: 9, failed: 1, inconclusive: 0, passRate: 0.9 },
          draftPath: 'analysis/blog-drafts/high.md',
          title: 'High confidence draft',
        },
      ],
      auditResults: [],
      auditSummary: null,
      continuumHealth: null,
    });
    const high = r.markdown.indexOf('High confidence');
    const low = r.markdown.indexOf('Low confidence');
    expect(high).toBeGreaterThan(-1);
    expect(low).toBeGreaterThan(high);
  });
});
