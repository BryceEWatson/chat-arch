/**
 * F.2 — evidence verifier (spec §5 F.2).
 *
 * Pure kernel. Takes an array of AuditClaim + a session timeline (the
 * ordered list of transcript records with their tool-use + tool-result
 * payloads) and decides pass/fail/inconclusive for each claim under the
 * configured verifier window. The Node I/O shell is responsible for
 * materializing the timeline; this module never touches disk.
 *
 * Verifier table (per spec):
 *   fix-claim          → forward window for an Edit/Write tool_use
 *   tests-pass-claim   → forward window for Bash with test command,
 *                        then check the next tool_result for failure
 *   build-pass-claim   → same shape, build/tsc/compile
 *   verification-claim → forward window for ANY tool call
 *   addition-claim     → forward window for an Edit/Write
 *   completion-claim   → forward window for pushback patterns on USER
 *                        turns. Absence of pushback = pass.
 *
 * Default verdict on missing signal:
 *   - hard verifiers (fix/tests/build/addition): fail
 *   - soft verifiers (verification, completion): inconclusive
 */

import type {
  AuditClaim,
  AuditOutcome,
  AuditResult,
  ClaimType,
  ClaimTypeStats,
  AuditSummary,
} from '@chat-arch/schema';
import {
  DEFAULT_VERIFIER_WINDOWS,
  PUSHBACK_PATTERNS,
  type VerifierWindows,
} from './auditConfig.js';

/**
 * Minimal projection of a transcript record needed by the verifier.
 * The Node shell extracts these from JSONL / cloud chat_messages so the
 * kernel stays runtime-neutral.
 */
export type TimelineEvent =
  | { kind: 'assistant'; lineNumber: number; text: string }
  | { kind: 'user'; lineNumber: number; text: string }
  | {
      kind: 'tool_use';
      lineNumber: number;
      /** Tool name (e.g. 'Edit', 'Bash'). */
      name: string;
      /** Tool input as JSON (e.g. for Bash: `{ command: 'pnpm test' }`). */
      input: Record<string, unknown>;
    }
  | {
      kind: 'tool_result';
      lineNumber: number;
      /** Result text body if present. */
      text: string;
      /** True when the tool_result block was marked is_error. */
      isError: boolean;
    };

export interface VerifyClaimsOptions {
  windows?: Partial<VerifierWindows>;
}

interface VerdictPlan {
  outcome: AuditOutcome;
  reason: string;
}

/**
 * Step forward from `startIdx` over `events`, counting forward
 * occurrences of `predicate`. Returns first match or null.
 */
function findForward<T extends TimelineEvent>(
  events: readonly TimelineEvent[],
  startIdx: number,
  windowEvents: number,
  predicate: (e: TimelineEvent) => e is T,
): { event: T; idx: number } | null {
  const end = Math.min(events.length, startIdx + windowEvents + 1);
  for (let i = startIdx + 1; i < end; i += 1) {
    const e = events[i];
    if (e === undefined) continue;
    if (predicate(e)) return { event: e as T, idx: i };
  }
  return null;
}

function isToolUse(e: TimelineEvent): e is Extract<TimelineEvent, { kind: 'tool_use' }> {
  return e.kind === 'tool_use';
}
function isToolResult(e: TimelineEvent): e is Extract<TimelineEvent, { kind: 'tool_result' }> {
  return e.kind === 'tool_result';
}
function isUserTurn(e: TimelineEvent): e is Extract<TimelineEvent, { kind: 'user' }> {
  return e.kind === 'user';
}

function bashCommand(input: Record<string, unknown>): string {
  const c = input['command'];
  return typeof c === 'string' ? c : '';
}

function verifyFixOrAddition(
  events: readonly TimelineEvent[],
  claimIdx: number,
  windowSize: number,
): VerdictPlan {
  const m = findForward(events, claimIdx, windowSize, isToolUse);
  if (m === null) return { outcome: 'fail', reason: 'no Edit/Write tool use in window' };
  const name = m.event.name;
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
    return { outcome: 'pass', reason: `${name} at line ${m.event.lineNumber}` };
  }
  // A different tool use was found — try the next one to be generous.
  const m2 = findForward(events, m.idx, windowSize, isToolUse);
  if (m2 !== null && (m2.event.name === 'Edit' || m2.event.name === 'Write')) {
    return { outcome: 'pass', reason: `${m2.event.name} at line ${m2.event.lineNumber}` };
  }
  return { outcome: 'fail', reason: `no Edit/Write within ${windowSize} events (saw ${name})` };
}

function verifyTestsOrBuild(
  events: readonly TimelineEvent[],
  claimIdx: number,
  windowSize: number,
  commandSubstrings: readonly RegExp[],
  label: string,
): VerdictPlan {
  for (let i = claimIdx + 1; i < Math.min(events.length, claimIdx + windowSize + 1); i += 1) {
    const e = events[i];
    if (e === undefined || !isToolUse(e)) continue;
    if (e.name !== 'Bash') continue;
    const cmd = bashCommand(e.input);
    if (!commandSubstrings.some((re) => re.test(cmd))) continue;
    // Found a candidate Bash invocation. Check the next tool_result.
    const r = findForward(events, i, 3, isToolResult);
    if (r === null) {
      return {
        outcome: 'inconclusive',
        reason: `${label} Bash at line ${e.lineNumber} but no tool_result captured`,
      };
    }
    if (r.event.isError) {
      return {
        outcome: 'fail',
        reason: `${label} Bash exited with error at line ${r.event.lineNumber}`,
      };
    }
    // Heuristic: result body containing common failure phrases overrides
    // is_error=false (some tools report failure in stdout without setting
    // is_error). Cheap surface-form check.
    if (/\b(?:fail(?:ed|ing|s)?|error|exit code [^0]\d*|exited \d+)\b/i.test(r.event.text)) {
      return {
        outcome: 'fail',
        reason: `${label} result text contains failure marker at line ${r.event.lineNumber}`,
      };
    }
    return {
      outcome: 'pass',
      reason: `${label} Bash + clean tool_result at line ${r.event.lineNumber}`,
    };
  }
  return { outcome: 'fail', reason: `no ${label} Bash command in window` };
}

function verifyVerification(
  events: readonly TimelineEvent[],
  claimIdx: number,
  windowSize: number,
): VerdictPlan {
  const m = findForward(events, claimIdx, windowSize, isToolUse);
  if (m === null) return { outcome: 'inconclusive', reason: 'no tool use in window' };
  return { outcome: 'pass', reason: `tool use ${m.event.name} at line ${m.event.lineNumber}` };
}

function verifyCompletion(
  events: readonly TimelineEvent[],
  claimIdx: number,
  windowSize: number,
): VerdictPlan {
  let userTurnsSeen = 0;
  for (let i = claimIdx + 1; i < events.length; i += 1) {
    const e = events[i];
    if (e === undefined || !isUserTurn(e)) continue;
    userTurnsSeen += 1;
    if (userTurnsSeen > windowSize) break;
    for (const re of PUSHBACK_PATTERNS) {
      if (re.test(e.text)) {
        return {
          outcome: 'fail',
          reason: `user pushback at line ${e.lineNumber}: ${e.text.slice(0, 80)}`,
        };
      }
    }
  }
  if (userTurnsSeen === 0) {
    return { outcome: 'inconclusive', reason: 'no further user turns to check for pushback' };
  }
  return {
    outcome: 'pass',
    reason: `no pushback across next ${userTurnsSeen} user turn(s)`,
  };
}

const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
  /\btest\b/i,
  /vitest/i,
  /pytest/i,
  /\bjest\b/i,
  /pnpm\s+test/i,
  /npm\s+test/i,
];

const BUILD_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bbuild\b/i,
  /\btsc\b/i,
  /\bcompile\b/i,
  /pnpm\s+build/i,
  /npm\s+(?:run\s+)?build/i,
];

export interface VerifyClaimResult {
  result: AuditResult;
}

/**
 * Verify one claim against a per-session timeline. The caller looks up
 * the timeline event whose lineNumber equals the claim's lineNumber as
 * the starting point; if absent, the claim is marked inconclusive
 * (verifier had no anchor).
 */
export function verifyOneClaim(
  claim: AuditClaim,
  timeline: readonly TimelineEvent[],
  options: VerifyClaimsOptions = {},
): AuditResult {
  const windows = { ...DEFAULT_VERIFIER_WINDOWS, ...(options.windows ?? {}) };

  // Find the assistant event for this claim by lineNumber. We match on
  // the first assistant event with lineNumber == claim.lineNumber.
  let claimIdx = -1;
  for (let i = 0; i < timeline.length; i += 1) {
    const e = timeline[i];
    if (e !== undefined && e.kind === 'assistant' && e.lineNumber === claim.lineNumber) {
      claimIdx = i;
      break;
    }
  }
  if (claimIdx < 0) {
    return {
      ...claim,
      outcome: 'inconclusive',
      reason: 'claim line not found in timeline',
    };
  }

  let plan: VerdictPlan;
  switch (claim.claimType) {
    case 'fix-claim':
      plan = verifyFixOrAddition(timeline, claimIdx, windows.fixWindow);
      break;
    case 'addition-claim':
      plan = verifyFixOrAddition(timeline, claimIdx, windows.additionWindow);
      break;
    case 'tests-pass-claim':
      plan = verifyTestsOrBuild(
        timeline,
        claimIdx,
        windows.testsWindow,
        TEST_COMMAND_PATTERNS,
        'test',
      );
      break;
    case 'build-pass-claim':
      plan = verifyTestsOrBuild(
        timeline,
        claimIdx,
        windows.buildWindow,
        BUILD_COMMAND_PATTERNS,
        'build',
      );
      break;
    case 'verification-claim':
      plan = verifyVerification(timeline, claimIdx, windows.verificationWindow);
      break;
    case 'completion-claim':
      plan = verifyCompletion(timeline, claimIdx, windows.completionWindow);
      break;
    default: {
      // exhaustiveness: cast for TS
      const _exhaust: never = claim.claimType;
      void _exhaust;
      plan = { outcome: 'inconclusive', reason: 'unknown claim type' };
    }
  }

  return { ...claim, outcome: plan.outcome, reason: plan.reason };
}

/**
 * Aggregate per-session timelines + their claims into AuditResults +
 * an AuditSummary. The caller groups claims by sessionId and provides
 * the timeline per session.
 */
export interface VerifySessionInput {
  sessionId: string;
  timeline: readonly TimelineEvent[];
  claims: readonly AuditClaim[];
  /** Optional project label for the per-project aggregate. */
  projectKey?: string;
}

export interface VerifyResult {
  results: readonly AuditResult[];
  summary: AuditSummary;
}

const ZERO_STATS: ClaimTypeStats = { pass: 0, fail: 0, inconclusive: 0 };

export function verifySessions(
  inputs: readonly VerifySessionInput[],
  now: number,
  options: VerifyClaimsOptions = {},
): VerifyResult {
  const results: AuditResult[] = [];
  const totals: Record<AuditOutcome, number> = { pass: 0, fail: 0, inconclusive: 0 };
  const byClaimType: Record<ClaimType, ClaimTypeStats> = {
    'fix-claim': { ...ZERO_STATS },
    'tests-pass-claim': { ...ZERO_STATS },
    'verification-claim': { ...ZERO_STATS },
    'addition-claim': { ...ZERO_STATS },
    'build-pass-claim': { ...ZERO_STATS },
    'completion-claim': { ...ZERO_STATS },
  };
  const byProject: Record<string, ClaimTypeStats> = {};

  for (const inp of inputs) {
    for (const claim of inp.claims) {
      const r = verifyOneClaim(claim, inp.timeline, options);
      results.push(r);
      totals[r.outcome] += 1;
      const ct = byClaimType[r.claimType];
      ct[r.outcome] += 1;
      if (inp.projectKey !== undefined) {
        const slot = byProject[inp.projectKey] ?? { ...ZERO_STATS };
        slot[r.outcome] += 1;
        byProject[inp.projectKey] = slot;
      }
    }
  }

  // Rank claim types by fail rate descending; cap at three sample spans.
  const ranked = (Object.entries(byClaimType) as [ClaimType, ClaimTypeStats][])
    .map(([ct, stats]) => {
      const total = stats.pass + stats.fail + stats.inconclusive;
      const failRate = total === 0 ? 0 : stats.fail / total;
      return { ct, stats, failRate };
    })
    .sort((a, b) => b.failRate - a.failRate)
    .filter((x) => x.stats.fail > 0)
    .slice(0, 3);

  const topFailureClaimTypes = ranked.map(({ ct, stats, failRate }) => {
    const samples = results
      .filter((r) => r.claimType === ct && r.outcome === 'fail')
      .slice(0, 3)
      .map((r) => ({ sessionId: r.sessionId, span: r.span, reason: r.reason }));
    return { claimType: ct, failCount: stats.fail, failRate, samples };
  });

  const summary: AuditSummary = {
    version: 1,
    generatedAt: now,
    totals,
    byClaimType,
    topFailureClaimTypes,
    ...(Object.keys(byProject).length > 0 ? { byProject } : {}),
  };

  return { results, summary };
}
