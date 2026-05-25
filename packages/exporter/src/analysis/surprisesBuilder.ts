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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CompositeOutcomesFile,
  Decision,
  DecisionsFile,
  SessionManifest,
} from '@chat-arch/schema';
import {
  computeSurprises,
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

  const kernelInput: ComputeSurprisesInput = {
    generatedAt: options.now,
    composites,
    trajectories,
    itsResults,
    patternWatchers,
    reflexive,
    decisions,
    knowledgeDebt,
  };
  const file = computeSurprises(kernelInput);

  const outPath = path.join(analysisDir, 'surprises.json');
  atomicWriteJsonSync(outPath, file);

  logger.info(
    `analysis: surprises.json — ${file.surprises.length} surprises ` +
      `(composites=${composites.length}, trajectories=${trajectories.length}, ` +
      `its=${itsResults.length}, decisions=${decisions.length}, ` +
      `knowledgeDebt=${knowledgeDebt.length}), ${Date.now() - t0}ms`,
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
