/**
 * Daily brief generator — spec §5 Layer D, D.1 + D.3.
 *
 * Pure function. Reads pre-loaded analysis inputs (the Node shell parses
 * each sidecar from disk) and returns the markdown body plus a small
 * summary record. Sections with zero entries are silent — no padding,
 * per D.3.
 *
 * Output shape:
 *   TODAY · YYYY-MM-DD
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   ► N patterns shifted this week
 *   ► N upgrades to propose
 *   ► N blog drafts ready for review
 *   ► N audit concerns
 *   ► Continuum health: …
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

export interface BriefThresholds {
  /** Patterns whose lastSeen falls within the last N days count as "shifted this week". */
  patternRecencyDays?: number;
  /** Top-N upgrades surfaced. */
  upgradesShown?: number;
  /** Top-N blog drafts surfaced. */
  blogDraftsShown?: number;
  /** Top-N audit concerns surfaced. */
  auditConcernsShown?: number;
}

const DEFAULT_THRESHOLDS: Required<BriefThresholds> = {
  patternRecencyDays: 7,
  upgradesShown: 5,
  blogDraftsShown: 5,
  auditConcernsShown: 5,
};

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
}

export interface DailyBriefResult {
  markdown: string;
  counts: {
    patternsShifted: number;
    upgradesShown: number;
    blogDraftsShown: number;
    auditConcernsShown: number;
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
    },
  };
}
