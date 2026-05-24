/**
 * Upgrade-outcome tracker — spec §5 Layer A (A.2).
 *
 * For each AppliedImprovement, observe the next N sessions in the affected
 * project (or all projects when the upgrade is scoped 'global'/'tool'/
 * 'request-shape' and lacks a projectId) and record:
 *
 *   - recurred:    did the pattern's regex match again in the window?
 *                  (placeholder hook — semantic recurrence is the
 *                  responsibility of A.1, which can post-process this
 *                  file and flip the bit.)
 *   - before/after metrics: mean userTurns, mean cost, errorMessage rate.
 *                  Computed over the same window vs. the N sessions
 *                  immediately prior to the application timestamp.
 *
 * Pure. The caller writes the resulting `UpgradeOutcomesFile` to
 * `analysis/upgrade-outcomes.json`.
 */

import type {
  AppliedImprovement,
  UnifiedSessionEntry,
  UpgradeOutcome,
  UpgradeOutcomesFile,
  UpgradeOutcomeMetricsSnapshot,
} from '@chat-arch/schema';

export interface BuildUpgradeOutcomesOptions {
  /** Default window size. */
  windowSize?: number;
  /** Override Date.now() for tests. */
  now?: number;
}

const DEFAULT_WINDOW_SIZE = 10;

function effectiveCost(e: UnifiedSessionEntry): number | null {
  if (e.totalCostUsd !== null) return e.totalCostUsd;
  if (e.costEstimatedUsd !== undefined && e.costEstimatedUsd !== null) {
    return e.costEstimatedUsd;
  }
  return null;
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function snapshot(entries: readonly UnifiedSessionEntry[]): UpgradeOutcomeMetricsSnapshot {
  const turns: number[] = [];
  const costs: number[] = [];
  let withError = 0;
  for (const e of entries) {
    if (typeof e.userTurns === 'number') turns.push(e.userTurns);
    const c = effectiveCost(e);
    if (c !== null) costs.push(c);
    if (typeof e.errorMessage === 'string' && e.errorMessage !== '') withError += 1;
  }
  return {
    meanUserTurns: meanOrNull(turns),
    meanCostUsd: meanOrNull(costs),
    errorMessageRate: entries.length === 0 ? null : withError / entries.length,
  };
}

/**
 * Resolve a session's "scope key" (project id or name) so we can match
 * it against an applied improvement's project scope.
 */
function sessionScopeKey(e: UnifiedSessionEntry): string | null {
  return e.projectId ?? e.project ?? null;
}

/**
 * Read the project-scope from an AppliedImprovement's payload. The
 * `proposedUpgrade.targetPath` carries the project hint for project-
 * scoped upgrades (e.g. `<repo>/CLAUDE.md`); for global / tool / request-
 * shape upgrades we treat it as "all projects".
 *
 * Heuristic: take the upgrade's `target` field — `'project-claude-md'`
 * implies project scope; anything else implies global. This is intentionally
 * conservative and lossy; A.1 can refine later.
 */
function improvementProjectScope(app: AppliedImprovement): string | null {
  if (app.proposedUpgrade.target === 'project-claude-md') {
    // The targetPath looks like `<repo>/CLAUDE.md`. We don't have a
    // mapping from repo path to projectId here — return null so the
    // outcome tracker treats it as "match any project the user was in".
    return null;
  }
  return null;
}

/**
 * Choose N sessions before / after appliedAt within the (possibly
 * project-scoped) cohort. The cohort is sorted by startedAt ascending
 * so "before" reaches back chronologically and "after" reaches forward.
 */
function pickWindow(
  cohort: readonly UnifiedSessionEntry[],
  appliedAt: number,
  windowSize: number,
): { before: UnifiedSessionEntry[]; after: UnifiedSessionEntry[] } {
  const before = cohort.filter((e) => e.startedAt < appliedAt);
  const after = cohort.filter((e) => e.startedAt >= appliedAt);
  return {
    before: before.slice(-windowSize),
    after: after.slice(0, windowSize),
  };
}

export function buildUpgradeOutcomes(
  sessions: readonly UnifiedSessionEntry[],
  applications: readonly AppliedImprovement[],
  options: BuildUpgradeOutcomesOptions = {},
): UpgradeOutcomesFile {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const now = options.now ?? Date.now();

  // Cache sessions sorted by startedAt asc so all windowing is O(N) per app.
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  // Pre-bucket by scope key for cheap per-app cohort selection.
  const byScope = new Map<string, UnifiedSessionEntry[]>();
  for (const s of sorted) {
    const key = sessionScopeKey(s) ?? '*';
    const list = byScope.get(key);
    if (list === undefined) byScope.set(key, [s]);
    else list.push(s);
  }

  const outcomes: UpgradeOutcome[] = [];
  for (const app of applications) {
    const scopeKey = improvementProjectScope(app);
    const cohort = scopeKey !== null ? (byScope.get(scopeKey) ?? sorted) : sorted;

    const { before, after } = pickWindow(cohort, app.appliedAt, windowSize);

    outcomes.push({
      appliedImprovementId: app.id,
      patternId: app.patternId,
      appliedAt: app.appliedAt,
      observedSessionIds: after.map((e) => e.id),
      windowSize,
      // Placeholder for A.1 to flip when the semantic recurrence pass
      // runs over the window. The exporter never asserts recurrence
      // directly; that's the corrections skill's job.
      recurred: false,
      metrics: {
        before: snapshot(before),
        after: snapshot(after),
      },
    });
  }

  return {
    version: 1,
    generatedAt: now,
    outcomes,
  };
}
