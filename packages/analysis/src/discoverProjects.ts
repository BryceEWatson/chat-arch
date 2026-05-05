/**
 * Project discovery — spec §4.1 / §4.3, decisions D2, D8.
 *
 * Wraps the existing `inferProject` heuristic to promote each inferred
 * project to a first-class `Project` entity with stable id, session list,
 * and rolled-up sentiment. Sessions that resolve to no project are bucketed
 * into the `[UNASSIGNED]` pseudo-project (id: `__unassigned__`), which
 * carries topics but no narratives.
 *
 * Pure. The caller (exporter or browser-side demoUpload) writes the result
 * to `analysis/projects.json` per D2.
 *
 * Sentiment rollup is filled in a later pass once narratives exist —
 * `discoverNarratives` updates `Project.sentiment` based on the narratives
 * it produces. This pass writes a placeholder `'neutral'`.
 */

import type { UnifiedSessionEntry, Project, ProjectSource } from '@chat-arch/schema';
import {
  UNASSIGNED_PROJECT_ID,
  UNASSIGNED_PROJECT_DISPLAY,
} from '@chat-arch/schema';
import { inferProject } from './inferProject.js';

export interface DiscoverProjectsOptions {
  /** Override "now" in tests so generatedAt-style fields are deterministic. */
  now?: number;
}

export interface DiscoverProjectsResult {
  projects: Project[];
  /** Map: sessionId → projectId. Includes UNASSIGNED_PROJECT_ID for un-projected sessions. */
  sessionToProject: Map<string, string>;
}

const INFERENCE_TO_SOURCE: Record<string, ProjectSource> = {
  project_field: 'cli-cwd',
  cwd_basename: 'cli-cwd',
  title_keyword: 'cloud-projects-json',
};

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function discoverProjects(
  sessions: readonly UnifiedSessionEntry[],
  options: DiscoverProjectsOptions = {},
): DiscoverProjectsResult {
  const now = options.now ?? Date.now();

  type Bucket = {
    id: string;
    displayName: string;
    source: ProjectSource;
    sessionIds: string[];
    earliestUpdated: number;
    latestUpdated: number;
  };
  const buckets = new Map<string, Bucket>();
  const sessionToProject = new Map<string, string>();

  // Unassigned bucket created lazily (only if at least one un-projected session exists).
  let unassigned: Bucket | null = null;

  for (const s of sessions) {
    const inferred = inferProject({
      ...(s.project !== undefined ? { project: s.project } : {}),
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
      title: s.title,
    });
    if (inferred === null) {
      if (unassigned === null) {
        unassigned = {
          id: UNASSIGNED_PROJECT_ID,
          displayName: UNASSIGNED_PROJECT_DISPLAY,
          source: 'unassigned',
          sessionIds: [],
          earliestUpdated: s.updatedAt,
          latestUpdated: s.updatedAt,
        };
      }
      unassigned.sessionIds.push(s.id);
      unassigned.earliestUpdated = Math.min(unassigned.earliestUpdated, s.updatedAt);
      unassigned.latestUpdated = Math.max(unassigned.latestUpdated, s.updatedAt);
      sessionToProject.set(s.id, UNASSIGNED_PROJECT_ID);
      continue;
    }

    const id = stableProjectId(inferred.id);
    const existing = buckets.get(id);
    const source = INFERENCE_TO_SOURCE[inferred.inferenceSource] ?? 'semantic-classifier';
    if (existing === undefined) {
      buckets.set(id, {
        id,
        displayName: inferred.displayName,
        source,
        sessionIds: [s.id],
        earliestUpdated: s.updatedAt,
        latestUpdated: s.updatedAt,
      });
    } else {
      existing.sessionIds.push(s.id);
      existing.earliestUpdated = Math.min(existing.earliestUpdated, s.updatedAt);
      existing.latestUpdated = Math.max(existing.latestUpdated, s.updatedAt);
    }
    sessionToProject.set(s.id, id);
  }

  const projects: Project[] = [];
  for (const b of buckets.values()) {
    projects.push({
      id: b.id,
      displayName: b.displayName,
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
      displayName: unassigned.displayName,
      discoveredAt: isoFromMs(now),
      lastActivityAt: isoFromMs(unassigned.latestUpdated),
      sessionIds: unassigned.sessionIds,
      narrativeIds: [],
      topicIds: [],
      sentiment: 'neutral',
      source: 'unassigned',
    });
  }

  return { projects, sessionToProject };
}

/**
 * Project ids should be stable, URL-safe, and deterministic. The raw
 * inference id can be a basename like `My Project!` — slug it.
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
