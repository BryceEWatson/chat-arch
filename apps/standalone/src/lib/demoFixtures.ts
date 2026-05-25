// Shared demo fixtures for empty-state previews.
//
// Why this exists: the positioning principle (memory:
// feedback_positioning_by_features) says the UI should communicate
// what the product is by SHOWING the loop in motion, not by
// describing it in prose. Empty-states are the worst offenders —
// they substitute paragraphs for the populated structure.
//
// Each constructor returns a fully-typed object that matches the
// real sidecar shape. TypeScript catches drift when the schema
// adds a field — the demo MUST be updated alongside the populated
// path. That's the inline-drift mitigation the per-file approach
// lacked (privacy/a11y adversary #6, scope adversary F3).
//
// Content rules (mirror packages/viewer/src/data/demoUpload.test.ts
// guardrails):
//   - No verbatim user-authored CLAUDE.md rule text. Use plausible
//     fictional rules.
//   - No real session-ID prefixes. All demo SIDs use DEMO_SID_PREFIX.
//   - No real-domain emails, no real company names.

import type {
  CorrectionPattern,
  CorrectionPatternScope,
  ProposedUpgrade,
} from '@chat-arch/schema';
import type { SurprisesOutput } from '@chat-arch/analysis';
import type {
  CuratorFeedFileSsr,
  RecentNarrative,
  TopAuditConcern,
  WorkshopStatus,
} from './readSidecars.ts';

/**
 * Sentinel prefix for all demo session IDs. Keeps demo SIDs visually
 * distinct from real ones (which are random hex UUIDs) and lets tests
 * grep with `expect(html).not.toMatch(/SID:(?!demo)[0-9a-f]{8}/i)` to
 * catch any accidental real-prefix leak.
 */
export const DEMO_SID_PREFIX = 'demo0000-0000-0000-0000-';

/** Stable demo timestamps so snapshot tests stay deterministic. */
const DEMO_NOW = Date.parse('2026-05-17T10:00:00Z');
const DAY_MS = 24 * 3600 * 1000;

function demoSid(suffix: string): string {
  // Pad to 12 hex chars for the last UUID segment.
  return `${DEMO_SID_PREFIX}${suffix.padStart(12, '0')}`;
}

function makeDemoUpgrade(targetPath: string, patch: string): ProposedUpgrade {
  return {
    target: 'global-claude-md',
    targetPath,
    headline: 'prefer ripgrep over grep for codebase search',
    patch,
    rationale:
      'rg respects gitignore, is faster on large trees, and ' +
      'reads better in shared transcripts.',
    applied: false,
    appliedAt: null,
  };
}

function makeDemoPattern(args: {
  id: string;
  canonicalRule: string;
  confidence: number;
  occurrences: number;
  scopeKind: CorrectionPatternScope['kind'];
  sidSuffixes: string[];
  recurring?: boolean;
}): CorrectionPattern {
  return {
    id: args.id,
    canonicalRule: args.canonicalRule,
    instanceIds: args.sidSuffixes.map((s) => `cor_demo_${args.id}_${s}`),
    occurrenceCount: args.occurrences,
    firstSeen: DEMO_NOW - 30 * DAY_MS,
    lastSeen: DEMO_NOW - 2 * DAY_MS,
    scope: { kind: args.scopeKind },
    proposedUpgrades: [
      makeDemoUpgrade(
        '~/.claude/CLAUDE.md',
        '- Use `rg` instead of `grep` when scanning the codebase.',
      ),
    ],
    confidence: args.confidence,
    recurringPostApplication: args.recurring ?? false,
    alreadyEncoded: false,
  };
}

/**
 * Demo workshop snapshot — shows the loop in motion. Drives the
 * TODAY hero 4-metric grid + NEXT TO REVIEW row + RECENT APPLIES row.
 * Values chosen to communicate the loop verbs (to APPLY → applied →
 * still recurring → loop closure) without being so neat they read fake.
 */
export function makeDemoWorkshopStatus(): WorkshopStatus {
  return {
    unappliedPatternCount: 5,
    appliedPatternCount: 12,
    recurringAfterApplyCount: 1,
    newThisWeekCount: 3,
    topUnapplied: [
      makeDemoPattern({
        id: 'p_demo_ripgrep',
        canonicalRule: 'prefer ripgrep over grep for codebase search',
        confidence: 0.87,
        occurrences: 12,
        scopeKind: 'global',
        sidSuffixes: ['1', '2', '3'],
      }),
    ],
    recentApplies: [
      {
        id: 'p_demo_acknowledge_errors',
        ruleSummary:
          'acknowledge errors immediately, don\'t chain retries silently',
        appliedAt: Date.parse('2026-04-22T10:00:00Z'),
      },
    ],
    loopClosureRate: 0.83,
  };
}

/**
 * Demo audit concerns — drives the TODAY page's AUDIT CONCERNS row.
 * Uses real claimType enum values from packages/schema/src/audit.ts
 * (fix-claim, tests-pass-claim, build-pass-claim) with fictional
 * spans and reasons. All session IDs use DEMO_SID_PREFIX.
 */
export function makeDemoTopAuditConcerns(): TopAuditConcern[] {
  return [
    {
      sessionId: demoSid('1'),
      claimType: 'fix-claim',
      span: 'fixed the timeout',
      reason:
        'no Edit/Write in the surrounding turns; no test re-run cited',
      lineNumber: 142,
    },
    {
      sessionId: demoSid('2'),
      claimType: 'tests-pass-claim',
      span: 'tests pass',
      reason:
        'no command invocation observed; CI run was on a prior commit',
      lineNumber: 88,
    },
    {
      sessionId: demoSid('3'),
      claimType: 'build-pass-claim',
      span: 'build is clean',
      reason:
        'build output not in transcript; relied on assistant assertion',
      lineNumber: 211,
    },
  ];
}

/**
 * Demo blog-draft slug list — drives the TODAY page's BLOG DRAFTS
 * row summary line. 2 finals + 1 prompt scaffold mirrors a realistic
 * mid-mining state where the candidate selector has produced some
 * drafts and is still working on others.
 */
export function makeDemoBlogDraftSlugs(): readonly {
  slug: string;
  isPrompt: boolean;
}[] {
  return [
    {
      slug: 'the-corrections-loop-explained-2026-04-22',
      isPrompt: false,
    },
    {
      slug: 'one-script-two-trees-2026-04-29',
      isPrompt: false,
    },
    {
      slug: 'when-the-pitch-doesnt-land-2026-05-08',
      isPrompt: true,
    },
  ];
}

/**
 * Stable timestamp for the Phase β surprise / curator / narrative
 * demos. Pinned so snapshot tests stay deterministic across runs.
 */
const DEMO_GENERATED_AT_MS = 1779665200000;

/**
 * Demo daily brief — drives the BRIEF section's empty state. The body
 * mirrors the layout `regen-brief` produces (TODAY header bar, four
 * bullet sections, attribution footer) so empty-state readers see the
 * SHAPE they'll get once the brief skill runs. All session IDs use
 * DEMO_SID_PREFIX (rendered as `[SID:demo01]` after slicing).
 */
export function makeDemoLatestBrief(): { date: string; markdown: string } {
  const date = '2026-05-17';
  const body =
    `TODAY · ${date}\n` +
    '━━━━━━━━━━━━━━━━━━\n' +
    '► 3 audit concern(s)\n' +
    `  • Session [SID:${demoSid('1').slice(0, 8)}] claimed "fixed the timeout" with no Edit/Write\n` +
    `  • Session [SID:${demoSid('2').slice(0, 8)}] claimed "tests pass" with no command invocation\n` +
    '► Shipped this week: 12 commit(s) to main\n' +
    '  • feat(demo): example commit landing the loop\n' +
    '  • fix(demo): repair an empty-state regression\n' +
    '► Surprises today: 4 positive, 1 concerning\n' +
    '  • [streak] 7 sessions in a row with all-green outcomes\n' +
    '  • [decision-paid-off] adopting ripgrep dropped re-prompt rate\n' +
    '► Continuum health: ok · 5 consecutive successful scans\n' +
    '\n' +
    '_chat-arch demo · auto-generated brief_\n';
  return { date, markdown: body };
}

/**
 * Demo surprises — drives the NEW + BROKEN section card grids. Mixes 3
 * positive kinds (streak / trajectory-accelerating / decision-paid-off)
 * + 2 concerning kinds (trajectory-stalled / debt-spinning) so both
 * sections see populated cards. Every summary is ≤120 chars (matches
 * the Surprise contract); evidence references DEMO_SID_PREFIX SIDs and
 * `demo-project-N` ids so the show-don't-describe contract holds
 * end-to-end (the SID-leak guard in empty-state-contracts.test.ts
 * rejects any 8-hex SID not starting with `demo`).
 *
 * `generatedAt` is fixed to DEMO_GENERATED_AT_MS so snapshot tests
 * stay deterministic — the kernel's defaults snapshot is structural
 * only; the values here mirror THRESHOLDS.surprises defaults at the
 * time of writing (kernel-derived; not load-bearing for the demo).
 */
export function makeDemoSurprises(): SurprisesOutput {
  return {
    version: 1,
    generatedAt: DEMO_GENERATED_AT_MS,
    surprises: [
      {
        id: 'sur_demo_streak_1',
        kind: 'streak',
        tone: 'positive',
        summary: '7 sessions in a row with all-green outcomes — longest run this month.',
        evidence: {
          sessionIds: [demoSid('s1'), demoSid('s2'), demoSid('s3'), demoSid('s4')],
        },
        score: 0.92,
        generatedAt: DEMO_GENERATED_AT_MS,
      },
      {
        id: 'sur_demo_trajectory_acc_1',
        kind: 'trajectory-accelerating',
        tone: 'positive',
        summary: 'demo-project-A composite score climbed +18% over the last 2 weeks.',
        evidence: {
          projectId: 'demo-project-A',
          sessionIds: [demoSid('a1'), demoSid('a2')],
        },
        score: 0.78,
        generatedAt: DEMO_GENERATED_AT_MS,
      },
      {
        id: 'sur_demo_decision_paid_1',
        kind: 'decision-paid-off',
        tone: 'positive',
        summary: 'Adopting ripgrep dropped average re-prompt rate by 23% on demo-project-B.',
        evidence: {
          decisionId: 'dec_demo_ripgrep',
          projectId: 'demo-project-B',
          sessionIds: [demoSid('d1')],
        },
        score: 0.71,
        generatedAt: DEMO_GENERATED_AT_MS,
      },
      {
        id: 'sur_demo_trajectory_stall_1',
        kind: 'trajectory-stalled',
        tone: 'concerning',
        summary: 'demo-project-C composite score flat for 3 weeks despite 14 sessions invested.',
        evidence: {
          projectId: 'demo-project-C',
          sessionIds: [demoSid('c1'), demoSid('c2')],
        },
        score: 0.66,
        generatedAt: DEMO_GENERATED_AT_MS,
      },
      {
        id: 'sur_demo_debt_spin_1',
        kind: 'debt-spinning',
        tone: 'concerning',
        summary: '"how do I bind a port in Astro?" asked 9 times this month across 4 projects.',
        evidence: {
          sessionIds: [demoSid('k1'), demoSid('k2'), demoSid('k3')],
        },
        score: 0.58,
        generatedAt: DEMO_GENERATED_AT_MS,
      },
    ],
    thresholds: {
      streakMin: 5,
      itsQValueMax: 0.1,
      itsDeltaMin: 0.15,
      reflexiveDeltaMin: 0.1,
      reflexiveEValueMin: 1.5,
      decisionGoodFollowupsMin: 3,
      debtSpinningTopK: 5,
      debtSpinningMinClusterSize: 4,
    },
  };
}

/**
 * Demo curator feed — drives the ACT section's CURATED FEED list when
 * the /curate skill hasn't run yet. 5 items mix the three known kinds
 * (`narrative` / `knowledge-debt` / `applied-pattern`) so the kind-
 * coloured badges all render at least once. Verified status sprinkled
 * so the green "verified" pill shows. Stable shape matches
 * `CuratorFeedFileSsr` in readSidecars.ts.
 */
export function makeDemoCuratorFeed(): CuratorFeedFileSsr {
  return {
    schemaVersion: 1,
    generatedAt: DEMO_GENERATED_AT_MS,
    ranAt: '2026-05-17T10:00:00.000Z',
    items: [
      {
        kind: 'narrative',
        entityId: 'nar_demo_first_principles',
        title: 'First-principles framing precedes pass-verdict outcomes',
        rank: 1,
        compositeScore: 0.89,
        falsifierStatus: 'verified',
        reasoning: 'tier-3 narrative with 4 supporting evidence rows.',
      },
      {
        kind: 'knowledge-debt',
        entityId: 'kd_demo_port_binding',
        title: '"how do I bind a port in Astro?" — asked 9× across 4 projects',
        rank: 2,
        compositeScore: 0.81,
        falsifierStatus: 'unavailable',
        reasoning: 'cluster size 9 exceeds debtSpinningMinClusterSize floor.',
      },
      {
        kind: 'applied-pattern',
        entityId: 'pat_demo_ripgrep',
        title: 'prefer ripgrep over grep for codebase search',
        rank: 3,
        compositeScore: 0.74,
        tieBrokenByCorrelation: true,
        falsifierStatus: 'verified',
        reasoning: 'pattern is holding 11 weeks post-apply.',
      },
      {
        kind: 'narrative',
        entityId: 'nar_demo_adversarial_review',
        title: 'Adversarial review precedes ship-readiness verdicts',
        rank: 4,
        compositeScore: 0.69,
        falsifierStatus: 'unavailable',
        reasoning: 'tier-2 narrative; awaiting verifier pass.',
      },
      {
        kind: 'knowledge-debt',
        entityId: 'kd_demo_cors_setup',
        title: '"CORS preflight failing on /api/*" — asked 5× this month',
        rank: 5,
        compositeScore: 0.61,
        falsifierStatus: 'skipped-by-user',
        reasoning: 'cluster size below tie-breaker but recent surge.',
      },
    ],
  };
}

/**
 * Demo recent narratives — drives the STORIES section's narrative list
 * when narratives.json is missing. 5 items across all three sentiment
 * buckets (positive / negative / neutral) and three demo project ids
 * so the sentiment-coloured pills + project links all render at least
 * once. Generated-at strings use ISO format so the page's `.slice(0,10)`
 * date crop produces a stable YYYY-MM-DD.
 */
export function makeDemoRecentNarratives(): RecentNarrative[] {
  return [
    {
      id: 'nar_demo_first_principles',
      title: 'First-principles framing precedes pass-verdict outcomes',
      sentiment: 'positive',
      projectId: 'demo-project-A',
      sessionIds: [demoSid('n1'), demoSid('n2')],
      generatedAt: '2026-05-15T14:30:00.000Z',
    },
    {
      id: 'nar_demo_test_skip_drift',
      title: 'Skipped tests accumulate then surface as silent regressions',
      sentiment: 'negative',
      projectId: 'demo-project-B',
      sessionIds: [demoSid('n3')],
      generatedAt: '2026-05-14T09:15:00.000Z',
    },
    {
      id: 'nar_demo_adversarial_review',
      title: 'Adversarial review precedes ship-readiness verdicts',
      sentiment: 'positive',
      projectId: 'demo-project-A',
      sessionIds: [demoSid('n4'), demoSid('n5'), demoSid('n6')],
      generatedAt: '2026-05-12T18:42:00.000Z',
    },
    {
      id: 'nar_demo_session_handoff',
      title: 'Session handoffs lose context about prior tool-call rationale',
      sentiment: 'neutral',
      projectId: 'demo-project-C',
      sessionIds: [demoSid('n7')],
      generatedAt: '2026-05-11T11:00:00.000Z',
    },
    {
      id: 'nar_demo_loop_closure',
      title: 'Applied patterns close the loop within 2 weeks 80% of the time',
      sentiment: 'positive',
      projectId: 'demo-project-B',
      sessionIds: [demoSid('n8'), demoSid('n9')],
      generatedAt: '2026-05-09T16:20:00.000Z',
    },
  ];
}
