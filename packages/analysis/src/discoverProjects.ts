/**
 * Project discovery — spec §4.1 / §4.3, decisions D2, D8; Project Identity v2.
 *
 * Wraps the `inferProject` cascade to promote each inferred project to a
 * first-class `Project` entity with stable id, session list, and rolled-up
 * sentiment. Sessions that resolve to no project are bucketed into the
 * `[UNASSIGNED]` pseudo-project (id: `__unassigned__`).
 *
 * Pure. The caller (exporter or browser-side demoUpload) writes the result
 * to `analysis/projects.json` per D2.
 *
 * Project Identity v2 additions:
 *  - threads user `overrides` (projectOverrides.json) into the cascade;
 *  - returns a per-session `attribution` map (`{ resolvedVia, confidence }`)
 *    so the audit script + viewer can answer "why is this session here?";
 *  - selects each bucket's displayName as the most frequent candidate (ties
 *    lexicographic) — load-bearing for scheduled-task buckets whose per-run
 *    titles are date-prefixed;
 *  - disambiguates displayName collisions by appending a short id suffix.
 *
 * Sentiment rollup is filled in a later pass once narratives exist.
 */

import type { UnifiedSessionEntry, Project, ProjectSource } from '@chat-arch/schema';
import {
  UNASSIGNED_PROJECT_ID,
  UNASSIGNED_PROJECT_DISPLAY,
} from '@chat-arch/schema';
import { inferProject, type InferenceSource, type ProjectOverride } from './inferProject.js';

export interface DiscoverProjectsOptions {
  /** Override "now" in tests so generatedAt-style fields are deterministic. */
  now?: number;
  /** User overrides (projectOverrides.json) — cascade rule 0. */
  overrides?: readonly ProjectOverride[];
}

/** Per-session provenance, mirrored into `analysis/projects.json`. */
export interface SessionAttribution {
  projectId: string;
  resolvedVia: InferenceSource;
  confidence: number;
}

export interface DiscoverProjectsResult {
  projects: Project[];
  /** Map: sessionId → projectId. Includes UNASSIGNED_PROJECT_ID for un-projected sessions. */
  sessionToProject: Map<string, string>;
  /** Map: sessionId → { projectId, resolvedVia, confidence }. */
  attribution: Map<string, SessionAttribution>;
}

const INFERENCE_TO_SOURCE: Record<InferenceSource, ProjectSource> = {
  override: 'cli-cwd',
  project_field: 'cli-cwd',
  'scheduled-task': 'cli-cwd',
  'vm-folder': 'cli-cwd',
  cwd_basename: 'cli-cwd',
  title_keyword: 'cloud-projects-json',
  unassigned: 'unassigned',
};

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function discoverProjects(
  sessions: readonly UnifiedSessionEntry[],
  options: DiscoverProjectsOptions = {},
): DiscoverProjectsResult {
  const now = options.now ?? Date.now();
  const overrides = options.overrides ?? [];

  type Bucket = {
    id: string;
    source: ProjectSource;
    /** displayName candidate → frequency (mode picks the most frequent). */
    displayNameCounts: Map<string, number>;
    /** highest confidence seen, drives the project `source` mapping. */
    bestConfidence: number;
    sessionIds: string[];
    earliestUpdated: number;
    latestUpdated: number;
  };
  const buckets = new Map<string, Bucket>();
  const sessionToProject = new Map<string, string>();
  const attribution = new Map<string, SessionAttribution>();

  // Unassigned bucket created lazily (only if at least one un-projected session exists).
  let unassigned: Bucket | null = null;

  for (const s of sessions) {
    const inferred = inferProject(s, overrides);
    if (inferred === null) {
      if (unassigned === null) {
        unassigned = {
          id: UNASSIGNED_PROJECT_ID,
          source: 'unassigned',
          displayNameCounts: new Map([[UNASSIGNED_PROJECT_DISPLAY, 1]]),
          bestConfidence: 0,
          sessionIds: [],
          earliestUpdated: s.updatedAt,
          latestUpdated: s.updatedAt,
        };
      }
      unassigned.sessionIds.push(s.id);
      unassigned.earliestUpdated = Math.min(unassigned.earliestUpdated, s.updatedAt);
      unassigned.latestUpdated = Math.max(unassigned.latestUpdated, s.updatedAt);
      sessionToProject.set(s.id, UNASSIGNED_PROJECT_ID);
      attribution.set(s.id, {
        projectId: UNASSIGNED_PROJECT_ID,
        resolvedVia: 'unassigned',
        confidence: 0,
      });
      continue;
    }

    const id = stableProjectId(inferred.id);
    const source = INFERENCE_TO_SOURCE[inferred.resolvedVia] ?? 'semantic-classifier';
    const existing = buckets.get(id);
    if (existing === undefined) {
      buckets.set(id, {
        id,
        source,
        displayNameCounts: new Map([[inferred.displayName, 1]]),
        bestConfidence: inferred.confidence,
        sessionIds: [s.id],
        earliestUpdated: s.updatedAt,
        latestUpdated: s.updatedAt,
      });
    } else {
      existing.sessionIds.push(s.id);
      existing.earliestUpdated = Math.min(existing.earliestUpdated, s.updatedAt);
      existing.latestUpdated = Math.max(existing.latestUpdated, s.updatedAt);
      existing.displayNameCounts.set(
        inferred.displayName,
        (existing.displayNameCounts.get(inferred.displayName) ?? 0) + 1,
      );
      // Prefer the higher-confidence rule for the project's coarse `source`.
      if (inferred.confidence > existing.bestConfidence) {
        existing.bestConfidence = inferred.confidence;
        existing.source = source;
      }
    }
    sessionToProject.set(s.id, id);
    attribution.set(s.id, {
      projectId: id,
      resolvedVia: inferred.resolvedVia,
      confidence: inferred.confidence,
    });
  }

  // Resolve each bucket's displayName as the modal candidate (ties → lexicographic).
  const resolvedNames = new Map<string, string>();
  for (const b of buckets.values()) {
    resolvedNames.set(b.id, modalDisplayName(b.displayNameCounts));
  }
  disambiguateCollisions(resolvedNames);

  const projects: Project[] = [];
  for (const b of buckets.values()) {
    projects.push({
      id: b.id,
      displayName: resolvedNames.get(b.id) ?? b.id,
      discoveredAt: isoFromMs(now),
      lastActivityAt: isoFromMs(b.latestUpdated),
      sessionIds: b.sessionIds,
      narrativeIds: [],
      topicIds: [],
      sentiment: 'neutral',
      source: b.source,
    });
  }
  if (unassigned !== null) {
    projects.push({
      id: unassigned.id,
      displayName: UNASSIGNED_PROJECT_DISPLAY,
      discoveredAt: isoFromMs(now),
      lastActivityAt: isoFromMs(unassigned.latestUpdated),
      sessionIds: unassigned.sessionIds,
      narrativeIds: [],
      topicIds: [],
      sentiment: 'neutral',
      source: 'unassigned',
    });
  }

  return { projects, sessionToProject, attribution };
}

/** Most frequent displayName candidate; ties broken lexicographically. */
export function modalDisplayName(counts: ReadonlyMap<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [name, count] of counts) {
    if (count > bestCount || (count === bestCount && name < best)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Two distinct project ids can resolve to the same displayName (two routine
 * task-ids, two VM-USF basenames). The ids differ so data is correct, but the
 * UI must disambiguate — append a short id-derived suffix to every member of a
 * colliding group. Mutates the map in place. Deterministic.
 */
export function disambiguateCollisions(resolvedNames: Map<string, string>): void {
  const byName = new Map<string, string[]>();
  for (const [id, name] of resolvedNames) {
    const group = byName.get(name);
    if (group === undefined) byName.set(name, [id]);
    else group.push(id);
  }
  for (const [name, ids] of byName) {
    if (ids.length < 2) continue;
    // ids within a group are distinct, but their short suffixes might still
    // collide (shared trailing slug chars). Guarantee per-group uniqueness:
    // start from the short suffix and, on any residual collision, fall back
    // to a deterministic 1-based index so the UI never shows two identical
    // disambiguated names. Sort ids first so the index assignment is stable.
    const sorted = [...ids].sort();
    const used = new Set<string>();
    for (const id of sorted) {
      let suffix = shortSuffix(id);
      if (used.has(suffix)) {
        let i = 2;
        while (used.has(`${suffix}-${i}`)) i += 1;
        suffix = `${suffix}-${i}`;
      }
      used.add(suffix);
      resolvedNames.set(id, `${name} ·${suffix}`);
    }
  }
}

/** Short, stable, id-derived disambiguation suffix (last 4 slug chars). */
function shortSuffix(id: string): string {
  const slug = id.replace(/^proj_/, '').replace(/[^a-z0-9]/gi, '');
  return slug.slice(-4) || slug || id;
}

/**
 * Project ids should be stable, URL-safe, and deterministic. The raw
 * inference id can be a basename like `My Project!` — slug it. NB the
 * `[^a-z0-9]+ → '-'` pass collapses the `routine_` underscore to a hyphen,
 * so `routine_x` becomes `proj_routine-x` (plan §4 id-prefix discipline).
 */
function stableProjectId(raw: string): string {
  if (raw === UNASSIGNED_PROJECT_ID) return raw;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `proj_${simpleHash(raw)}` : `proj_${slug}`;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
