/**
 * Phase 3 #5 — workflow-archetype builder.
 *
 * Computes per-session `SessionToolStats` from each manifest entry's
 * `topTools` histogram, feeds them into the {@link detectArchetypes}
 * kernel, and writes `analysis/archetypes.json` atomically.
 *
 * Approximation note: `topTools` is a count map, not an ordered
 * timeline — `longestSameToolRun` can't be computed exactly here. We
 * approximate it as `max(toolCount)` over the histogram. This gives an
 * UPPER bound on the true run-length (the longest run can never exceed
 * the tool's total count), and the resulting `longestSameToolRunFraction`
 * = max / total. For a session whose dominant tool was used in scattered
 * bursts this over-states "stickiness", but the metric is normalized
 * across the cohort so the relative ordering is preserved. A timeline-
 * accurate pass would require streaming each transcript again — deferred
 * to a follow-up if archetype quality calls for it.
 *
 * Cache: re-runs unconditionally — clustering is whole-corpus and the
 * archetype assignment for session X depends on every other session in
 * the manifest. We just write the new file each run; the
 * `archetypeVersion` hash lets the viewer detect drift.
 *
 * Node-only — performs file I/O. Kernel + math live in
 * `@chat-arch/analysis`.
 */

import path from 'node:path';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import {
  detectArchetypes,
  type ArchetypesResult,
  type SessionToolStats,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';
import { atomicWriteJson } from '../lib/atomicWrite.js';

export interface BuildArchetypesOptions {
  outDir: string;
  now: number;
  /** Override for tests. */
  seed?: number;
}

/** On-disk shape of `analysis/archetypes.json`. */
export interface ArchetypesFile {
  /** Schema version of the file shape itself. */
  version: 1;
  generatedAt: number;
  /**
   * Drift-detection key: 32-bit FNV-1a hash of the centroid vectors.
   * When this changes across re-runs, the viewer should trigger a
   * hand-label refresh.
   */
  archetypeVersion: number;
  /** Centroids passing the `archetypeMinSize` guard, sorted desc by size. */
  centroids: ArchetypesResult['centroids'];
  /** sessionId → archetypeId (or null if no surviving centroid). */
  assignments: ArchetypesResult['assignments'];
  /** Silhouette score at the chosen k. */
  silhouette: number;
  chosenK: number;
  /** Sessions actually fed into the kernel (had usable tool stats). */
  scannedSessionIds: readonly string[];
}

export interface BuildArchetypesResult {
  file: ArchetypesFile;
  /** Sessions fed into the kernel. */
  scannedSessions: number;
  /** Sessions skipped (no `topTools` data). */
  skippedSessions: number;
}

/**
 * Planning-tool names that flip the `hasPlanTool` feature. Matches the
 * archetype kernel's feature spec (index 8).
 */
const PLAN_TOOL_NAMES = new Set<string>(['ExitPlanMode', 'TodoWrite']);

/**
 * Project a session's `topTools` histogram into `SessionToolStats`.
 * Returns null when the session has no `topTools` (key absent =
 * "unknown" per the unified-session JSDoc), so the builder can skip
 * those sessions rather than feed all-zero vectors into the kernel.
 */
function projectSession(entry: UnifiedSessionEntry): SessionToolStats | null {
  const tools = entry.topTools;
  if (tools === undefined) return null;
  const get = (k: string): number => {
    const v = tools[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  let total = 0;
  let max = 0;
  let hasPlan = false;
  for (const [name, count] of Object.entries(tools)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    total += count;
    if (count > max) max = count;
    if (PLAN_TOOL_NAMES.has(name)) hasPlan = true;
  }

  return {
    sessionId: entry.id,
    readCount: get('Read'),
    editCount: get('Edit'),
    bashCount: get('Bash'),
    grepCount: get('Grep'),
    globCount: get('Glob'),
    webFetchCount: get('WebFetch'),
    // Upper-bound approximation — see file header.
    longestSameToolRun: max,
    totalToolCalls: total,
    hasPlanTool: hasPlan,
  };
}

export async function buildArchetypesFile(
  manifest: SessionManifest,
  options: BuildArchetypesOptions,
): Promise<BuildArchetypesResult> {
  const t0 = Date.now();
  const stats: SessionToolStats[] = [];
  let skipped = 0;
  // Automation-exclusion (classify+collapse Stage 4): drop automated/
  // templated orchestration runs (`automationTemplateId` present) before
  // clustering. A templated run is not a workflow-archetype sample — its
  // tool histogram reflects the template, not genuine interactive work —
  // so it must not pull centroids toward the automation profile. Its
  // cost/frequency is preserved elsewhere via the collapse view.
  const interactiveSessions = manifest.sessions.filter(
    (s) => s.automationTemplateId == null,
  );
  for (const entry of interactiveSessions) {
    const s = projectSession(entry);
    if (s === null) {
      skipped += 1;
      continue;
    }
    stats.push(s);
  }

  const result =
    options.seed !== undefined
      ? detectArchetypes(stats, { seed: options.seed })
      : detectArchetypes(stats);

  const file: ArchetypesFile = {
    version: 1,
    generatedAt: options.now,
    archetypeVersion: result.archetypeVersion,
    centroids: result.centroids,
    assignments: result.assignments,
    silhouette: Number.isFinite(result.silhouette) ? result.silhouette : 0,
    chosenK: result.chosenK,
    scannedSessionIds: stats.map((s) => s.sessionId),
  };

  const outPath = path.join(options.outDir, 'analysis', 'archetypes.json');
  await atomicWriteJson(outPath, JSON.stringify(file, null, 2) + '\n');

  logger.info(
    `analysis: archetypes.json — k=${result.chosenK}, ${result.centroids.length} centroids, ${stats.length} scanned, ${skipped} skipped (no tools), version=${result.archetypeVersion}, ${Date.now() - t0}ms`,
  );

  return { file, scannedSessions: stats.length, skippedSessions: skipped };
}
