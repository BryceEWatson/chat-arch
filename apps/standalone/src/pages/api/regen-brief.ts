/**
 * `/api/regen-brief` — rebuild analysis/briefs/{YYYY-MM-DD}.md from the
 * current on-disk sidecars without re-scanning or re-embedding. Used by
 * the Today page's REGEN BRIEF button after mine-corrections has run
 * (or after the user manually edits a sidecar) so the brief reflects
 * the latest data without a full `pnpm exporter analyze` cycle.
 *
 * CSRF: same shape as rescan / mine-corrections — Origin must parse to
 * a local hostname AND `X-Requested-With: chat-arch-regen-brief`.
 */
import type { APIRoute } from 'astro';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  buildDailyBrief,
  SURPRISE_TIER_STRONG_MIN,
  type BriefTrajectoryRow,
  type SurprisesOutput,
} from '@chat-arch/analysis';
import type {
  AuditResultsFile,
  AuditSummary,
  BlogDraftsIndexFile,
  ContinuumHealth,
  CorrectionsFile,
  UpgradeOutcomesFile,
} from '@chat-arch/schema';

const execFileAsync = promisify(execFile);

/**
 * Project-trajectories sidecar shape. We only need the four fields the
 * brief renders, so we narrow the on-disk type here instead of pulling
 * the full `ProjectTrajectoriesFile` from the exporter package (which
 * would create a cross-app dependency we don't otherwise have).
 */
interface ProjectTrajectoriesFileShape {
  projects?: ReadonlyArray<{
    projectId: string;
    projectName: string;
    classification: BriefTrajectoryRow['classification'];
    slope: number | null;
    totalSessions: number;
  }>;
}

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-regen-brief';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

function reject(status: number, reason: string): Response {
  return new Response(JSON.stringify({ ok: false, error: reason }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function dataDirAbs(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/standalone/src/pages/api/regen-brief.ts → repo root (5 up)
  const repoRoot = resolve(here, '..', '..', '..', '..', '..');
  return join(repoRoot, 'apps', 'standalone', 'public', 'chat-arch-data');
}

async function readJsonOrNull<T>(absPath: string): Promise<T | null> {
  try {
    const raw = await readFile(absPath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Locate the repo root by walking up from this file. We mirror the same
 * 5-level climb that `dataDirAbs()` uses; resolving once and re-using
 * keeps the two paths consistent.
 */
function repoRootAbs(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

/**
 * Run `git log --since="7 days ago" ... main` against the repo root.
 * Returns `null` on any failure (not a git repo, no `main` branch,
 * `git` not on PATH, etc.) so the kernel skips the section cleanly.
 *
 * We pass each `git log` flag as a separate argv entry to `execFile`
 * so no shell quoting is involved. Bounded `maxBuffer` (256KB) caps
 * the output for very busy weeks; we'd still get the count line even
 * if the subject lines were truncated.
 */
async function shippedThisWeekFromGit(
  repoRoot: string,
): Promise<{ commitCount: number; recentSubjects: string[] } | null> {
  try {
    const [countResult, subjectsResult] = await Promise.all([
      execFileAsync(
        'git',
        ['log', '--since=7 days ago', '--pretty=format:%H', 'main'],
        { cwd: repoRoot, maxBuffer: 256 * 1024 },
      ),
      execFileAsync(
        'git',
        ['log', '--since=7 days ago', '--pretty=format:%s', 'main'],
        { cwd: repoRoot, maxBuffer: 256 * 1024 },
      ),
    ]);
    const commitCount = countResult.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
    const recentSubjects = subjectsResult.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .slice(0, 5);
    return { commitCount, recentSubjects };
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return reject(403, 'Forbidden: non-local origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return reject(403, 'Forbidden: missing CSRF header');
  }

  const dataDir = dataDirAbs();
  const analysisDir = join(dataDir, 'analysis');
  const briefsDir = join(analysisDir, 'briefs');
  await mkdir(briefsDir, { recursive: true });

  const corrections = await readJsonOrNull<CorrectionsFile>(
    join(analysisDir, 'corrections.json'),
  );
  const auditResults = await readJsonOrNull<AuditResultsFile>(
    join(analysisDir, 'audit-results.json'),
  );
  const auditSummary = await readJsonOrNull<AuditSummary>(
    join(analysisDir, 'audit-summary.json'),
  );
  const continuumHealth = await readJsonOrNull<ContinuumHealth>(
    join(analysisDir, 'continuum-health.json'),
  );
  const upgradeOutcomes = await readJsonOrNull<UpgradeOutcomesFile>(
    join(analysisDir, 'upgrade-outcomes.json'),
  );
  // Phase γ §2 — `analysis/surprises.json` (produced by the surprises
  // builder). Fail-soft: missing/unparseable ⇒ kernel skips the
  // section.
  const surprises = await readJsonOrNull<SurprisesOutput>(
    join(analysisDir, 'surprises.json'),
  );
  // Wave 2 — top STRONG positive summary for the journal-y opener.
  // Kernel's `computeSurprises` pre-sorts by score desc, so the first
  // positive row meeting the STRONG floor (score ≥
  // SURPRISE_TIER_STRONG_MIN) is the highest-confidence surprise the
  // user shipped this week. Passed as a precomputed string so the
  // kernel stays decoupled from the surprise-tier helper.
  const topStrongPositiveSurprise: string | null =
    surprises?.surprises.find(
      (s) => s.tone === 'positive' && s.score >= SURPRISE_TIER_STRONG_MIN,
    )?.summary ?? null;
  // Phase γ §3 — `analysis/project-trajectories.json` (produced by the
  // project-trajectory builder). Narrowed inline so we don't pull the
  // exporter type across.
  const trajectoriesFile = await readJsonOrNull<ProjectTrajectoriesFileShape>(
    join(analysisDir, 'project-trajectories.json'),
  );
  const projectTrajectories: BriefTrajectoryRow[] =
    trajectoriesFile?.projects?.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      classification: p.classification,
      slope: p.slope,
      totalSessions: p.totalSessions,
    })) ?? [];
  // Phase γ §1 — `git log` for the shipped-this-week counter. Pure
  // I/O in the shell; the kernel just formats the numbers.
  const shippedThisWeek = await shippedThisWeekFromGit(repoRootAbs());
  // Phase γ §4 — applied-pattern closures. The watcher verdict ledger
  // lives in the SQLite substrate (see CLAUDE.md "Data on disk"), but
  // no SDK accessor for it ships under `@chat-arch/exporter/db/sdk`
  // yet. We pass `null` so the kernel skips the section instead of
  // pretending zero-is-known; wiring lands when the SDK accessor does.
  // TODO(applyWatcher-sdk): once `listWatcherVerdicts(db)` (or similar)
  // exists in @chat-arch/exporter/db/sdk, change this to
  // `listWatcherVerdicts(db).filter(v => v.verdict === 'no-recurrence').length`.
  // Companion TODO at packages/analysis/src/dailyBrief.ts line ~360.
  const appliedPatternClosures: number | null = null;
  // Blog-drafts index isn't currently written as a single file — we
  // pass [] for now. The Today page reads blog drafts separately.
  void (null as unknown as BlogDraftsIndexFile);

  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);

  const brief = buildDailyBrief({
    date,
    now,
    patterns: corrections?.patterns ?? [],
    upgradeOutcomes: upgradeOutcomes?.outcomes ?? [],
    blogDrafts: [],
    auditResults: auditResults?.results ?? [],
    auditSummary,
    continuumHealth,
    shippedThisWeek,
    surprises,
    projectTrajectories,
    appliedPatternClosures,
    topStrongPositiveSurprise,
  });

  const outPath = join(briefsDir, `${date}.md`);
  await writeFile(outPath, brief.markdown, 'utf8');

  return new Response(
    JSON.stringify({
      ok: true,
      path: `analysis/briefs/${date}.md`,
      counts: brief.counts,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

export const GET: APIRoute = () => {
  return new Response(
    JSON.stringify({ ok: true, available: true, method: 'POST' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
