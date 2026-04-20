/**
 * `[R-D6]` project resolver — BLOCKER FIX.
 *
 * Phase 6 Decision 6: zombie classifier project source of truth. Resolution
 * order per session:
 *   (1) `session.project` when non-null.
 *   (2) last path segment of `session.cwd` when non-null.
 *   (3) for cloud sessions (where neither exists), extract candidate project
 *       via first-match regex scan of `session.title` against the title-keyword
 *       allowlist in `projects.json`.
 *
 * Sessions matching none of the above resolve to `project: null` and are
 * skipped by the zombie pass (per the plan: "not misclassified"). Pure
 * function — no I/O, deterministic.
 */

import type { UnifiedSessionEntry } from '@chat-arch/schema';
import projectsJson from './projects.json' with { type: 'json' };

export interface ProjectDef {
  id: string;
  displayName: string;
  /** Case-insensitive regex source, compiled at module load. */
  pattern: string;
}

export interface ProjectsFile {
  _meta: { lastUpdated: string; notes: string };
  projects: ProjectDef[];
}

export const PROJECTS_FILE: ProjectsFile = projectsJson as ProjectsFile;

/** Pre-compiled regexes, evaluated once at module load. */
const COMPILED: ReadonlyArray<{
  id: string;
  displayName: string;
  re: RegExp;
}> = PROJECTS_FILE.projects.map((p) => ({
  id: p.id,
  displayName: p.displayName,
  re: new RegExp(p.pattern, 'i'),
}));

export type InferenceSource = 'project_field' | 'cwd_basename' | 'title_keyword';

export interface InferredProject {
  id: string;
  displayName: string;
  inferenceSource: InferenceSource;
}

/**
 * Resolve a session to a project. Returns null when no resolution path matches.
 */
export function inferProject(
  entry: Pick<UnifiedSessionEntry, 'project' | 'cwd' | 'title'>,
): InferredProject | null {
  if (entry.project !== undefined && entry.project !== null && entry.project !== '') {
    return {
      id: entry.project,
      displayName: entry.project,
      inferenceSource: 'project_field',
    };
  }
  if (entry.cwd !== undefined && entry.cwd !== null && entry.cwd !== '') {
    const basename = extractBasename(entry.cwd);
    if (basename !== null && basename !== '') {
      return {
        id: basename,
        displayName: basename,
        inferenceSource: 'cwd_basename',
      };
    }
  }
  // Title-keyword fallback (primarily for cloud sessions).
  if (entry.title !== undefined && entry.title !== null && entry.title !== '') {
    for (const p of COMPILED) {
      if (p.re.test(entry.title)) {
        return {
          id: p.id,
          displayName: p.displayName,
          inferenceSource: 'title_keyword',
        };
      }
    }
  }
  return null;
}

/**
 * Last path segment of a `cwd`, supporting both POSIX and Windows separators.
 * Strips trailing separators first; returns null for empty / root-only input.
 */
export function extractBasename(cwd: string): string | null {
  // Normalize: trim, strip trailing slashes/backslashes.
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (trimmed === '') return null;
  // Split on either separator — first match by Math.max of lastIndexOf.
  const slash = trimmed.lastIndexOf('/');
  const backslash = trimmed.lastIndexOf('\\');
  const sep = Math.max(slash, backslash);
  if (sep === -1) return trimmed; // bare segment
  const basename = trimmed.slice(sep + 1);
  return basename === '' ? null : basename;
}
