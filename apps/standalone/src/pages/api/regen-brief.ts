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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildDailyBrief } from '@chat-arch/analysis';
import type {
  AuditResultsFile,
  AuditSummary,
  BlogDraftsIndexFile,
  ContinuumHealth,
  CorrectionsFile,
  UpgradeOutcomesFile,
} from '@chat-arch/schema';

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
