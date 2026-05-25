/**
 * Daily brief generator — spec §5 Layer D, D.1 + D.3, extended by
 * feed-redesign Phase γ.
 *
 * Pure function. Reads pre-loaded analysis inputs (the Node shell parses
 * each sidecar from disk and runs `git log` for the shipped-this-week
 * counter) and returns the markdown body plus a small summary record.
 * Sections with zero entries are silent — no padding, per D.3.
 *
 * Output shape (Phase γ):
 *   TODAY · YYYY-MM-DD
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   ► N patterns shifted this week
 *   ► N upgrades to propose
 *   ► N blog drafts ready for review
 *   ► N audit concerns
 *   ► Shipped this week: N commits to main      (Phase γ §1)
 *   ► Surprises today: P positive, C concerning (Phase γ §2)
 *   ► Project trajectories: A accelerating, …   (Phase γ §3)
 *   ► Applied-pattern closures: K patterns held (Phase γ §4)
 *   ► Continuum health: …
 *
 * The new sections render BETWEEN audit concerns and continuum health.
 * Each new section is independently skippable — empty inputs render
 * nothing (no header, no body), matching the existing convention.
 */

import type {
  AuditSummary,
  AuditResult,
  BlogDraftMeta,
  ContinuumHealth,
  CorrectionPattern,
  ProposedUpgrade,
  UpgradeOutcome,
} from '@chat-arch/schema';
import type { SurprisesOutput } from './computeSurprises.js';

export interface BriefThresholds {
  /** Patterns whose lastSeen falls within the last N days count as "shifted this week". */
  patternRecencyDays?: number;
  /** Top-N upgrades surfaced. */
  upgradesShown?: number;
  /** Top-N blog drafts surfaced. */
  blogDraftsShown?: number;
  /** Top-N audit concerns surfaced. */
  auditConcernsShown?: number;
  /** Top-N commit subjects surfaced under "Shipped this week". */
  shippedSubjectsShown?: number;
  /** Top-N positive-tone surprise summaries surfaced. */
  surpriseSummariesShown?: number;
  /** Top-N most-active projects surfaced under "Project trajectories". */
  trajectoriesShown?: number;
}

const DEFAULT_THRESHOLDS: Required<BriefThresholds> = {
  patternRecencyDays: 7,
  upgradesShown: 5,
  blogDraftsShown: 5,
  auditConcernsShown: 5,
  shippedSubjectsShown: 5,
  surpriseSummariesShown: 3,
  trajectoriesShown: 3,
};

/**
 * Pre-computed "shipped this week" snapshot. The Node shell runs
 * `git log --since="7 days ago" ...` against the project repo and
 * passes the count + subject lines in. Kernel stays I/O-free.
 *
 * `commitCount === 0` means the section is skipped entirely.
 * `recentSubjects` may be shorter than `commitCount` (we render the
 * top N per `shippedSubjectsShown`).
 */
export interface ShippedThisWeekInput {
  readonly commitCount: number;
  readonly recentSubjects: readonly string[];
}

/**
 * Narrow row shape for the project-trajectories sidecar. Mirrors the
 * on-disk `ProjectTrajectoryEntry` written by
 * `projectTrajectoryBuilder.ts`; keeping the kernel's input narrow so
 * we don't pull the exporter-shell type into the analysis package.
 */
export interface BriefTrajectoryRow {
  readonly projectId: string;
  readonly projectName: string;
  readonly classification:
    | 'stalling'
    | 'stalled-finished'
    | 'accelerating'
    | 'flat';
  readonly slope: number | null;
  readonly totalSessions: number;
}

export interface DailyBriefInputs {
  /** Output date in YYYY-MM-DD format. */
  date: string;
  /** Now in ms (used for the "shifted this week" window). */
  now: number;
  patterns: readonly CorrectionPattern[];
  upgradeOutcomes: readonly UpgradeOutcome[];
  blogDrafts: readonly BlogDraftMeta[];
  auditResults: readonly AuditResult[];
  auditSummary: AuditSummary | null;
  continuumHealth: ContinuumHealth | null;
  /**
   * Phase γ §1 — `git log --since="7 days ago" --pretty=format:%H main`
   * count + top subject lines. Pass `null` when the project isn't a
   * git repo or `git log` failed (section skipped).
   */
  shippedThisWeek?: ShippedThisWeekInput | null;
  /**
   * Phase γ §2 — full `analysis/surprises.json` content. Pass `null`
   * when the sidecar is missing or unparseable (section skipped).
   */
  surprises?: SurprisesOutput | null;
  /**
   * Phase γ §3 — rows from `analysis/project-trajectories.json`. Pass
   * an empty array (or `null`) when the sidecar is missing (section
   * skipped).
   */
  projectTrajectories?: readonly BriefTrajectoryRow[] | null;
  /**
   * Phase γ §4 — count of patterns currently in the watcher's
   * `holding` state (the post-application cooldown cleared with no
   * recurrence). Pass `null` when the SDK accessor is not yet wired
   * (section skipped — see code-comment in the section).
   */
  appliedPatternClosures?: number | null;
}

export interface DailyBriefResult {
  markdown: string;
  counts: {
    patternsShifted: number;
    upgradesShown: number;
    blogDraftsShown: number;
    auditConcernsShown: number;
    /** 0 when the section was skipped. */
    shippedCommits: number;
    /** Total surprise rows by tone (0 when the section was skipped). */
    surprisesPositive: number;
    surprisesConcerning: number;
    /** Total trajectory projects classified into each bucket. */
    trajectoriesAccelerating: number;
    trajectoriesFlat: number;
    trajectoriesStalling: number;
    /** 0 when the SDK accessor isn't wired (vs. 0-but-wired). */
    appliedPatternClosures: number;
  };
}

const RULE_LINE = '━'.repeat(57);

function sortByLastSeenDesc<T extends { lastSeen: number }>(a: T, b: T): number {
  return b.lastSeen - a.lastSeen;
}

function shortenRule(rule: string): string {
  const trimmed = rule.trim();
  return trimmed.length > 110 ? trimmed.slice(0, 110) + '…' : trimmed;
}

/** Truncate at 120 chars with `…` — matches the surprises kernel `clip`. */
function clip120(s: string): string {
  const max = 120;
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function pickHeadline(upgrades: readonly ProposedUpgrade[]): string {
  for (const u of upgrades) {
    if (typeof u.headline === 'string' && u.headline.length > 0) return u.headline;
  }
  if (upgrades.length > 0) {
    return shortenRule(upgrades[0]?.rationale ?? '(no rationale)');
  }
  return '(no upgrade proposal)';
}

function pickUpgradeTarget(upgrades: readonly ProposedUpgrade[]): string {
  const u = upgrades[0];
  if (u === undefined) return '?';
  return `${u.target}@${u.targetPath}`;
}

export function buildDailyBrief(inputs: DailyBriefInputs): DailyBriefResult {
  const thresholds: Required<BriefThresholds> = { ...DEFAULT_THRESHOLDS };
  const out: string[] = [];

  out.push(`TODAY · ${inputs.date}`);
  out.push(RULE_LINE);
  out.push('');

  // ---- Patterns shifted ----
  const windowStart = inputs.now - thresholds.patternRecencyDays * 24 * 3600 * 1000;
  const shifted = [...inputs.patterns]
    .filter((p) => p.lastSeen >= windowStart)
    .sort(sortByLastSeenDesc);
  if (shifted.length > 0) {
    out.push(`► ${shifted.length} pattern(s) shifted in the last ${thresholds.patternRecencyDays} days`);
    for (const p of shifted.slice(0, 5)) {
      out.push(`  • ${shortenRule(p.canonicalRule)}`);
      out.push(`    (${p.occurrenceCount} occurrence(s), scope=${p.scope.kind})`);
    }
    out.push('');
  }

  // ---- Upgrades to propose ----
  // Surface the highest-confidence patterns whose proposedUpgrade has not
  // been applied yet AND that recurred post-application (i.e. the
  // existing rule isn't working).
  const upgradeCandidates = [...inputs.patterns]
    .filter((p) => p.proposedUpgrades.length > 0)
    .filter((p) => !p.proposedUpgrades.every((u) => u.applied))
    .sort((a, b) => {
      // Recurrent unfollowed rules first, then by confidence.
      if (a.recurringPostApplication !== b.recurringPostApplication) {
        return a.recurringPostApplication ? -1 : 1;
      }
      return b.confidence - a.confidence;
    })
    .slice(0, thresholds.upgradesShown);
  if (upgradeCandidates.length > 0) {
    out.push(`► ${upgradeCandidates.length} upgrade(s) to propose`);
    for (const p of upgradeCandidates) {
      out.push(
        `  • ${pickUpgradeTarget(p.proposedUpgrades)}: "${pickHeadline(p.proposedUpgrades)}"`,
      );
      out.push(
        `    (confidence ${(p.confidence * 100).toFixed(0)}%${p.recurringPostApplication ? '; RECURRING after prior apply' : ''})`,
      );
    }
    out.push('');
  }

  // ---- Blog drafts ----
  const sortedDrafts = [...inputs.blogDrafts]
    .sort((a, b) => b.audit.passRate - a.audit.passRate)
    .slice(0, thresholds.blogDraftsShown);
  if (sortedDrafts.length > 0) {
    out.push(`► ${sortedDrafts.length} blog draft(s) ready for review`);
    for (const d of sortedDrafts) {
      const pct = (d.audit.passRate * 100).toFixed(0);
      out.push(
        `  • "${d.title}" (F: ${d.audit.passed}/${d.audit.totalClaims} verified, ${pct}%) → ${d.draftPath}`,
      );
    }
    out.push('');
  }

  // ---- Audit concerns ----
  const failures = inputs.auditResults
    .filter((r) => r.outcome === 'fail')
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .slice(0, thresholds.auditConcernsShown);
  if (failures.length > 0) {
    out.push(`► ${failures.length} audit concern(s)`);
    for (const f of failures) {
      out.push(`  • Session [SID:${f.sessionId}] claimed "${f.span}" — ${f.reason}`);
    }
    out.push('');
  }

  // ---- Phase γ §1 — Shipped this week ----
  // Skipped when `commitCount === 0` (the section is meaningless with
  // no commits, per spec). The Node shell is responsible for the
  // `git log` invocation; we just format the precomputed numbers.
  const shipped = inputs.shippedThisWeek ?? null;
  let shippedCommits = 0;
  if (shipped !== null && shipped.commitCount > 0) {
    shippedCommits = shipped.commitCount;
    out.push(
      `► Shipped this week: ${shipped.commitCount.toLocaleString()} commit(s) to main`,
    );
    for (const subject of shipped.recentSubjects.slice(
      0,
      thresholds.shippedSubjectsShown,
    )) {
      out.push(`  • ${clip120(subject)}`);
    }
    out.push('');
  }

  // ---- Phase γ §2 — Surprises today ----
  // Source: `analysis/surprises.json`. Skipped when the file is
  // missing (input is null) OR when both tones contribute zero rows.
  const surprises = inputs.surprises ?? null;
  let surprisesPositive = 0;
  let surprisesConcerning = 0;
  if (surprises !== null) {
    for (const s of surprises.surprises) {
      if (s.tone === 'positive') surprisesPositive += 1;
      else if (s.tone === 'concerning') surprisesConcerning += 1;
    }
    if (surprisesPositive + surprisesConcerning > 0) {
      out.push(
        `► Surprises today: ${surprisesPositive.toLocaleString()} positive, ` +
          `${surprisesConcerning.toLocaleString()} concerning`,
      );
      // Top 3 positive — kernel pre-sorts by score desc; just slice.
      const topPositive = surprises.surprises
        .filter((s) => s.tone === 'positive')
        .slice(0, thresholds.surpriseSummariesShown);
      for (const s of topPositive) {
        out.push(`  • [${s.kind}] ${clip120(s.summary)}`);
      }
      out.push('');
    }
  }

  // ---- Phase γ §3 — Project trajectories ----
  // Source: `analysis/project-trajectories.json`. Skipped when the
  // file is missing or empty.
  const trajectories = inputs.projectTrajectories ?? null;
  let trajectoriesAccelerating = 0;
  let trajectoriesFlat = 0;
  let trajectoriesStalling = 0;
  if (trajectories !== null && trajectories.length > 0) {
    for (const t of trajectories) {
      if (t.classification === 'accelerating') trajectoriesAccelerating += 1;
      else if (t.classification === 'flat') trajectoriesFlat += 1;
      else trajectoriesStalling += 1; // 'stalling' + 'stalled-finished'
    }
    out.push(
      `► Project trajectories: ${trajectoriesAccelerating.toLocaleString()} accelerating, ` +
        `${trajectoriesFlat.toLocaleString()} flat, ` +
        `${trajectoriesStalling.toLocaleString()} stalling/stalled`,
    );
    // Top 3 most-active by totalSessions; tie-break on projectId for
    // determinism (sort is otherwise non-stable for equal keys).
    const topActive = [...trajectories]
      .sort(
        (a, b) =>
          b.totalSessions - a.totalSessions ||
          a.projectId.localeCompare(b.projectId),
      )
      .slice(0, thresholds.trajectoriesShown);
    for (const t of topActive) {
      const slopeStr =
        t.slope === null
          ? 'slope n/a'
          : t.slope > 0
            ? `slope +${t.slope.toFixed(2)}`
            : `slope ${t.slope.toFixed(2)}`;
      out.push(
        `  • ${clip120(t.projectName)} — ${t.classification} (${slopeStr}, ` +
          `${t.totalSessions.toLocaleString()} sessions)`,
      );
    }
    out.push('');
  }

  // ---- Phase γ §4 — Applied-pattern closures ----
  // Source: the applied-pattern watcher ledger in the SQLite substrate.
  // The SDK accessor for watcher verdicts isn't wired in V1 (no
  // `applyWatcher.ts` accessor under `packages/exporter/src/db/sdk/`).
  // The shell is expected to pass `null` until the accessor lands;
  // we ALSO skip the section when the count is 0 to keep the brief
  // tight in the meantime.
  const closures = inputs.appliedPatternClosures ?? null;
  let appliedPatternClosures = 0;
  if (closures !== null && closures > 0) {
    appliedPatternClosures = closures;
    out.push(
      `► Applied-pattern closures: ${closures.toLocaleString()} pattern(s) held ` +
        `(no recurrence past cooldown)`,
    );
    out.push('');
  }

  // ---- Continuum health ----
  if (inputs.continuumHealth !== null) {
    const h = inputs.continuumHealth;
    const okLabel = h.warnings.length > 0 ? 'warning' : 'ok';
    out.push(
      `► Continuum health: ${okLabel} · ${h.consecutiveSuccesses} consecutive successful scans · ` +
        `entries ok=${h.entriesByStatus.ok} missing=${h.entriesByStatus.missing} ` +
        `crashed=${h.entriesByStatus.crashed} pruned=${h.entriesByStatus.pruned}`,
    );
    for (const w of h.warnings) {
      out.push(
        `  ! ${w.source}: ${w.kind} = ${typeof w.value === 'number' ? w.value.toFixed(2) : String(w.value)} (threshold ${w.threshold})`,
      );
    }
    out.push('');
  }

  // Always include a footer noting where the brief came from.
  out.push(`_chat-arch v2 · auto-generated brief · ${new Date(inputs.now).toISOString()}_`);

  return {
    markdown: out.join('\n') + '\n',
    counts: {
      patternsShifted: shifted.length,
      upgradesShown: upgradeCandidates.length,
      blogDraftsShown: sortedDrafts.length,
      auditConcernsShown: failures.length,
      shippedCommits,
      surprisesPositive,
      surprisesConcerning,
      trajectoriesAccelerating,
      trajectoriesFlat,
      trajectoriesStalling,
      appliedPatternClosures,
    },
  };
}
