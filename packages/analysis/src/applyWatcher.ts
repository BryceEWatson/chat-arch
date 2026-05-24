// Phase Rev3-E E4 + E5 — next-sessions watcher for Closure C
// (applied-rule outcome).
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §"Three
// closures" (Closure C):
//
//   "After the optional CLAUDE.md append, the next-sessions watcher
//    activates. Watcher closes by whichever fires first:
//      (a) `THRESHOLDS.appliedRuleWatcher.watcherSessionsN` sessions
//          observed in the target project (default 5),
//      (b) `THRESHOLDS.appliedRuleWatcher.watcherWallClockDays`
//          elapsed (default 60 days),
//      (c) explicit user-side close.
//    Wall-clock timeout emits a `WATCH_INCONCLUSIVE` Narrative at low
//    feed priority — not silence. Project inactivity ≥
//    `THRESHOLDS.appliedRuleWatcher.staleProjectDays` (default 30)
//    before N is reached invalidates the watch entirely; a fresh
//    watcher starts on project re-entry. Recurrence within the watch
//    window → `RECURRING_AFTER_APPLIED` Narrative emitted.
//    Non-recurrence → confidence-up on the original pattern."
//
// This module owns the *pure decision*: given a Pattern + the
// project's subsequent sessions + the project's subsequent
// narratives + a "now" clock, return a `WatcherVerdict` enum. The
// orchestration (who emits findings, who confidence-bumps the
// Pattern row) lands in Rev3-F when the curator runs the kernel
// against live data. Keeping the decision-pure makes the kernel
// deterministic + testable without a DB.

import { THRESHOLDS } from './thresholds.js';

const MS_PER_DAY = 86_400_000;

/**
 * The four terminal verdicts plus the holding-open "we don't know
 * yet" state. Encode as a tagged union so each outcome can carry
 * its own evidence (which narrative triggered recurrence, how many
 * sessions cleared the bar, etc.) without forcing callers to crack
 * a stringly-typed enum + parallel evidence map.
 */
export type WatcherVerdict =
  /** Watch is still active — not enough signal to close. */
  | { readonly kind: 'open' }
  /**
   * N sessions observed in the project after the pattern was applied
   * with no recurrence. Confidence-up on the original Pattern.
   */
  | { readonly kind: 'holding'; readonly sessionsObserved: number }
  /**
   * A narrative whose sentiment indicates the original problem
   * recurred fired in the project after the pattern was applied.
   * Emit `RECURRING_AFTER_APPLIED` carrying the offending narrative
   * id so the UI can link from the Pattern to "this is what re-
   * appeared after you applied the rule."
   */
  | {
      readonly kind: 'recurring';
      readonly recurrenceNarrativeId: string;
      readonly recurrenceGeneratedAt: string;
    }
  /**
   * Wall-clock timeout or project-inactivity invalidation. Emits a
   * low-priority `WATCH_INCONCLUSIVE` Narrative — explicit "we
   * couldn't decide" beats silence (the user shouldn't have to
   * remember they applied a rule 60 days ago that no one ever
   * re-evaluated).
   */
  | {
      readonly kind: 'inconclusive';
      readonly reason: 'wall-clock-timeout' | 'project-inactive';
    };

/**
 * Minimal session shape the watcher needs. Wider shapes from the
 * SDK / manifest are fine — TypeScript structural typing accepts any
 * superset.
 */
export interface WatcherSessionLike {
  readonly id: string;
  /** ms since epoch (UnifiedSessionEntry convention). */
  readonly startedAt: number;
  /** ms since epoch — used to detect project inactivity. */
  readonly updatedAt: number;
  /**
   * `projectId` is what we filter by; passed through so callers don't
   * have to pre-filter (kernel ignores sessions that don't belong).
   */
  readonly projectId?: string | null;
}

/**
 * Minimal narrative shape the watcher needs. The recurrence test is
 * "non-positive sentiment generated in the same project after
 * `pattern.encodedAt`." Until Rev3-F's falsifier wires a proper
 * recurrence-detector to the curator pipeline, the sentiment check
 * is the deterministic fallback — it's coarse but transparent.
 */
export interface WatcherNarrativeLike {
  readonly id: string;
  readonly projectId: string;
  /** ISO-8601 string per existing narrative convention. */
  readonly generatedAt: string;
  readonly sentiment: 'positive' | 'negative' | 'mixed' | 'neutral' | string;
}

/**
 * Minimal pattern shape — `encodedAt` is the watch-start clock,
 * `projectId` is what we filter sessions+narratives by, `id` is
 * carried through to findings for back-reference.
 */
export interface WatcherPatternLike {
  readonly id: string;
  readonly projectId: string;
  /** ISO-8601 string (matches `Pattern.encodedAt`). */
  readonly encodedAt: string;
}

export interface WatcherInput {
  readonly pattern: WatcherPatternLike;
  /**
   * All sessions in the project (the kernel filters by `projectId`
   * + `startedAt > encodedAt` itself). Pass the project's full list
   * unfiltered — the kernel won't crash on foreign sessions.
   */
  readonly projectSessions: readonly WatcherSessionLike[];
  /**
   * All narratives in the project (kernel filters internally).
   */
  readonly projectNarratives: readonly WatcherNarrativeLike[];
  /**
   * ms since epoch. Test seam — production callers pass `Date.now()`.
   */
  readonly now: number;
}

/**
 * Closure C decision kernel. Order of closure paths matters: wall-
 * clock timeout takes precedence (you don't want a 61-day-old watch
 * sitting "open" because it also lacks N sessions); recurrence
 * comes next (a single recurring narrative is more informative than
 * "no recurrence" even if N sessions also passed); project-inactive
 * comes after recurrence (a project that died after a few sessions
 * is inconclusive, not holding); holding fires last (N sessions
 * with no recurrence + still-active project).
 *
 * Defensive contract: malformed `encodedAt` returns `{ kind: 'open' }`
 * (never throws). Malformed narrative `generatedAt` skips that
 * narrative for recurrence checks but doesn't crash the kernel.
 */
export function evaluateAppliedPatternWatcher(
  input: WatcherInput,
): WatcherVerdict {
  const encodedAtMs = Date.parse(input.pattern.encodedAt);
  if (!Number.isFinite(encodedAtMs)) {
    return { kind: 'open' };
  }
  const W = THRESHOLDS.appliedRuleWatcher;

  // ── Path 1: wall-clock timeout takes absolute precedence ────────
  const ageDays = (input.now - encodedAtMs) / MS_PER_DAY;
  if (ageDays >= W.watcherWallClockDays) {
    return { kind: 'inconclusive', reason: 'wall-clock-timeout' };
  }

  // ── Path 2: recurrence beats holding ────────────────────────────
  // Find the EARLIEST recurring narrative so the watcher closes on
  // first recurrence (later recurrences don't change the verdict).
  let earliestRecurrence: WatcherNarrativeLike | null = null;
  let earliestRecurrenceMs = Number.POSITIVE_INFINITY;
  for (const n of input.projectNarratives) {
    if (n.projectId !== input.pattern.projectId) continue;
    if (n.sentiment === 'positive') continue;
    const ts = Date.parse(n.generatedAt);
    if (!Number.isFinite(ts)) continue;
    if (ts <= encodedAtMs) continue;
    if (ts < earliestRecurrenceMs) {
      earliestRecurrence = n;
      earliestRecurrenceMs = ts;
    }
  }
  if (earliestRecurrence !== null) {
    return {
      kind: 'recurring',
      recurrenceNarrativeId: earliestRecurrence.id,
      recurrenceGeneratedAt: earliestRecurrence.generatedAt,
    };
  }

  // ── Path 3 + 4: count post-application sessions, check inactivity
  const postSessions: WatcherSessionLike[] = [];
  let lastActivityMs = encodedAtMs;
  for (const s of input.projectSessions) {
    if (s.projectId !== undefined && s.projectId !== null && s.projectId !== input.pattern.projectId) {
      continue;
    }
    if (s.startedAt <= encodedAtMs) continue;
    postSessions.push(s);
    if (s.updatedAt > lastActivityMs) lastActivityMs = s.updatedAt;
  }
  const daysSinceActivity = (input.now - lastActivityMs) / MS_PER_DAY;
  // Project-inactivity invalidates BEFORE N is reached. If we already
  // have N sessions, "inactive since" doesn't apply — the holding
  // verdict beats it because the window already closed naturally.
  if (
    postSessions.length < W.watcherSessionsN &&
    daysSinceActivity >= W.staleProjectDays
  ) {
    return { kind: 'inconclusive', reason: 'project-inactive' };
  }
  if (postSessions.length >= W.watcherSessionsN) {
    return { kind: 'holding', sessionsObserved: postSessions.length };
  }

  // Otherwise, the watch is still active — not enough signal yet.
  return { kind: 'open' };
}
