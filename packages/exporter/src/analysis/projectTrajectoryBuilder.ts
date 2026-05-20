/**
 * Phase 3 #3 — project-trajectory builder.
 *
 * Reads composite outcomes from `analysis/composite-outcomes.json`,
 * groups by project (`entry.project` / `entry.projectId` from the
 * manifest), runs a rolling-window stationary block bootstrap on the
 * composite-score series, and emits `analysis/project-trajectories.json`.
 *
 * Classification rules (per plan §Phase 3 + `THRESHOLDS.trajectory`):
 *
 *   - `stalling`         slope CI strictly negative (high < 0) AND at
 *                        least `stallingMinRecentSessionsLast30d` sessions
 *                        in the last 30 days. Active decline.
 *   - `stalled-finished` slope CI strictly negative AND no recent
 *                        activity (no sessions in last 30 days). Project
 *                        wound down rather than is actively declining.
 *   - `accelerating`     slope CI strictly positive (low > 0).
 *   - `flat`             CI straddles zero, or bootstrap returned
 *                        `series-too-short`.
 *
 * Cache: clustering is per-project and depends on the composite-outcomes
 * sidecar — re-runs unconditionally. The bootstrap is seeded so output
 * is deterministic across runs against the same input.
 *
 * Node-only — file I/O. Pure kernels live in `@chat-arch/analysis`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CompositeOutcome,
  CompositeOutcomesFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { bootstrapSlope, THRESHOLDS } from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';
import { atomicWriteJson } from '../lib/atomicWrite.js';

const MS_PER_DAY = 86_400_000;
const RECENT_WINDOW_MS = 30 * MS_PER_DAY;

export type TrajectoryClassification =
  | 'stalling'
  | 'stalled-finished'
  | 'accelerating'
  | 'flat';

export interface ProjectTrajectoryEntry {
  projectId: string;
  /** Display name (falls back to projectId). */
  projectName: string;
  classification: TrajectoryClassification;
  /** Total sessions in the project (any window). */
  totalSessions: number;
  /** Sessions in the most-recent 30 days. */
  recentSessions: number;
  /** Theil-Sen slope on the rolling-window series. Null when too-short. */
  slope: number | null;
  /** Bootstrap 95% CI; null when too-short. */
  ci: { low: number; high: number } | null;
  /** Mean block length used by the bootstrap. */
  blockLength: number | null;
  /** Status emitted by the bootstrap kernel. */
  bootstrapStatus: 'ok' | 'series-too-short';
  /** Series fed into the bootstrap (rolling window, oldest to newest). */
  series: readonly number[];
}

export interface ProjectTrajectoriesFile {
  version: 1;
  generatedAt: number;
  /** Window length used (mirrors `THRESHOLDS.trajectory.rollingWindow`). */
  rollingWindow: number;
  projects: readonly ProjectTrajectoryEntry[];
}

export interface BuildProjectTrajectoriesOptions {
  outDir: string;
  now: number;
  /** Override for tests. */
  seed?: number;
}

export interface BuildProjectTrajectoriesResult {
  file: ProjectTrajectoriesFile;
  /** Projects that had any sessions with outcomes. */
  projects: number;
  /** Whether the composite-outcomes sidecar was present. */
  hasCompositeOutcomes: boolean;
}

async function loadCompositeOutcomes(
  outDir: string,
): Promise<Map<string, CompositeOutcome> | null> {
  const p = path.join(outDir, 'analysis', 'composite-outcomes.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  let parsed: CompositeOutcomesFile;
  try {
    parsed = JSON.parse(raw) as CompositeOutcomesFile;
  } catch {
    return null;
  }
  const out = new Map<string, CompositeOutcome>();
  for (const o of parsed.outcomes ?? []) {
    if (typeof o.sessionId === 'string') out.set(o.sessionId, o);
  }
  return out;
}

function projectKey(entry: UnifiedSessionEntry): { id: string; name: string } | null {
  if (typeof entry.projectId === 'string' && entry.projectId !== '') {
    return { id: entry.projectId, name: entry.project ?? entry.projectId };
  }
  if (typeof entry.project === 'string' && entry.project !== '') {
    return { id: entry.project, name: entry.project };
  }
  return null;
}

function classify(
  ci: { low: number; high: number } | null,
  recentSessions: number,
  bootstrapStatus: 'ok' | 'series-too-short',
): TrajectoryClassification {
  if (bootstrapStatus === 'series-too-short' || ci === null) {
    return 'flat';
  }
  const minRecent = THRESHOLDS.trajectory.stallingMinRecentSessionsLast30d;
  // Decline: CI strictly negative.
  if (ci.high < 0) {
    return recentSessions >= minRecent ? 'stalling' : 'stalled-finished';
  }
  // Acceleration: CI strictly positive.
  if (ci.low > 0) {
    return 'accelerating';
  }
  return 'flat';
}

export async function buildProjectTrajectoriesFile(
  manifest: SessionManifest,
  options: BuildProjectTrajectoriesOptions,
): Promise<BuildProjectTrajectoriesResult> {
  const t0 = Date.now();
  const composite = await loadCompositeOutcomes(options.outDir);
  const hasCompositeOutcomes = composite !== null;
  const window = THRESHOLDS.trajectory.rollingWindow;

  // Group sessions by project; collect (updatedAt, score) per session.
  interface PerSession {
    updatedAt: number;
    score: number;
  }
  const byProject = new Map<
    string,
    { name: string; sessions: PerSession[] }
  >();

  for (const entry of manifest.sessions) {
    const pk = projectKey(entry);
    if (pk === null) continue;
    const outcome = composite?.get(entry.id);
    if (outcome === undefined) continue;
    if (typeof outcome.score !== 'number' || !Number.isFinite(outcome.score)) continue;
    const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
    const slot = byProject.get(pk.id) ?? { name: pk.name, sessions: [] };
    slot.sessions.push({ updatedAt, score: outcome.score });
    byProject.set(pk.id, slot);
  }

  const projects: ProjectTrajectoryEntry[] = [];
  for (const [id, slot] of byProject) {
    const sorted = [...slot.sessions].sort((a, b) => a.updatedAt - b.updatedAt);
    // Rolling window: most recent N sessions, oldest→newest.
    const windowed = sorted.slice(-window);
    const series = windowed.map((s) => s.score);

    const recentCutoff = options.now - RECENT_WINDOW_MS;
    const recentSessions = sorted.filter((s) => s.updatedAt >= recentCutoff).length;

    const bootstrap = bootstrapSlope(series, {
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });
    const classification = classify(bootstrap.ci, recentSessions, bootstrap.status);

    projects.push({
      projectId: id,
      projectName: slot.name,
      classification,
      totalSessions: sorted.length,
      recentSessions,
      slope: bootstrap.slope,
      ci: bootstrap.ci,
      blockLength: bootstrap.blockLength,
      bootstrapStatus: bootstrap.status,
      series,
    });
  }

  // Stable sort: largest projects first, then by id (deterministic on disk).
  projects.sort((a, b) => b.totalSessions - a.totalSessions || a.projectId.localeCompare(b.projectId));

  const file: ProjectTrajectoriesFile = {
    version: 1,
    generatedAt: options.now,
    rollingWindow: window,
    projects,
  };

  const outPath = path.join(options.outDir, 'analysis', 'project-trajectories.json');
  await atomicWriteJson(outPath, JSON.stringify(file, null, 2) + '\n');

  logger.info(
    `analysis: project-trajectories.json — ${projects.length} projects, hasComposite=${hasCompositeOutcomes ? 'yes' : 'no'}, ${Date.now() - t0}ms`,
  );

  return { file, projects: projects.length, hasCompositeOutcomes };
}
