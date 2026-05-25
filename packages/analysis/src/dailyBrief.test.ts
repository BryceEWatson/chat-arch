import { describe, it, expect } from 'vitest';
import type {
  AuditResult,
  ContinuumHealth,
  CorrectionPattern,
  ProposedUpgrade,
} from '@chat-arch/schema';
import { buildDailyBrief, type BriefTrajectoryRow } from './dailyBrief.js';
import type { SurprisesOutput } from './computeSurprises.js';

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

  // ── Phase γ §1 — Shipped this week ───────────────────────────────

  describe('shipped this week', () => {
    it('renders the count + top subjects when commits exist', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        shippedThisWeek: {
          commitCount: 12,
          recentSubjects: [
            'feat: ship one',
            'fix: stabilize two',
            'docs: update three',
            'chore: bump four',
            'refactor: rename five',
            'test: cover six (will not render)',
          ],
        },
      });
      expect(r.markdown).toContain('Shipped this week: 12 commit(s) to main');
      expect(r.markdown).toContain('feat: ship one');
      expect(r.markdown).toContain('refactor: rename five');
      // Top-5 cap on subjects.
      expect(r.markdown).not.toContain('test: cover six');
      expect(r.counts.shippedCommits).toBe(12);
    });

    it('skips the section when commitCount is zero', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        shippedThisWeek: { commitCount: 0, recentSubjects: [] },
      });
      expect(r.markdown).not.toContain('Shipped this week');
      expect(r.counts.shippedCommits).toBe(0);
    });

    it('skips the section when shippedThisWeek is null', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        shippedThisWeek: null,
      });
      expect(r.markdown).not.toContain('Shipped this week');
      expect(r.counts.shippedCommits).toBe(0);
    });

    it('truncates long subject lines at 120 chars', () => {
      const long = 'feat: ' + 'a'.repeat(200);
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        shippedThisWeek: { commitCount: 1, recentSubjects: [long] },
      });
      // The rendered subject line includes our '  • ' prefix; we
      // inspect for the truncation marker on the rendered body line.
      const subjectLine = r.markdown
        .split('\n')
        .find((l) => l.startsWith('  • feat: aaa'));
      expect(subjectLine).toBeDefined();
      // 4-char prefix ("  • ") + clip120(...) ⇒ line ≤ 124 chars.
      expect((subjectLine as string).length).toBeLessThanOrEqual(124);
      expect(subjectLine).toMatch(/…$/u);
    });

    it('formats large commit counts with toLocaleString separators', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        shippedThisWeek: {
          commitCount: 1234,
          recentSubjects: ['feat: many things'],
        },
      });
      expect(r.markdown).toContain('1,234 commit(s) to main');
    });
  });

  // ── Phase γ §2 — Surprises today ─────────────────────────────────

  function surprisesFile(
    rows: ReadonlyArray<{
      kind: SurprisesOutput['surprises'][number]['kind'];
      tone: SurprisesOutput['surprises'][number]['tone'];
      summary: string;
      score: number;
    }>,
  ): SurprisesOutput {
    return {
      version: 1,
      generatedAt: NOW,
      surprises: rows.map((r, i) => ({
        id: `${r.kind}:row-${i}`,
        kind: r.kind,
        tone: r.tone,
        summary: r.summary,
        evidence: {},
        score: r.score,
        generatedAt: NOW,
      })),
      thresholds: {
        streakMin: 5,
        itsQValueMax: 0.1,
        itsDeltaMin: 0.15,
        reflexiveDeltaMin: 0.1,
        decisionGoodFollowupsMin: 2,
        debtSpinningTopK: 3,
        debtSpinningMinClusterSize: 3,
      },
    };
  }

  describe('surprises', () => {
    it('reports per-tone counts and lists top-3 positive summaries', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        surprises: surprisesFile([
          { kind: 'streak', tone: 'positive', summary: '5 in a row', score: 0.9 },
          {
            kind: 'trajectory-accelerating',
            tone: 'positive',
            summary: 'Project chat-arch on the rise',
            score: 0.8,
          },
          {
            kind: 'config-helped',
            tone: 'positive',
            summary: 'Config abc lifted good-share',
            score: 0.7,
          },
          {
            kind: 'pattern-closed',
            tone: 'positive',
            summary: 'Pattern p1 held',
            score: 0.5,
          },
          {
            kind: 'trajectory-stalled',
            tone: 'concerning',
            summary: 'Project foo stalling',
            score: 0.6,
          },
        ]),
      });
      expect(r.markdown).toContain('Surprises today: 4 positive, 1 concerning');
      expect(r.markdown).toContain('[streak] 5 in a row');
      expect(r.markdown).toContain(
        '[trajectory-accelerating] Project chat-arch on the rise',
      );
      expect(r.markdown).toContain('[config-helped] Config abc lifted good-share');
      // 4th positive ('pattern-closed') exceeds top-3 cap and is excluded.
      expect(r.markdown).not.toContain('Pattern p1 held');
      expect(r.counts.surprisesPositive).toBe(4);
      expect(r.counts.surprisesConcerning).toBe(1);
    });

    it('skips the section when surprises is null', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        surprises: null,
      });
      expect(r.markdown).not.toContain('Surprises today');
      expect(r.counts.surprisesPositive).toBe(0);
      expect(r.counts.surprisesConcerning).toBe(0);
    });

    it('skips the section when the file is present but empty', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        surprises: surprisesFile([]),
      });
      expect(r.markdown).not.toContain('Surprises today');
    });

    it('handles concerning-only files (zero positive summaries listed)', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        surprises: surprisesFile([
          {
            kind: 'pattern-recurring',
            tone: 'concerning',
            summary: 'p1 came back',
            score: 0.9,
          },
        ]),
      });
      expect(r.markdown).toContain('Surprises today: 0 positive, 1 concerning');
      // No positive rows ⇒ no `[kind]` bullet beneath the header.
      expect(r.markdown).not.toContain('[pattern-recurring]');
    });
  });

  // ── Phase γ §3 — Project trajectories ────────────────────────────

  function trajectory(
    overrides: Partial<BriefTrajectoryRow> = {},
  ): BriefTrajectoryRow {
    return {
      projectId: 'proj-1',
      projectName: 'project one',
      classification: 'flat',
      slope: 0,
      totalSessions: 10,
      ...overrides,
    };
  }

  describe('project trajectories', () => {
    it('reports per-classification counts and the top-3 most-active', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        projectTrajectories: [
          trajectory({
            projectId: 'a',
            projectName: 'alpha',
            classification: 'accelerating',
            slope: 0.5,
            totalSessions: 50,
          }),
          trajectory({
            projectId: 'b',
            projectName: 'bravo',
            classification: 'flat',
            slope: 0,
            totalSessions: 40,
          }),
          trajectory({
            projectId: 'c',
            projectName: 'charlie',
            classification: 'stalling',
            slope: -0.3,
            totalSessions: 30,
          }),
          trajectory({
            projectId: 'd',
            projectName: 'delta',
            classification: 'stalled-finished',
            slope: -0.1,
            totalSessions: 20,
          }),
          trajectory({
            projectId: 'e',
            projectName: 'echo',
            classification: 'accelerating',
            slope: 0.2,
            totalSessions: 5,
          }),
        ],
      });
      expect(r.markdown).toContain(
        'Project trajectories: 2 accelerating, 1 flat, 2 stalling/stalled',
      );
      // Top 3 by totalSessions: alpha (50), bravo (40), charlie (30).
      expect(r.markdown).toContain('alpha — accelerating (slope +0.50, 50 sessions)');
      expect(r.markdown).toContain('bravo — flat (slope 0.00, 40 sessions)');
      expect(r.markdown).toContain('charlie — stalling (slope -0.30, 30 sessions)');
      // Lower-activity rows excluded.
      expect(r.markdown).not.toContain('delta — stalled-finished');
      expect(r.markdown).not.toContain('echo — accelerating');
      expect(r.counts.trajectoriesAccelerating).toBe(2);
      expect(r.counts.trajectoriesFlat).toBe(1);
      expect(r.counts.trajectoriesStalling).toBe(2);
    });

    it('skips the section when no project rows are passed', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        projectTrajectories: [],
      });
      expect(r.markdown).not.toContain('Project trajectories');
      expect(r.counts.trajectoriesAccelerating).toBe(0);
      expect(r.counts.trajectoriesFlat).toBe(0);
      expect(r.counts.trajectoriesStalling).toBe(0);
    });

    it('skips the section when projectTrajectories is null', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        projectTrajectories: null,
      });
      expect(r.markdown).not.toContain('Project trajectories');
    });

    it('renders "slope n/a" for null slopes', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        projectTrajectories: [
          trajectory({
            projectName: 'no-slope-project',
            classification: 'flat',
            slope: null,
            totalSessions: 3,
          }),
        ],
      });
      expect(r.markdown).toContain('no-slope-project — flat (slope n/a, 3 sessions)');
    });
  });

  // ── Phase γ §4 — Applied-pattern closures ────────────────────────

  describe('applied-pattern closures', () => {
    it('renders the count when patterns are currently held', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        appliedPatternClosures: 4,
      });
      expect(r.markdown).toContain(
        'Applied-pattern closures: 4 pattern(s) held (no recurrence past cooldown)',
      );
      expect(r.counts.appliedPatternClosures).toBe(4);
    });

    it('skips the section when zero patterns are held', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        appliedPatternClosures: 0,
      });
      expect(r.markdown).not.toContain('Applied-pattern closures');
      expect(r.counts.appliedPatternClosures).toBe(0);
    });

    it('skips the section when the SDK accessor is unwired (null)', () => {
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: [],
        auditSummary: null,
        continuumHealth: null,
        appliedPatternClosures: null,
      });
      expect(r.markdown).not.toContain('Applied-pattern closures');
      expect(r.counts.appliedPatternClosures).toBe(0);
    });
  });

  // ── Phase γ ordering invariant ───────────────────────────────────

  it('orders Phase γ sections between audit concerns and continuum health', () => {
    const fail: AuditResult = {
      sessionId: 'sid-x',
      source: 'cowork',
      lineNumber: 1,
      claimType: 'tests-pass-claim',
      span: 'works',
      surroundingContext: 'ctx',
      outcome: 'fail',
      reason: 'because',
    };
    const health: ContinuumHealth = {
      version: 1,
      lastScanAt: '2026-05-16T03:00:00Z',
      lastSuccessfulScanAt: '2026-05-16T03:00:00Z',
      consecutiveSuccesses: 1,
      sourcesScanned: ['cowork'],
      entriesByStatus: { ok: 1, missing: 0, crashed: 0, pruned: 0 },
      newSessionsSinceLast: 0,
      warnings: [],
    };
    const r = buildDailyBrief({
      date: '2026-05-16',
      now: NOW,
      patterns: [],
      upgradeOutcomes: [],
      blogDrafts: [],
      auditResults: [fail],
      auditSummary: null,
      continuumHealth: health,
      shippedThisWeek: {
        commitCount: 2,
        recentSubjects: ['feat: ordering test'],
      },
      surprises: surprisesFile([
        { kind: 'streak', tone: 'positive', summary: 'streak!', score: 1 },
      ]),
      projectTrajectories: [
        trajectory({
          projectName: 'ordering-project',
          classification: 'accelerating',
          slope: 0.5,
          totalSessions: 5,
        }),
      ],
      appliedPatternClosures: 1,
    });
    const audit = r.markdown.indexOf('audit concern');
    const shipped = r.markdown.indexOf('Shipped this week');
    const surprises = r.markdown.indexOf('Surprises today');
    const trajectories = r.markdown.indexOf('Project trajectories');
    const closures = r.markdown.indexOf('Applied-pattern closures');
    const continuum = r.markdown.indexOf('Continuum health');
    expect(audit).toBeGreaterThan(-1);
    expect(shipped).toBeGreaterThan(audit);
    expect(surprises).toBeGreaterThan(shipped);
    expect(trajectories).toBeGreaterThan(surprises);
    expect(closures).toBeGreaterThan(trajectories);
    expect(continuum).toBeGreaterThan(closures);
  });
});
