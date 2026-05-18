/**
 * Server-side sidecar loaders for the v2 chrome pages.
 *
 * SSR-only — these helpers read from `apps/standalone/public/chat-arch-
 * data/analysis/*` at request time and return parsed JSON / markdown
 * strings. Used by the Today / /audit / /health / /blog-drafts pages.
 *
 * Resilient: every loader returns null on missing or unreadable file.
 * The pages render an empty-state when a sidecar is absent — meaning
 * "no rescan has populated this yet", not "broken".
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppliedImprovementsFile,
  AuditResultsFile,
  AuditSummary,
  BlogCandidatesFile,
  ContinuumHealth,
  CorrectionPattern,
  CorrectionsFile,
  UpgradeOutcomesFile,
} from '@chat-arch/schema';

function dataDir(): string {
  return path.join(process.cwd(), 'public', 'chat-arch-data');
}

function analysisDir(): string {
  return path.join(dataDir(), 'analysis');
}

async function readJson<T>(absPath: string): Promise<T | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readContinuumHealth(): Promise<ContinuumHealth | null> {
  return readJson<ContinuumHealth>(path.join(analysisDir(), 'continuum-health.json'));
}

export async function readAuditResults(): Promise<AuditResultsFile | null> {
  return readJson<AuditResultsFile>(path.join(analysisDir(), 'audit-results.json'));
}

export async function readAuditSummary(): Promise<AuditSummary | null> {
  return readJson<AuditSummary>(path.join(analysisDir(), 'audit-summary.json'));
}

export async function readBlogCandidates(): Promise<BlogCandidatesFile | null> {
  return readJson<BlogCandidatesFile>(path.join(analysisDir(), 'blog-candidates.json'));
}

export async function readCorrections(): Promise<CorrectionsFile | null> {
  return readJson<CorrectionsFile>(path.join(analysisDir(), 'corrections.json'));
}

/**
 * Count of heuristic-recall correction candidates on disk. Used by the
 * TODAY page's WORKSHOP LOOP empty branch to render "the heuristic has
 * detected N candidates" — a real signal that something ran on this
 * machine, distinct from the demo grid that surrounds it. Returns 0
 * when the file is absent (hosted build, or no scan yet).
 */
export async function readCorrectionCandidatesCount(): Promise<number> {
  const file = await readJson<{ corrections?: readonly unknown[] }>(
    path.join(analysisDir(), 'correction-candidates.json'),
  );
  return file?.corrections?.length ?? 0;
}

/**
 * Read both the candidate count AND the scan-stats summary in a single
 * file read. Drives the TODAY page's "scanned but not mined" state:
 * after `pnpm exporter all` runs, `correction-candidates.json` has
 * 100s of raw heuristic-recall items, but `corrections.json` is still
 * absent because the mine-corrections skill hasn't run. The page can
 * render a real-data card ("N candidates from M of K sessions · MINE
 * CORRECTIONS to classify") instead of demo metrics. Returns null when
 * the file is absent.
 */
export interface CorrectionCandidatesSummary {
  candidateCount: number;
  sessionsScanned: number;
  sessionsInManifest: number;
}
export async function readCorrectionCandidatesSummary(): Promise<CorrectionCandidatesSummary | null> {
  const file = await readJson<{
    corrections?: readonly unknown[];
    scanStats?: { sessionsScanned?: number; sessionsInManifest?: number };
  }>(path.join(analysisDir(), 'correction-candidates.json'));
  if (file === null) return null;
  return {
    candidateCount: file.corrections?.length ?? 0,
    sessionsScanned: file.scanStats?.sessionsScanned ?? 0,
    sessionsInManifest: file.scanStats?.sessionsInManifest ?? 0,
  };
}

export async function readUpgradeOutcomes(): Promise<UpgradeOutcomesFile | null> {
  return readJson<UpgradeOutcomesFile>(path.join(analysisDir(), 'upgrade-outcomes.json'));
}

export async function readAppliedImprovements(): Promise<AppliedImprovementsFile | null> {
  return readJson<AppliedImprovementsFile>(
    path.join(analysisDir(), 'applied-improvements.json'),
  );
}

/**
 * Workshop-loop snapshot — the load-bearing data the Today page leads
 * with. Computed at request time so a freshly-completed mine-corrections
 * run reflects immediately.
 */
export interface WorkshopStatus {
  /** Patterns mined but not yet APPLY'd by the user. */
  unappliedPatternCount: number;
  /** Patterns whose top-confidence upgrade already shipped. */
  appliedPatternCount: number;
  /** Patterns the F-layer / heuristic detects RECURRING after apply. */
  recurringAfterApplyCount: number;
  /** New-since-N-days bucket — "what's worth looking at this week". */
  newThisWeekCount: number;
  /** Top-confidence unapplied patterns the user might tackle next. */
  topUnapplied: readonly CorrectionPattern[];
  /** Most-recent applied improvements, newest first (cap 5). */
  recentApplies: readonly { id: string; ruleSummary: string; appliedAt: number }[];
  /** Aggregate "loop closure" rate — closed / total where outcomes exist. */
  loopClosureRate: number | null;
}

const WORKSHOP_RECENCY_DAYS = 7;
const WORKSHOP_TOP_N = 5;

export async function readWorkshopStatus(now: number = Date.now()): Promise<WorkshopStatus> {
  const corrections = await readCorrections();
  const applied = await readAppliedImprovements();
  const outcomes = await readUpgradeOutcomes();

  const patterns = corrections?.patterns ?? [];
  const recencyCutoff = now - WORKSHOP_RECENCY_DAYS * 24 * 3600 * 1000;

  const appliedPatternIds = new Set<string>();
  for (const a of applied?.entries ?? []) appliedPatternIds.add(a.patternId);

  let unapplied: CorrectionPattern[] = [];
  let appliedCount = 0;
  let recurringAfterApply = 0;
  let newThisWeek = 0;
  for (const p of patterns) {
    if (appliedPatternIds.has(p.id)) {
      appliedCount += 1;
      if (p.recurringPostApplication) recurringAfterApply += 1;
    } else {
      unapplied.push(p);
    }
    if (p.lastSeen >= recencyCutoff) newThisWeek += 1;
  }
  unapplied = [...unapplied].sort((a, b) => b.confidence - a.confidence);
  const topUnapplied = unapplied.slice(0, WORKSHOP_TOP_N);

  const recentApplies = (applied?.entries ?? [])
    .slice()
    .sort((a, b) => b.appliedAt - a.appliedAt)
    .slice(0, WORKSHOP_TOP_N)
    .map((a) => ({ id: a.id, ruleSummary: a.ruleSummary, appliedAt: a.appliedAt }));

  // Loop closure: of outcomes that have BOTH before and after metrics with
  // any signal, how many show recurred === false?
  let closed = 0;
  let totalWithSignal = 0;
  for (const o of outcomes?.outcomes ?? []) {
    if (o.observedSessionIds.length === 0) continue;
    totalWithSignal += 1;
    if (!o.recurred) closed += 1;
  }
  const loopClosureRate = totalWithSignal === 0 ? null : closed / totalWithSignal;

  return {
    unappliedPatternCount: unapplied.length,
    appliedPatternCount: appliedCount,
    recurringAfterApplyCount: recurringAfterApply,
    newThisWeekCount: newThisWeek,
    topUnapplied,
    recentApplies,
    loopClosureRate,
  };
}

/**
 * Top-N audit failures clustered loosely by claim type — the "audit
 * concerns" demoted section on the Today page wants a SHORT list of
 * strongest signals, not the 1194-row table that lives on /audit.
 */
export interface TopAuditConcern {
  sessionId: string;
  span: string;
  reason: string;
  claimType: string;
  lineNumber: number;
}

export async function readTopAuditConcerns(limit: number = 5): Promise<TopAuditConcern[]> {
  const results = await readAuditResults();
  if (results === null) return [];
  const fails = results.results
    .filter((r) => r.outcome === 'fail')
    // Prefer fix-claim + tests-pass-claim failures — those are the most
    // surprising overstated-completion signal vs. e.g. addition-claim
    // (which often misses Edit/Write that happened in a different turn).
    .sort((a, b) => {
      const order: Record<string, number> = {
        'fix-claim': 0,
        'tests-pass-claim': 1,
        'build-pass-claim': 2,
        'completion-claim': 3,
        'verification-claim': 4,
        'addition-claim': 5,
      };
      return (order[a.claimType] ?? 9) - (order[b.claimType] ?? 9);
    });
  // De-duplicate by (sessionId, claimType) so one chatty session doesn't
  // dominate the top list.
  const seen = new Set<string>();
  const picks: TopAuditConcern[] = [];
  for (const r of fails) {
    const key = `${r.sessionId}::${r.claimType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({
      sessionId: r.sessionId,
      span: r.span,
      reason: r.reason,
      claimType: r.claimType,
      lineNumber: r.lineNumber,
    });
    if (picks.length >= limit) break;
  }
  return picks;
}

/**
 * Read the most-recent daily brief markdown from analysis/briefs/.
 * Returns { date, markdown } or null when no brief exists.
 */
export async function readLatestBrief(): Promise<{ date: string; markdown: string } | null> {
  const dir = path.join(analysisDir(), 'briefs');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const matches = entries.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
  const latest = matches[matches.length - 1];
  if (latest === undefined) return null;
  try {
    const md = await readFile(path.join(dir, latest), 'utf8');
    return { date: latest.replace(/\.md$/, ''), markdown: md };
  } catch {
    return null;
  }
}

/**
 * Read a specific blog draft (or its prompt fallback) by slug. The
 * caller is responsible for sanitizing `slug` — we resolve and assert
 * containment to defeat any path-traversal attempt regardless.
 */
export async function readBlogDraft(
  slug: string,
): Promise<{ markdown: string; isPrompt: boolean } | null> {
  const dir = path.join(analysisDir(), 'blog-drafts');
  const baseAbs = path.resolve(dir);
  for (const candidate of [`${slug}.md`, `${slug}.prompt.md`]) {
    const abs = path.resolve(baseAbs, candidate);
    const rel = path.relative(baseAbs, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      const md = await readFile(abs, 'utf8');
      return { markdown: md, isPrompt: candidate.endsWith('.prompt.md') };
    } catch {
      // Try the next variant.
    }
  }
  return null;
}

/**
 * List the slugs of every available blog draft / draft prompt.
 * Returns both the bare slug and whether the file is the prompt
 * variant only (no final draft yet).
 */
export async function listBlogDraftSlugs(): Promise<
  { slug: string; isPrompt: boolean }[]
> {
  const dir = path.join(analysisDir(), 'blog-drafts');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const seen = new Map<string, { slug: string; isPrompt: boolean }>();
  for (const n of entries) {
    if (!n.endsWith('.md')) continue;
    const isPrompt = n.endsWith('.prompt.md');
    const slug = isPrompt ? n.replace(/\.prompt\.md$/, '') : n.replace(/\.md$/, '');
    // Final draft wins over its prompt variant.
    const existing = seen.get(slug);
    if (existing === undefined || (existing.isPrompt && !isPrompt)) {
      seen.set(slug, { slug, isPrompt });
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.slug.localeCompare(a.slug));
}
