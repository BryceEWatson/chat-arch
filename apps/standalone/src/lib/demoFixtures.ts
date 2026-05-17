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
import type { TopAuditConcern, WorkshopStatus } from './readSidecars.ts';

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
