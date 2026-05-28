/**
 * Project Identity v2 — overrides loading + dry-run/preview (plan §6, §8).
 *
 * `loadProjectOverrides` fail-soft reads `projectOverrides.json` (the manual
 * escape hatch consumed by cascade rule 0). `buildProjectIdentityPreview`
 * computes the NEW project bucketing over the (post-0-turn-filter) manifest
 * and diffs it against the live `analysis/projects.json` WITHOUT overwriting
 * any live artifact — the user reviews before adopting (adoption = the next
 * normal rescan; the migration is rebuild-on-rescan, in place).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { UNASSIGNED_PROJECT_ID } from '@chat-arch/schema';
import {
  discoverProjects,
  isSyntheticVmCwd,
  type InferenceSource,
  type ProjectOverride,
} from '@chat-arch/analysis';
import { atomicWriteJson } from '../lib/atomicWrite.js';
import { logger } from '../lib/logger.js';
import { EXPORTER_VERSION } from './index.js';

/**
 * Fail-soft read of `<outDir>/projectOverrides.json`. Accepts either a bare
 * array of overrides or `{ overrides: [...] }`. Rows missing a `projectId` or
 * a `match` are dropped with a warn. Returns `[]` when the file is absent or
 * unparseable (first-run / not configured).
 */
export async function loadProjectOverrides(outDir: string): Promise<ProjectOverride[]> {
  const p = path.join(outDir, 'projectOverrides.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return []; // not configured
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(`projectOverrides.json is not valid JSON — ignoring`);
    return [];
  }
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { overrides?: unknown }).overrides)
      ? ((parsed as { overrides: unknown[] }).overrides)
      : [];
  const out: ProjectOverride[] = [];
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const projectId = row['projectId'];
    const match = row['match'];
    if (typeof projectId !== 'string' || projectId === '' || match === null || typeof match !== 'object') {
      logger.warn(`projectOverrides.json: dropping malformed row ${JSON.stringify(r).slice(0, 120)}`);
      continue;
    }
    const m = match as Record<string, unknown>;
    const cleanMatch: ProjectOverride['match'] = {};
    if (typeof m['cwdGlob'] === 'string' && m['cwdGlob'] !== '') cleanMatch.cwdGlob = m['cwdGlob'];
    if (Array.isArray(m['sessionIds'])) {
      cleanMatch.sessionIds = (m['sessionIds'] as unknown[]).filter((x): x is string => typeof x === 'string');
    }
    if (cleanMatch.cwdGlob === undefined && (cleanMatch.sessionIds === undefined || cleanMatch.sessionIds.length === 0)) {
      logger.warn(`projectOverrides.json: row for ${projectId} has no usable match (cwdGlob | sessionIds) — dropping`);
      continue;
    }
    const override: ProjectOverride = { projectId, match: cleanMatch };
    if (typeof row['displayName'] === 'string' && row['displayName'] !== '') {
      override.displayName = row['displayName'];
    }
    out.push(override);
  }
  return out;
}

interface OldProjectsFile {
  projects?: ReadonlyArray<{ id?: unknown; displayName?: unknown; sessionIds?: unknown }>;
}

interface ProjectSummaryRow {
  id: string;
  displayName: string;
  sessionCount: number;
}

export interface ProjectIdentityPreview {
  generatedAt: number;
  /** Records the live inputs so the viewer can warn if they drift before adopt. */
  inputSnapshot: { manifestMtimeMs: number | null; sessionCount: number; exporterVersion: string };
  summary: {
    oldProjectCount: number;
    newProjectCount: number;
    oldSessionCount: number;
    newSessionCount: number;
    oldUnassigned: number;
    newUnassigned: number;
    oldSingletons: number;
    newSingletons: number;
    movedSessionCount: number;
    newProjectIds: string[];
    vanishedProjectIds: string[];
  };
  resolvedViaCounts: Record<string, number>;
  /**
   * Reason-distribution over the UNASSIGNED residue so it is enumerated, not
   * mysterious (plan §12). `vm-no-resolvable-basename` is the benign,
   * signal-less residue (VM, no userSelectedFolders, no scheduledTaskId,
   * synthetic basename); the other buckets are sessions unassigned DESPITE a
   * usable signal and should stay near zero.
   */
  unassignedReasons: Record<string, number>;
  /** Top new projects by session count (capped for file size). */
  newProjects: ProjectSummaryRow[];
  /** Sample of moved sessions (capped); `movedSessionCount` is the true total. */
  movedSessionsSample: Array<{ sessionId: string; from: string; to: string }>;
  /** True when the new bucketing could not be diffed (no prior projects.json). */
  noBaseline: boolean;
}

const MOVED_SAMPLE_CAP = 200;
const NEW_PROJECTS_CAP = 60;

/**
 * Classify an unassigned session by SIGNAL availability (mirrors the audit
 * script). Benign iff it's a VM session with no userSelectedFolders, no
 * scheduledTaskId, and a SYNTHETIC cwd (shared `isSyntheticVmCwd` predicate) —
 * i.e. genuinely signal-less under the in-scope cascade. Anything unassigned
 * DESPITE a real signal surfaces (`no-cwd-no-title-match` / `other`).
 */
function classifyUnassignedReason(entry: UnifiedSessionEntry | undefined): string {
  if (entry === undefined) return 'other';
  const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : '';
  const hasUsf = Array.isArray(entry.userSelectedFolders) && entry.userSelectedFolders.length > 0;
  const hasSched = typeof entry.scheduledTaskId === 'string' && entry.scheduledTaskId.trim() !== '';
  if (entry.cwdKind === 'vm' && !hasUsf && !hasSched && cwd !== '' && isSyntheticVmCwd(cwd)) {
    return 'vm-no-resolvable-basename';
  }
  if (cwd === '') return 'no-cwd-no-title-match';
  return 'other';
}

/**
 * Compute the v2 bucketing over `manifest` and diff it against the live
 * `analysis/projects.json`, writing `analysis/project-identity-preview.json`.
 * Does NOT touch `projects.json` or `manifest.json`. Returns the preview.
 */
export async function buildProjectIdentityPreview(opts: {
  outDir: string;
  manifest: SessionManifest;
  overrides: readonly ProjectOverride[];
  manifestMtimeMs: number | null;
  now: number;
}): Promise<ProjectIdentityPreview> {
  const { outDir, manifest, overrides, manifestMtimeMs, now } = opts;

  // ---- OLD (live) bucketing from projects.json ----
  const oldSessionToProject = new Map<string, string>();
  const oldProjectIds = new Set<string>();
  let oldSingletons = 0;
  let oldUnassigned = 0;
  let noBaseline = false;
  try {
    const rawOld = await readFile(path.join(outDir, 'analysis', 'projects.json'), 'utf8');
    const old = JSON.parse(rawOld) as OldProjectsFile;
    for (const p of old.projects ?? []) {
      if (typeof p.id !== 'string' || !Array.isArray(p.sessionIds)) continue;
      oldProjectIds.add(p.id);
      const sids = p.sessionIds.filter((s): s is string => typeof s === 'string');
      for (const sid of sids) oldSessionToProject.set(sid, p.id);
      if (p.id === UNASSIGNED_PROJECT_ID) oldUnassigned = sids.length;
      else if (sids.length === 1) oldSingletons += 1;
    }
  } catch {
    noBaseline = true;
  }

  // ---- NEW bucketing from the cascade ----
  const result = discoverProjects(manifest.sessions, { now, overrides });
  const newProjectIds = new Set<string>();
  let newSingletons = 0;
  let newUnassigned = 0;
  const newProjectRows: ProjectSummaryRow[] = [];
  for (const p of result.projects) {
    newProjectIds.add(p.id);
    if (p.id === UNASSIGNED_PROJECT_ID) {
      newUnassigned = p.sessionIds.length;
    } else {
      if (p.sessionIds.length === 1) newSingletons += 1;
      newProjectRows.push({ id: p.id, displayName: p.displayName, sessionCount: p.sessionIds.length });
    }
  }
  newProjectRows.sort((a, b) => b.sessionCount - a.sessionCount || a.id.localeCompare(b.id));

  const resolvedViaCounts: Record<string, number> = {};
  for (const a of result.attribution.values()) {
    const k: InferenceSource = a.resolvedVia;
    resolvedViaCounts[k] = (resolvedViaCounts[k] ?? 0) + 1;
  }

  // Enumerate the UNASSIGNED residue by reason (plan §12).
  const entryById = new Map<string, UnifiedSessionEntry>();
  for (const e of manifest.sessions) entryById.set(e.id, e);
  const unassignedReasons: Record<string, number> = {};
  for (const [sid, a] of result.attribution) {
    if (a.resolvedVia !== 'unassigned') continue;
    const reason = classifyUnassignedReason(entryById.get(sid));
    unassignedReasons[reason] = (unassignedReasons[reason] ?? 0) + 1;
  }

  // ---- moved sessions (only meaningful when a baseline exists) ----
  const movedSessionsSample: Array<{ sessionId: string; from: string; to: string }> = [];
  let movedSessionCount = 0;
  if (!noBaseline) {
    for (const [sid, newPid] of result.sessionToProject) {
      const oldPid = oldSessionToProject.get(sid);
      if (oldPid !== undefined && oldPid !== newPid) {
        movedSessionCount += 1;
        if (movedSessionsSample.length < MOVED_SAMPLE_CAP) {
          movedSessionsSample.push({ sessionId: sid, from: oldPid, to: newPid });
        }
      }
    }
  }

  const preview: ProjectIdentityPreview = {
    generatedAt: now,
    inputSnapshot: { manifestMtimeMs, sessionCount: manifest.sessions.length, exporterVersion: EXPORTER_VERSION },
    summary: {
      oldProjectCount: oldProjectIds.size,
      newProjectCount: result.projects.length,
      oldSessionCount: oldSessionToProject.size,
      newSessionCount: result.sessionToProject.size,
      oldUnassigned,
      newUnassigned,
      oldSingletons,
      newSingletons,
      movedSessionCount,
      newProjectIds: [...newProjectIds].filter((id) => !oldProjectIds.has(id)).sort(),
      vanishedProjectIds: [...oldProjectIds].filter((id) => !newProjectIds.has(id)).sort(),
    },
    resolvedViaCounts,
    unassignedReasons,
    newProjects: newProjectRows.slice(0, NEW_PROJECTS_CAP),
    movedSessionsSample,
    noBaseline,
  };

  await atomicWriteJson(
    path.join(outDir, 'analysis', 'project-identity-preview.json'),
    JSON.stringify(preview, null, 2) + '\n',
  );
  return preview;
}
