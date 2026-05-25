/**
 * Surprises builder — feed-redesign Phase A.
 *
 * Node-only I/O wrapper around the pure `computeSurprises` kernel.
 *
 * Reads:
 *   - `analysis/composite-outcomes.json`   (foundation)
 *   - `analysis/project-trajectories.json`
 *   - `analysis/its-analysis.json`
 *   - `analysis/reflexive.json`
 *   - `analysis/decisions.json`
 *   - `analysis/knowledge-debt.json`
 *
 * Writes:
 *   - `analysis/surprises.json`
 *   - `analysis/archive/surprises-YYYY-MM-DD.json` (Wave 2 #1 — daily
 *     snapshot copy for the next scan's delta read; pruned by filename
 *     to `THRESHOLDS.surprises.archiveRetentionDays`).
 *
 * Watcher entries are intentionally NOT read from disk in V1 — the
 * applied-pattern watcher loop ledger lives in the SQLite substrate,
 * not in a JSON sidecar, and wiring the DB query into the exporter is
 * out-of-scope for the kernel landing PR. The builder passes an empty
 * `patternWatchers` array; a follow-on adds the SDK call.
 *
 * Fail-soft: any missing input sidecar degrades the corresponding
 * surprise kinds to "no rows" rather than aborting the build. The
 * surprises sidecar is always written so the viewer can rely on its
 * presence after a scan.
 */

import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  CompositeOutcomesFile,
  Decision,
  DecisionsFile,
  SessionManifest,
} from '@chat-arch/schema';
import {
  computeSurprises,
  THRESHOLDS,
  type ComputeSurprisesInput,
  type SurpriseCompositeRow,
  type SurpriseDecisionRow,
  type SurpriseKnowledgeDebtRow,
  type SurpriseTrajectoryRow,
  type SurpriseWatcherEntry,
  type SurprisesOutput,
} from '@chat-arch/analysis';
import type { ItsResult } from '@chat-arch/analysis';
import type { ReflexiveResult } from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';
import { atomicWriteJsonSync } from '../lib/atomicWrite.js';

export interface BuildSurprisesOptions {
  outDir: string;
  now: number;
}

export interface BuildSurprisesResult {
  file: SurprisesOutput;
  /** Sidecars that were readable; the others contributed empty inputs. */
  inputsRead: {
    composite: boolean;
    trajectories: boolean;
    its: boolean;
    reflexive: boolean;
    decisions: boolean;
    knowledgeDebt: boolean;
  };
  surpriseCount: number;
}

async function readJsonOrNull<T>(p: string): Promise<T | null> {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Wave 2 #1 — delta surprises. Archive filename convention:
 * `surprises-YYYY-MM-DD.json` in `<analysisDir>/archive/`. ASCII
 * date stamps sort lexicographically the same as chronologically, so
 * filename-based recency is deterministic and OS-agnostic (no reliance
 * on mtime, which moves under `git checkout`).
 */
const ARCHIVE_DIR_NAME = 'archive';
const ARCHIVE_FILE_RE = /^surprises-(\d{4}-\d{2}-\d{2})\.json$/;

function archiveDirOf(analysisDir: string): string {
  return path.join(analysisDir, ARCHIVE_DIR_NAME);
}

/** YYYY-MM-DD in UTC — matches the archive filename convention. */
function dateStampUtc(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 10);
}

/**
 * Read the most recent dated archive (NOT today's, the one before).
 * Returns null when:
 *   - the archive directory does not exist,
 *   - the archive directory contains no `surprises-YYYY-MM-DD.json` files,
 *   - the most recent file is today's (i.e. the kernel already ran today
 *     and we don't want it to compare against itself),
 *   - the most recent file cannot be parsed (malformed JSON / wrong shape).
 *
 * Determinism: filenames are sorted descending lexicographically, which
 * matches chronological order under the ISO-8601 date stamp.
 *
 * Race note: this is read-only; concurrent writers to the archive
 * (e.g. a second `pnpm exporter run start` racing the first) would
 * land via the atomicWriteJsonSync rename primitive. We tolerate a
 * mid-flight rename by treating a partial read as "no prior" — the
 * delta kinds skip cleanly and we degrade to V1 snapshot behavior.
 */
export async function loadMostRecentArchive(
  analysisDir: string,
  options: { todayStamp?: string } = {},
): Promise<SurprisesOutput | null> {
  const dir = archiveDirOf(analysisDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const dated = entries
    .map((name) => {
      const m = ARCHIVE_FILE_RE.exec(name);
      return m === null ? null : { name, stamp: m[1] as string };
    })
    .filter((e): e is { name: string; stamp: string } => e !== null);
  if (dated.length === 0) return null;

  // Exclude today's stamp so a same-day re-scan doesn't read what we
  // just wrote (the file would be byte-identical to the current run).
  const today = options.todayStamp;
  const candidates =
    today !== undefined ? dated.filter((e) => e.stamp !== today) : dated;
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.stamp.localeCompare(a.stamp));
  const mostRecent = candidates[0] as { name: string; stamp: string };
  try {
    const raw = await readFile(path.join(dir, mostRecent.name), 'utf8');
    return JSON.parse(raw) as SurprisesOutput;
  } catch {
    return null;
  }
}

/**
 * Archive today's surprises file and prune anything older than
 * `retentionDays`. Pruning is filename-based (NOT mtime) so a `git
 * checkout` that resets timestamps doesn't accidentally evict the
 * archive. The today copy uses `atomicWriteJsonSync` for the same
 * rename-over-target durability as the primary surprises.json write.
 *
 * Concurrency: archive + prune are separate filesystem ops, so a
 * racing prune could delete a sibling that another concurrent
 * archive operation just wrote. We accept the race — the loss is at
 * most one day of archive history, never the freshly-written file
 * (today's stamp is always retained because it's within the
 * retention window by definition).
 */
export async function archiveAndPrune(
  analysisDir: string,
  file: SurprisesOutput,
  options: { now: number; retentionDays: number },
): Promise<void> {
  const dir = archiveDirOf(analysisDir);
  await mkdir(dir, { recursive: true });
  const stamp = dateStampUtc(options.now);
  const target = path.join(dir, `surprises-${stamp}.json`);
  atomicWriteJsonSync(target, file);

  // Prune by filename: any dated entry older than today minus retention.
  const cutoffMs = options.now - options.retentionDays * 24 * 60 * 60 * 1000;
  const cutoffStamp = dateStampUtc(cutoffMs);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const m = ARCHIVE_FILE_RE.exec(name);
    if (m === null) continue;
    const entryStamp = m[1] as string;
    if (entryStamp.localeCompare(cutoffStamp) < 0) {
      try {
        await unlink(path.join(dir, name));
      } catch {
        // Best-effort prune; a stale lock or concurrent delete is fine.
      }
    }
  }
}

export async function buildSurprisesFile(
  manifest: SessionManifest,
  options: BuildSurprisesOptions,
): Promise<BuildSurprisesResult> {
  const t0 = Date.now();
  const analysisDir = path.join(options.outDir, 'analysis');

  // Map sessionId → { updatedAt, projectId } from the manifest.
  // Composite rows on disk don't carry the terminal timestamp or the
  // discovered projectId; we re-join here so the kernel can apply the
  // same-project gates (notably `decision-paid-off`).
  const updatedAtBySession = new Map<string, number>();
  const projectIdBySession = new Map<string, string>();
  for (const entry of manifest.sessions) {
    if (typeof entry.updatedAt === 'number') {
      updatedAtBySession.set(entry.id, entry.updatedAt);
    }
    if (typeof entry.projectId === 'string' && entry.projectId.length > 0) {
      projectIdBySession.set(entry.id, entry.projectId);
    }
  }

  // ── composites ──
  const compositeFile = await readJsonOrNull<CompositeOutcomesFile>(
    path.join(analysisDir, 'composite-outcomes.json'),
  );
  const composites: SurpriseCompositeRow[] = [];
  if (compositeFile !== null) {
    for (const o of compositeFile.outcomes ?? []) {
      const updatedAt = updatedAtBySession.get(o.sessionId) ?? 0;
      const projectId = projectIdBySession.get(o.sessionId);
      composites.push({
        sessionId: o.sessionId,
        updatedAt,
        composite: o,
        ...(projectId !== undefined ? { projectId } : {}),
      });
    }
  }

  // ── trajectories ──
  interface ProjectTrajectoriesFileShape {
    projects?: ReadonlyArray<{
      projectId: string;
      projectName: string;
      classification: SurpriseTrajectoryRow['classification'];
      slope: number | null;
      ci: { low: number; high: number } | null;
      totalSessions: number;
      recentSessions: number;
      bootstrapStatus: 'ok' | 'series-too-short';
    }>;
  }
  const trajectoryFile = await readJsonOrNull<ProjectTrajectoriesFileShape>(
    path.join(analysisDir, 'project-trajectories.json'),
  );
  const trajectories: SurpriseTrajectoryRow[] =
    trajectoryFile?.projects?.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      classification: p.classification,
      slope: p.slope,
      ci: p.ci,
      totalSessions: p.totalSessions,
      recentSessions: p.recentSessions,
      bootstrapStatus: p.bootstrapStatus,
    })) ?? [];

  // ── its ──
  interface ItsFileShape {
    results?: readonly ItsResult[];
  }
  const itsFile = await readJsonOrNull<ItsFileShape>(
    path.join(analysisDir, 'its-analysis.json'),
  );
  const itsResults: readonly ItsResult[] = itsFile?.results ?? [];

  // ── reflexive ──
  interface ReflexiveFileShape {
    result?: ReflexiveResult;
  }
  const reflexiveFile = await readJsonOrNull<ReflexiveFileShape>(
    path.join(analysisDir, 'reflexive.json'),
  );
  const reflexive: ReflexiveResult | null = reflexiveFile?.result ?? null;

  // ── decisions ──
  const decisionsFile = await readJsonOrNull<DecisionsFile>(
    path.join(analysisDir, 'decisions.json'),
  );
  const decisions: SurpriseDecisionRow[] = [];
  if (decisionsFile !== null) {
    for (const d of decisionsFile.decisions ?? []) {
      const decision = d as Decision;
      const ref = decision.outcomeRef;
      if (ref === null || ref === undefined) continue;
      // Same-project scoping for `decision-paid-off`: pull the
      // decision-session's projectId from the manifest join above.
      // Decisions whose session has no discovered projectId are still
      // emitted to the kernel but won't qualify for the paid-off
      // surprise (kernel-side gate).
      const projectId = projectIdBySession.get(ref.sessionId);
      decisions.push({
        decisionId: decision.candidate.id,
        sessionId: ref.sessionId,
        compositeScore: ref.compositeScore,
        binaryClass: ref.binaryClass,
        ...(decision.classification?.distilledDecision !== undefined
          ? { label: decision.classification.distilledDecision }
          : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      });
    }
  }

  // ── knowledge debt ──
  interface KnowledgeDebtFileShape {
    clusters?: ReadonlyArray<{
      id: string;
      canonicalQuestion: string;
      sessionIds: readonly string[];
      confidence: 'high' | 'low';
    }>;
  }
  const debtFile = await readJsonOrNull<KnowledgeDebtFileShape>(
    path.join(analysisDir, 'knowledge-debt.json'),
  );
  const knowledgeDebt: SurpriseKnowledgeDebtRow[] =
    debtFile?.clusters?.map((c) => ({
      id: c.id,
      canonicalQuestion: c.canonicalQuestion,
      sessionIds: c.sessionIds,
      confidence: c.confidence,
    })) ?? [];

  // TODO(applyWatcher-sdk): wire the pattern-watcher ledger from the
  // SQLite substrate once the read-side SDK accessor lands.
  //
  // The applied-pattern watcher loop (`evaluateAppliedPatternWatcher`
  // in @chat-arch/analysis) emits per-(pattern, project) verdicts
  // {kind: 'holding' | 'recurring' | 'open' | 'inconclusive'} that
  // the kernel consumes for `pattern-closed` / `pattern-recurring`
  // surprises. The verdicts persist in the SQLite substrate (Rev3-E
  // pattern + applyWatcher tables) but no `@chat-arch/exporter/db`
  // SDK accessor exposes them to a Node consumer yet.
  //
  // Until that accessor lands, this builder passes an empty list so
  // the kernel skips both pattern-* kinds rather than synthesizing
  // fake verdicts. V1 emission scope is therefore 7 of 9 kinds.
  //
  // When wiring lands, replace this assignment with the SDK call
  // (likely `listWatcherVerdicts({ closedOnly: false })` returning a
  // shape assignable to `SurpriseWatcherEntry[]`) and update CHANGELOG
  // `[1.4.0]` accordingly.
  const patternWatchers: readonly SurpriseWatcherEntry[] = [];

  // Wave 2 #1 — load the most recent prior archive (excluding today's
  // stamp) so the kernel can emit delta kinds. Fail-soft: null means
  // delta kinds skip cleanly and the kernel behaves identically to V1.
  const todayStamp = new Date(options.now).toISOString().slice(0, 10);
  const priorSurprises = await loadMostRecentArchive(analysisDir, {
    todayStamp,
  });

  const kernelInput: ComputeSurprisesInput = {
    generatedAt: options.now,
    composites,
    trajectories,
    itsResults,
    patternWatchers,
    reflexive,
    decisions,
    knowledgeDebt,
    priorSurprises,
  };
  const file = computeSurprises(kernelInput);

  const outPath = path.join(analysisDir, 'surprises.json');
  atomicWriteJsonSync(outPath, file);

  // Wave 2 #1 — archive today's snapshot for tomorrow's delta read,
  // then prune anything older than the retention window. Errors here
  // log + continue: a failed archive write should not break the
  // surprises sidecar (which already landed via the atomic write
  // above).
  try {
    await archiveAndPrune(analysisDir, file, {
      now: options.now,
      retentionDays: THRESHOLDS.surprises.archiveRetentionDays,
    });
  } catch (err) {
    logger.warn(
      `analysis: surprises archive soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  logger.info(
    `analysis: surprises.json — ${file.surprises.length} surprises ` +
      `(composites=${composites.length}, trajectories=${trajectories.length}, ` +
      `its=${itsResults.length}, decisions=${decisions.length}, ` +
      `knowledgeDebt=${knowledgeDebt.length}, ` +
      `priorArchive=${priorSurprises === null ? 'none' : 'loaded'}), ` +
      `${Date.now() - t0}ms`,
  );

  return {
    file,
    inputsRead: {
      composite: compositeFile !== null,
      trajectories: trajectoryFile !== null,
      its: itsFile !== null,
      reflexive: reflexiveFile !== null,
      decisions: decisionsFile !== null,
      knowledgeDebt: debtFile !== null,
    },
    surpriseCount: file.surprises.length,
  };
}
