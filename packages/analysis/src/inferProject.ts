/**
 * `[R-D6]` project resolver — Project Identity v2 (plan §4).
 *
 * `inferProject` is a small **strict first-match** attribution cascade.
 * Governance is by order; confidences are monotonically non-increasing down
 * the list so the ordering and the confidence agree.
 *
 * ```
 * 0. user override (projectOverrides.json: cwdGlob | sessionIds → projectId)   1.00
 * 1. explicit session.project                                                  1.00
 * 2. scheduledTaskId   → routine_<scheduledTaskId>                             0.90
 * 3. cwdKind==='vm' && userSelectedFolders[0] non-empty → basename(USF[0])     0.80
 * 4. cwd basename (host only — VM-haiku guard below)                           0.50
 * 5. title-keyword regex                                                       0.40
 * 6. __unassigned__ (returns null)                                             0.00
 * ```
 *
 * id-prefix discipline: every rule returns a **raw** key. `discoverProjects`'s
 * `stableProjectId` lowercases, runs `.replace(/[^a-z0-9]+/g, '-')`, and adds
 * the single `proj_` prefix. So rule 2 returns `routine_<id>` (NOT a
 * pre-prefixed `proj_routine_…`) and the emitted id is
 * `proj_routine-<slug>` (the `routine_` underscore normalizes to a hyphen).
 *
 * displayName for rule 2 is a per-session *candidate* (the date-stripped
 * title, or title-cased id as fallback). The deterministic
 * "most-frequent stem" selection across a routine's many date-prefixed
 * per-run titles happens in `discoverProjects` (which sees the whole bucket).
 *
 * Pure function — no I/O, deterministic.
 */

import type { UnifiedSessionEntry, ProjectResolvedVia } from '@chat-arch/schema';
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

/** Why a session resolved to its project. Alias of the schema-side union. */
export type InferenceSource = ProjectResolvedVia;

/** Per-rule confidence, monotonically non-increasing down the cascade. */
export const RESOLVED_VIA_CONFIDENCE: Readonly<Record<InferenceSource, number>> = {
  override: 1.0,
  project_field: 1.0,
  'scheduled-task': 0.9,
  'vm-folder': 0.8,
  cwd_basename: 0.5,
  title_keyword: 0.4,
  unassigned: 0.0,
};

/** Match shape for a single user override (plan §6). */
export interface ProjectOverrideMatch {
  /** Glob over the session `cwd` (supports `*` and `**`; separator-agnostic). */
  cwdGlob?: string;
  /** Explicit session ids (matched against `entry.id`). */
  sessionIds?: readonly string[];
}

/**
 * A user override row from `projectOverrides.json`. `projectId` is a **raw**
 * key (NOT `proj_`-prefixed — `stableProjectId` normalizes it like every
 * other cascade rule's return).
 */
export interface ProjectOverride {
  projectId: string;
  displayName?: string;
  match: ProjectOverrideMatch;
}

export interface InferredProject {
  /** Raw key (pre-`stableProjectId`). */
  id: string;
  displayName: string;
  resolvedVia: InferenceSource;
  confidence: number;
}

/** Fields the cascade reads. `discoverProjects`/`zombies` pass the full entry. */
export type InferProjectInput = Pick<
  UnifiedSessionEntry,
  'id' | 'project' | 'cwd' | 'title' | 'cwdKind' | 'userSelectedFolders' | 'scheduledTaskId'
>;

function nonEmpty(s: string | undefined | null): s is string {
  return typeof s === 'string' && s !== '';
}

/**
 * Resolve a session to a project via the strict first-match cascade.
 * Returns null when no rule matches (rule 6 → unassigned).
 */
export function inferProject(
  entry: InferProjectInput,
  overrides: readonly ProjectOverride[] = [],
): InferredProject | null {
  // Rule 0 — user override. First matching override wins.
  for (const ov of overrides) {
    if (matchesOverride(entry, ov.match)) {
      return {
        id: ov.projectId,
        displayName: ov.displayName !== undefined && ov.displayName !== '' ? ov.displayName : ov.projectId,
        resolvedVia: 'override',
        confidence: RESOLVED_VIA_CONFIDENCE.override,
      };
    }
  }

  // Rule 1 — explicit project field.
  if (nonEmpty(entry.project)) {
    return {
      id: entry.project,
      displayName: entry.project,
      resolvedVia: 'project_field',
      confidence: RESOLVED_VIA_CONFIDENCE.project_field,
    };
  }

  // Rule 2 — scheduled-task → routine project, keyed on the task id (NOT the
  // per-run title, which fixes the rename-split + slug-collision hazards).
  if (nonEmpty(entry.scheduledTaskId)) {
    return {
      id: `routine_${entry.scheduledTaskId}`,
      displayName: scheduledDisplayCandidate(entry.scheduledTaskId, entry.title),
      resolvedVia: 'scheduled-task',
      confidence: RESOLVED_VIA_CONFIDENCE['scheduled-task'],
    };
  }

  // Rule 3 — VM session routed to its real host folder via basename(USF[0]).
  if (
    entry.cwdKind === 'vm' &&
    entry.userSelectedFolders !== undefined &&
    entry.userSelectedFolders.length > 0 &&
    nonEmpty(entry.userSelectedFolders[0])
  ) {
    const base = extractBasename(entry.userSelectedFolders[0]);
    if (base !== null && base !== '') {
      return {
        id: base,
        displayName: base,
        resolvedVia: 'vm-folder',
        confidence: RESOLVED_VIA_CONFIDENCE['vm-folder'],
      };
    }
  }

  // Rule 4 — cwd basename, HOST ONLY. VM-haiku guard: a `cwdKind==='vm'`
  // session that reached here (rule 3 did not fire → no userSelectedFolders)
  // must NOT adopt its haiku VM basename as a project; fall through to rule 5.
  if (nonEmpty(entry.cwd) && entry.cwdKind !== 'vm') {
    const base = extractBasename(entry.cwd);
    if (base !== null && base !== '') {
      return {
        id: base,
        displayName: base,
        resolvedVia: 'cwd_basename',
        confidence: RESOLVED_VIA_CONFIDENCE.cwd_basename,
      };
    }
  }

  // Rule 5 — title-keyword fallback (primarily for cloud sessions).
  if (nonEmpty(entry.title)) {
    for (const p of COMPILED) {
      if (p.re.test(entry.title)) {
        return {
          id: p.id,
          displayName: p.displayName,
          resolvedVia: 'title_keyword',
          confidence: RESOLVED_VIA_CONFIDENCE.title_keyword,
        };
      }
    }
  }

  // Rule 6 — unassigned.
  return null;
}

/** Leading date prefix Cowork auto-titles use, e.g. "Mar 28 – ". The class
 * covers hyphen, en-dash (U+2013) and em-dash (U+2014). */
const DATE_PREFIX_RE = /^\w{3,}\s+\d{1,2}\s+[–—-]\s+/;

/**
 * Per-session displayName candidate for a scheduled-task session: the title
 * with any leading date prefix stripped, or the title-cased task id when the
 * title is empty / fully consumed by the prefix. `discoverProjects` selects
 * the most frequent candidate (ties lexicographic) across the bucket so the
 * result is stable regardless of which per-run title is encountered first.
 */
export function scheduledDisplayCandidate(
  scheduledTaskId: string,
  title: string | undefined,
): string {
  if (nonEmpty(title)) {
    const stripped = title.replace(DATE_PREFIX_RE, '').trim();
    if (stripped !== '') return stripped;
  }
  return titleCaseSlug(scheduledTaskId);
}

/** `shopforge-daily-metrics-sync` → `Shopforge Daily Metrics Sync`. */
export function titleCaseSlug(slug: string): string {
  return slug
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function matchesOverride(entry: InferProjectInput, match: ProjectOverrideMatch): boolean {
  if (match.sessionIds !== undefined && match.sessionIds.includes(entry.id)) {
    return true;
  }
  if (match.cwdGlob !== undefined && match.cwdGlob !== '' && nonEmpty(entry.cwd)) {
    if (globMatch(match.cwdGlob, entry.cwd)) return true;
  }
  return false;
}

/**
 * Minimal, separator-agnostic glob → RegExp. `**` matches across separators,
 * `*` matches within a single path segment. Both glob and value are
 * normalized to forward slashes first so Windows `cwd`s match POSIX globs.
 */
export function globMatch(glob: string, value: string): boolean {
  const v = value.replace(/\\/g, '/');
  const g = glob.replace(/\\/g, '/');
  const SPECIAL = '.+?^${}()|[]\\';
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i] as string;
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (SPECIAL.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(v);
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
