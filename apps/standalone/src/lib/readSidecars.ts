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
  AuditResultsFile,
  AuditSummary,
  BlogCandidatesFile,
  ContinuumHealth,
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

export async function readUpgradeOutcomes(): Promise<UpgradeOutcomesFile | null> {
  return readJson<UpgradeOutcomesFile>(path.join(analysisDir(), 'upgrade-outcomes.json'));
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
