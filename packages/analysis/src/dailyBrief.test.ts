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
      // Wave 2 — narrative opener line (replaces "Shipped this week: …").
      expect(r.markdown).toContain('► You shipped 12 commits to main this week.');
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
      // No "you shipped …" header line + no original count line.
      expect(r.markdown).not.toContain('You shipped');
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
      expect(r.markdown).not.toContain('You shipped');
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
      // Wave 2 — pluralize + locale grouping carry over into the
      // new narrative phrasing.
      expect(r.markdown).toContain('You shipped 1,234 commits to main this week.');
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
      // Wave 2 — header renamed "Surprises today: …" → "Surprises: …".
      expect(r.markdown).toContain('► Surprises: 4 positive, 1 concerning.');
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
      // Both the pre-Wave-2 header copy AND the new copy are absent
      // when the section skips — the assertion guards the rename
      // against accidental re-introduction.
      expect(r.markdown).not.toContain('Surprises today');
      expect(r.markdown).not.toMatch(/► Surprises:/u);
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
      expect(r.markdown).not.toMatch(/► Surprises:/u);
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
      expect(r.markdown).toContain('► Surprises: 0 positive, 1 concerning.');
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
      // Wave 2 — header renamed "Project trajectories: …" →
      // "Project momentum: …" and bucket label normalised
      // "stalling/stalled" → "stalling".
      expect(r.markdown).toContain(
        '► Project momentum: 2 accelerating, 1 flat, 2 stalling.',
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
      expect(r.markdown).not.toContain('Project momentum');
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
      expect(r.markdown).not.toContain('Project momentum');
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
      // Wave 2 — narrative header "K pattern(s) you applied are still
      // holding." (pre-Wave-2: "Applied-pattern closures: K pattern(s)
      // held (no recurrence past cooldown)").
      expect(r.markdown).toContain('► 4 patterns you applied are still holding.');
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
      expect(r.markdown).not.toContain('you applied are still holding');
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
      expect(r.markdown).not.toContain('you applied are still holding');
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
    // Wave 2 — anchors updated to new section headers. The audit
    // section's narrative opener leads with the count + "didn't have
    // supporting tool calls" phrase; the rest of the openers each lift
    // a unique substring.
    const audit = r.markdown.indexOf("didn't have supporting tool calls");
    const shipped = r.markdown.indexOf('You shipped');
    const surprises = r.markdown.indexOf('► Surprises:');
    const trajectories = r.markdown.indexOf('Project momentum');
    const closures = r.markdown.indexOf('you applied are still holding');
    const continuum = r.markdown.indexOf('Continuum health');
    expect(audit).toBeGreaterThan(-1);
    expect(shipped).toBeGreaterThan(audit);
    expect(surprises).toBeGreaterThan(shipped);
    expect(trajectories).toBeGreaterThan(surprises);
    expect(closures).toBeGreaterThan(trajectories);
    expect(continuum).toBeGreaterThan(closures);
  });

  // ── Wave 2 — journal-y opener paragraph ──────────────────────────

  describe('opener paragraph', () => {
    it('opens with the shipped-commit narrative when commits exist', () => {
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
          commitCount: 7,
          recentSubjects: [
            'feat: opener test one',
            'fix: opener test two',
            'chore: opener test three',
          ],
        },
      });
      expect(r.markdown).toContain(
        'This week you shipped 7 commits to main.',
      );
      // Top 1-2 subjects inlined; the 3rd subject is shipped-section
      // detail only and shouldn't promote into the opener.
      expect(r.markdown).toContain(
        'Top of the list: "feat: opener test one" and "fix: opener test two".',
      );
      expect(r.markdown.indexOf('Top of the list')).toBeLessThan(
        r.markdown.indexOf('► You shipped'),
      );
    });

    it('inlines a single subject when only one is provided', () => {
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
          commitCount: 1,
          recentSubjects: ['feat: solo commit'],
        },
      });
      expect(r.markdown).toContain('This week you shipped 1 commit to main.');
      expect(r.markdown).toContain('Top of the list: "feat: solo commit".');
      // Singular form: no trailing "s" on "commit" anywhere in the
      // opener line.
      expect(r.markdown).not.toContain('1 commits');
    });

    it('opens with the strongest signal when no commits but a STRONG positive', () => {
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
        topStrongPositiveSurprise: '8 sessions in a row landed as composite-good.',
      });
      expect(r.markdown).toContain(
        'The strongest signal: 8 sessions in a row landed as composite-good.',
      );
      // The opener-fallback line must NOT appear.
      expect(r.markdown).not.toContain('No commits to main this week');
      expect(r.markdown).not.toContain('This week you shipped');
    });

    it('opens with a quiet-week disclaimer when neither commits nor strong positives', () => {
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
        topStrongPositiveSurprise: null,
      });
      // Wave-2 review iter-1 fix A3: opener rephrased to drop kernel-tier
      // jargon ("strong positive signals") and to survive concerning-heavy
      // weeks (where "Quiet" would have been misleading).
      expect(r.markdown).toContain(
        'No commits to main this week; the sections below summarize everything else.',
      );
      expect(r.markdown).not.toContain('This week you shipped');
      expect(r.markdown).not.toContain('The strongest signal');
    });

    it('prefers the shipped-opener when both shipped AND strong positives exist', () => {
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
          commitCount: 3,
          recentSubjects: ['feat: dominant'],
        },
        topStrongPositiveSurprise: 'streak summary that should be suppressed',
      });
      // Shipped wins; the strongest-signal line does not appear in the
      // opener (the surprise itself still gets its dedicated section
      // when surprises != null — but that's a separate concern).
      expect(r.markdown).toContain('This week you shipped 3 commits to main.');
      expect(r.markdown).not.toContain('The strongest signal:');
    });
  });

  // ── Wave 2 — narrative section openers ───────────────────────────

  describe('audit-concerns narrative opener', () => {
    it('renders the singular phrasing when one claim fails', () => {
      const fail: AuditResult = {
        sessionId: 'sid-x',
        source: 'cowork',
        lineNumber: 1,
        claimType: 'tests-pass-claim',
        span: 'green',
        surroundingContext: 'ctx',
        outcome: 'fail',
        reason: 'no tool calls',
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
      // Singular "1 claim"; underlying bullet still appears.
      expect(r.markdown).toContain(
        "► 1 claim didn't have supporting tool calls this week.",
      );
      expect(r.markdown).toContain('[SID:sid-x]');
      // Singular discipline: never "1 claims".
      expect(r.markdown).not.toContain('1 claims');
    });

    it('reports the full failure count even when the bullet list is truncated', () => {
      // Generate 8 failures — top-N cap is 5 (DEFAULT_THRESHOLDS), so
      // the bullet list should be 5 long but the opener should report 8.
      const fails: AuditResult[] = Array.from({ length: 8 }, (_, i) => ({
        sessionId: `sid-${String(i).padStart(2, '0')}`,
        source: 'cowork',
        lineNumber: 1,
        claimType: 'tests-pass-claim',
        span: 'green',
        surroundingContext: 'ctx',
        outcome: 'fail',
        reason: `r${i}`,
      }));
      const r = buildDailyBrief({
        date: '2026-05-16',
        now: NOW,
        patterns: [],
        upgradeOutcomes: [],
        blogDrafts: [],
        auditResults: fails,
        auditSummary: null,
        continuumHealth: null,
      });
      expect(r.markdown).toContain(
        "► 8 claims didn't have supporting tool calls this week.",
      );
      // Top-N cap on bullets: ids 00..04 listed, 05..07 not.
      expect(r.markdown).toContain('[SID:sid-04]');
      expect(r.markdown).not.toContain('[SID:sid-05]');
    });

    it('skips the section entirely when no audit failures exist', () => {
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
      expect(r.markdown).not.toContain("didn't have supporting tool calls");
      expect(r.markdown).not.toContain('audit concern');
    });
  });

  describe('surprises STRONG framing', () => {
    it('promotes a STRONG positive into a "standout positive" sentence', () => {
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
            kind: 'streak',
            tone: 'positive',
            summary: 'big streak summary',
            score: 0.9, // STRONG (≥ 0.75)
          },
          {
            kind: 'config-helped',
            tone: 'positive',
            summary: 'moderate positive summary',
            score: 0.6, // MODERATE — must NOT promote
          },
        ]),
      });
      expect(r.markdown).toContain('The standout positive: big streak summary');
      // Moderate positive doesn't get a "standout" sentence — but it
      // still appears in the bulleted list below.
      expect(r.markdown).not.toContain(
        'The standout positive: moderate positive summary',
      );
      expect(r.markdown).toContain('[config-helped] moderate positive summary');
    });

    it('promotes a STRONG concerning into a "worth attention" sentence', () => {
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
            summary: 'a pattern recurred',
            score: 0.95,
          },
        ]),
      });
      expect(r.markdown).toContain('Worth attention: a pattern recurred');
    });

    it('omits both STRONG sentences when only MODERATE/WEAK rows exist', () => {
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
            kind: 'streak',
            tone: 'positive',
            summary: 'mid-band positive',
            score: 0.6,
          },
          {
            kind: 'trajectory-stalled',
            tone: 'concerning',
            summary: 'mid-band concerning',
            score: 0.55,
          },
        ]),
      });
      // Count header still appears…
      expect(r.markdown).toContain('► Surprises: 1 positive, 1 concerning.');
      // …but neither STRONG promotion sentence does.
      expect(r.markdown).not.toContain('The standout positive');
      expect(r.markdown).not.toContain('Worth attention');
    });
  });

  describe('singular/plural discipline', () => {
    it('renders all single-count phrasings with no trailing "s"', () => {
      const fail: AuditResult = {
        sessionId: 'sid-solo',
        source: 'cowork',
        lineNumber: 1,
        claimType: 'tests-pass-claim',
        span: 'green',
        surroundingContext: 'ctx',
        outcome: 'fail',
        reason: 'r',
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
        shippedThisWeek: { commitCount: 1, recentSubjects: ['feat: solo'] },
        appliedPatternClosures: 1,
      });
      // Spot-check the singular forms.
      expect(r.markdown).toContain('1 commit to main');
      expect(r.markdown).toContain('1 claim');
      expect(r.markdown).toContain('1 pattern you applied');
      // The 6-tuple of "1 NOUNs" we explicitly want to avoid.
      expect(r.markdown).not.toContain('1 commits');
      expect(r.markdown).not.toContain('1 claims');
      expect(r.markdown).not.toContain('1 patterns you applied');
    });
  });
});
