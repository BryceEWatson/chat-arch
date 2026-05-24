/**
 * Analysis orchestrator — Phase 6 browser tier.
 *
 * Runs all writers against the merged manifest and emits the
 * `analysis/*.json` sibling dir per Decision 1. Called by `cli.ts` after
 * the merge step. Pure-ish: it does I/O (read transcripts, write JSON) but
 * the heavy lifting is in the pure-function modules it composes.
 *
 * Writes (Phase 6 tier-1):
 *   - `analysis/duplicates.exact.json`
 *   - `analysis/zombies.heuristic.json`
 *   - `analysis/meta.json`
 *
 * Plus the Phase 1-3 outcome-substrate sidecars (wired in Wave 5):
 *   - composite-outcomes.json    (foundation for all consumers)
 *   - pr-land-cache.json         (gated; reads audit-results from prior run)
 *   - config-history.json
 *   - its-analysis.json          (reads composite + config-history)
 *   - knowledge-debt.json + exports/knowledge-debt.md
 *   - reflexive.json             (reads composite)
 *   - decisions.json             (reads composite)
 *   - archetypes.json
 *   - project-trajectories.json  (reads composite)
 *   - surface-comparison.json    (reads archetypes + composite)
 *   - skill-curves.json          (reads topics)
 *
 * Phase 7 writers do NOT land here (they live in a separate skill/package
 * per Decision 1). Never writes tier-2 filenames.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ContinuumHealth,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { logger } from '../lib/logger.js';
import {
  buildContinuumHealth,
  buildDuplicatesFile,
  buildZombiesFile,
  discoverProjects,
  discoverTopics,
  discoverNarratives,
  type DuplicateInput,
} from '@chat-arch/analysis';
import { buildCorrectionsCandidatesFile } from './corrections.js';
import { buildPlaybookCandidatesFile } from './playbook.js';
import { buildCompositeOutcomesFile } from './composeOutcomesBuilder.js';
import { buildPrLandJoin } from './prLandJoin.js';
import { buildConfigHistoryFile } from './configHistory.js';
import { buildItsAnalysisFile } from './itsBuilder.js';
import { buildKnowledgeDebtFile } from './knowledgeDebtBuilder.js';
import { buildReflexiveFile } from './reflexiveBuilder.js';
import { buildDecisionsFile } from './decisionsBuilder.js';
import { buildArchetypesFile } from './archetypesBuilder.js';
import { buildProjectTrajectoriesFile } from './projectTrajectoryBuilder.js';
import { buildSurfaceComparisonFile } from './surfaceComparisonBuilder.js';
import { buildSkillCurvesFile } from './skillCurvesBuilder.js';

export interface RunAnalysisOptions {
  /** Root output dir (same one `manifest.json` sits in). */
  outDir: string;
  /** Override "now" for tests. Defaults to Date.now(). */
  now?: number;
  /** Override exporterRunId for tests. */
  exporterRunId?: string;
  /** Override gitSha detection for tests. */
  gitSha?: string | null;
  /**
   * Opt into the PR-land join (network step via `gh api`). Default false
   * per plan §1.4 — the join only succeeds when (a) `gh` is authenticated
   * and (b) a prior `runSemanticAnalysis` run has written
   * `audit-results.json` so the builder has gh-pr-* claims to look up.
   */
  enablePrJoin?: boolean;
}

export interface RunAnalysisResult {
  analysisDir: string;
  files: {
    duplicates: string;
    zombies: string;
    meta: string;
    projects: string;
    topics: string;
    narratives: string;
    correctionCandidates: string;
    continuumHealth: string;
    playbookCandidates: string;
    compositeOutcomes: string;
    configHistory: string;
    itsAnalysis: string;
    knowledgeDebt: string;
    reflexive: string;
    decisions: string;
    archetypes: string;
    projectTrajectories: string;
    surfaceComparison: string;
    skillCurves: string;
  };
  counts: {
    duplicatesClusters: number;
    duplicatesSessions: number;
    active: number;
    dormant: number;
    zombie: number;
    projects: number;
    topics: number;
    narratives: number;
    correctionCandidates: number;
    playbookPatterns: number;
    playbookHits: number;
    compositeOutcomes: number;
    configHistoryCommits: number;
    itsContrasts: number;
    knowledgeDebtClusters: number;
    reflexivePairs: number;
    decisions: number;
    archetypes: number;
    projectTrajectories: number;
    surfaceCells: number;
    skillCurves: number;
  };
}

/**
 * Exported so the per-source cache loaders (cli.ts, cowork.ts) can
 * gate reuse on a version match — when the on-disk entry shape
 * changes, all prior caches self-invalidate on next rescan.
 *
 * Bumped 1.1.0 → 1.2.0 in Phase 1 Wave 5: outcome-substrate sidecars
 * land (composite-outcomes, its-analysis, archetypes, decisions, …)
 * and the audit kernel ships at `AUDIT_CONFIG_VERSION = 2`. Existing
 * 1.1.0 caches for corrections / playbook survive (their per-file
 * heuristic versions didn't change); the audit cache invalidates by
 * design on the version bump.
 *
 * Bumped 1.2.0 → 1.3.0 in Phase Rev3-I I5: the SQLite substrate
 * (Rev3-A) + Narrative schemaVersion 2 (Rev3-B intent / observation
 * / inference / confidence-ladder fields) + entity-states ledger
 * cutover (Rev3-C) + Closure B/C wiring (Rev3-D/E) + curator-feed
 * and falsifier-verdicts sidecars (Rev3-F) + Welch + correlation
 * gate (Rev3-G) + MCP server scaffold (Rev3-H) all land together.
 * The on-disk artifact set expands (analysis/curator-feed.json,
 * analysis/falsifier-verdicts.json) and pre-existing sidecars stay
 * compatible — caches for prior phases don't need to invalidate
 * because their per-file heuristic versions didn't change. The bump
 * is a coarse signal to operators that the bundle now reflects the
 * Rev3 substrate, not just outcome-substrate Phase 1-4.
 */
export const EXPORTER_VERSION = '1.3.0';

export async function runAnalysis(
  manifest: SessionManifest,
  options: RunAnalysisOptions,
): Promise<RunAnalysisResult> {
  const now = options.now ?? Date.now();
  const analysisDir = path.join(options.outDir, 'analysis');
  await mkdir(analysisDir, { recursive: true });

  // ---- Duplicates ----
  // Pull first-human text from every **cloud** session's transcript. R19's
  // canonical 15-group / 36-session count was computed over the cloud corpus
  // only (see R19 Method); running duplicate-detection over CLI/Cowork
  // boilerplate like `<command-message>` wrappers produces clusters R19
  // never saw. Scoping to cloud + the 40-char min-prefix filter is the
  // deterministic path to AC4's 15 ±1 target under the Decision-5 spec.
  const cloudSessions = manifest.sessions.filter((e) => e.source === 'cloud');
  logger.info(
    `analysis: scanning ${cloudSessions.length} cloud sessions for first-human text (of ${manifest.sessions.length} total)...`,
  );
  const t0 = Date.now();
  const dupInputs: DuplicateInput[] = [];
  let scanned = 0;
  let missing = 0;
  for (const entry of cloudSessions) {
    const text = await readFirstHumanText(entry, options.outDir);
    if (text === null) missing += 1;
    dupInputs.push({ sessionId: entry.id, firstHumanText: text });
    scanned += 1;
  }
  logger.info(
    `analysis: first-human text scan done — ${scanned} scanned, ${missing} missing, ${Date.now() - t0}ms`,
  );

  const duplicatesFile = buildDuplicatesFile(dupInputs, now);
  const duplicatesPath = path.join(analysisDir, 'duplicates.exact.json');
  await writeFile(duplicatesPath, JSON.stringify(duplicatesFile, null, 2) + '\n', 'utf8');
  const duplicatesSessionCount = duplicatesFile.clusters.reduce(
    (n, c) => n + c.sessionIds.length,
    0,
  );
  logger.info(
    `analysis: duplicates.exact.json — ${duplicatesFile.clusters.length} clusters, ${duplicatesSessionCount} sessions`,
  );

  // ---- Zombies ----
  const zombiesFile = buildZombiesFile(manifest.sessions, now);
  const zombiesPath = path.join(analysisDir, 'zombies.heuristic.json');
  await writeFile(zombiesPath, JSON.stringify(zombiesFile, null, 2) + '\n', 'utf8');
  const classCounts = zombiesFile.projects.reduce(
    (acc, p) => {
      acc[p.classification] += 1;
      return acc;
    },
    { active: 0, dormant: 0, zombie: 0 },
  );
  logger.info(
    `analysis: zombies.heuristic.json — ${zombiesFile.projects.length} projects (active=${classCounts.active}, dormant=${classCounts.dormant}, zombie=${classCounts.zombie})`,
  );

  // ---- v2 entity discovery: projects → topics → narratives ----
  // Pure functions over the manifest; deterministic given identical input.
  // Three sidecars per spec §13 / decision D2. Browser-side parity is
  // preserved by `demoUpload.ts` calling the same kernels.
  const projectsResult = discoverProjects(manifest.sessions, { now });
  const topicsResult = discoverTopics(
    manifest.sessions,
    projectsResult.sessionToProject,
    { now },
  );
  const narrativesResult = discoverNarratives(manifest.sessions, projectsResult.projects, {
    now,
  });

  // Backfill narrative ids + sentiment + topicIds onto each Project.
  const enrichedProjects = projectsResult.projects.map((p) => {
    const topicIds = new Set<string>();
    for (const sid of p.sessionIds) {
      for (const tid of topicsResult.sessionToTopics.get(sid) ?? []) {
        topicIds.add(tid);
      }
    }
    return {
      ...p,
      narrativeIds: narrativesResult.narrativesByProject.get(p.id) ?? [],
      topicIds: [...topicIds],
      sentiment: narrativesResult.projectSentiment.get(p.id) ?? p.sentiment,
    };
  });

  const projectsPath = path.join(analysisDir, 'projects.json');
  await writeFile(
    projectsPath,
    JSON.stringify({ generatedAt: now, projects: enrichedProjects }, null, 2) + '\n',
    'utf8',
  );
  logger.info(
    `analysis: projects.json — ${enrichedProjects.length} projects (incl. UNASSIGNED if present)`,
  );

  const topicsPath = path.join(analysisDir, 'topics.json');
  await writeFile(
    topicsPath,
    JSON.stringify({ generatedAt: now, topics: topicsResult.topics }, null, 2) + '\n',
    'utf8',
  );
  logger.info(`analysis: topics.json — ${topicsResult.topics.length} topics`);

  const narrativesPath = path.join(analysisDir, 'narratives.json');
  await writeFile(
    narrativesPath,
    JSON.stringify(
      { generatedAt: now, narratives: narrativesResult.narratives },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  logger.info(
    `analysis: narratives.json — ${narrativesResult.narratives.length} narratives`,
  );

  // ---- Correction candidates (stage-1 heuristic only) ----
  // The Claude Code skill `/mine-corrections` consumes this file and
  // overwrites it with classifications + clustered patterns + proposed
  // upgrades. Until then `pipeline.llmClassification: false` gates
  // downstream consumers from treating candidates as confirmed.
  const correctionsResult = await buildCorrectionsCandidatesFile(manifest, {
    outDir: options.outDir,
    now,
  });
  const correctionCandidatesPath = path.join(analysisDir, 'correction-candidates.json');
  await writeFile(
    correctionCandidatesPath,
    JSON.stringify(correctionsResult.correctionsFile, null, 2) + '\n',
    'utf8',
  );
  logger.info(
    `analysis: correction-candidates.json — ${correctionsResult.correctionsFile.corrections.length} candidates from ${correctionsResult.scannedSessions} sessions (${correctionsResult.missingTranscripts} missing transcripts)`,
  );

  // ---- Methods playbook (stage-1 heuristic) ----
  // Positive counterpart to corrections — recurring user-turn phrasings
  // (e.g. "go back to first principles", "use an adversarial review
  // team") that the viewer's /playbook surface ranks by occurrence ×
  // downstream pass-rate. The skill-driven encoding flow (export as
  // prompt snippet / CLAUDE.md verb) is deferred to a follow-up PR.
  const playbookResult = await buildPlaybookCandidatesFile(manifest, {
    outDir: options.outDir,
    now,
  });
  const playbookCandidatesPath = path.join(analysisDir, 'playbook-candidates.json');
  await writeFile(
    playbookCandidatesPath,
    JSON.stringify(playbookResult.file, null, 2) + '\n',
    'utf8',
  );

  // ---- Wave 5: outcome-substrate sidecars ----
  //
  // Builder order respects the data-dependency DAG:
  //
  //   composeOutcomes  ─┬─►  itsBuilder        (also reads configHistory)
  //                     ├─►  reflexiveBuilder
  //                     ├─►  decisionsBuilder
  //                     ├─►  projectTrajectoryBuilder
  //                     └─►  surfaceComparison (also reads archetypes)
  //
  //   configHistory   ───►  itsBuilder
  //   archetypes      ───►  surfaceComparison
  //   topics.json     ───►  skillCurves
  //
  // PR-land join is gated off by default (network step) — when enabled,
  // it reads audit-results.json from a prior `runSemanticAnalysis` run
  // (the audit-results sidecar is written downstream of us by `all.ts`).
  // On a cold first run it will detect the absence and skip without
  // failing the pipeline; on the next rescan the join wires through.
  //
  // Every new builder is fail-soft inside its own try/catch so a single
  // builder regression cannot break the rest of the pipeline.

  // composite-outcomes — foundation for downstream consumers.
  let compositeOutcomesCount = 0;
  try {
    const compositeStart = Date.now();
    const r = await buildCompositeOutcomesFile(manifest, {
      outDir: options.outDir,
      now,
    });
    compositeOutcomesCount = r.file.outcomes.length;
    logger.info(
      `analysis: composite-outcomes done — ${compositeOutcomesCount} outcomes (${r.scannedSessions} scanned, ${r.reusedSessions} reused, ${r.missingTranscripts} missing), ${Date.now() - compositeStart}ms`,
    );
  } catch (err) {
    logger.warn(
      `analysis: composite-outcomes soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const compositeOutcomesPath = path.join(analysisDir, 'composite-outcomes.json');

  // PR-land join — opt-in network step; reads audit-results.json (from
  // a prior `runSemanticAnalysis` run) and composite-outcomes.json
  // (from above). Both gracefully missing on a cold first run.
  if (options.enablePrJoin === true) {
    try {
      const prStart = Date.now();
      const r = await buildPrLandJoin({
        outDir: options.outDir,
        now,
      });
      logger.info(
        `analysis: pr-land join — joined=${r.joinedCount}, fetched=${r.fetchedCount}, reused=${r.reusedCount}, authError=${r.authErrorEncountered}, ${Date.now() - prStart}ms`,
      );
    } catch (err) {
      logger.warn(
        `analysis: pr-land-join soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // config-history — walks `git log` over ~/.claude (skips quietly when
  // the dirs don't exist or aren't git worktrees).
  let configHistoryCommits = 0;
  try {
    const r = await buildConfigHistoryFile({
      outDir: options.outDir,
      now,
    });
    configHistoryCommits = r.file.commits.length;
  } catch (err) {
    logger.warn(
      `analysis: config-history soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const configHistoryPath = path.join(analysisDir, 'config-history.json');

  // its-analysis — depends on composite-outcomes AND config-history.
  // The builder tolerates either being absent (emits empty results).
  let itsContrasts = 0;
  try {
    const sessionUpdatedAt = new Map<string, number>();
    for (const entry of manifest.sessions) {
      if (typeof entry.updatedAt === 'number') {
        sessionUpdatedAt.set(entry.id, entry.updatedAt);
      }
    }
    const r = await buildItsAnalysisFile({
      outDir: options.outDir,
      now,
      sessionUpdatedAt,
    });
    itsContrasts = r.commitsAnalyzed;
  } catch (err) {
    logger.warn(
      `analysis: its-analysis soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const itsPath = path.join(analysisDir, 'its-analysis.json');

  // knowledge-debt — clusters first-user-turn questions across sessions
  // and also writes a markdown export under exports/.
  let knowledgeDebtClusters = 0;
  try {
    const r = await buildKnowledgeDebtFile(manifest, {
      outDir: options.outDir,
      now,
    });
    knowledgeDebtClusters = r.file.clusters.length;
  } catch (err) {
    logger.warn(
      `analysis: knowledge-debt soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const knowledgeDebtPath = path.join(analysisDir, 'knowledge-debt.json');

  // reflexive — matched-pair contrast for "touched chat-arch" sessions.
  // Reads composite; tolerates absence.
  let reflexivePairs = 0;
  try {
    const r = await buildReflexiveFile(manifest, {
      outDir: options.outDir,
      now,
    });
    reflexivePairs = r.file.result.pairs.length;
  } catch (err) {
    logger.warn(
      `analysis: reflexive soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const reflexivePath = path.join(analysisDir, 'reflexive.json');

  // decisions — LF over user + assistant turns; joins to composite.
  let decisionsCount = 0;
  try {
    const r = await buildDecisionsFile(manifest, {
      outDir: options.outDir,
      now,
    });
    decisionsCount = r.totalCandidates;
  } catch (err) {
    logger.warn(
      `analysis: decisions soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const decisionsPath = path.join(analysisDir, 'decisions.json');

  // archetypes — k-means clustering of session feature vectors.
  // Must precede surfaceComparison.
  let archetypesCount = 0;
  try {
    const r = await buildArchetypesFile(manifest, {
      outDir: options.outDir,
      now,
    });
    archetypesCount = r.file.centroids.length;
  } catch (err) {
    logger.warn(
      `analysis: archetypes soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const archetypesPath = path.join(analysisDir, 'archetypes.json');

  // project-trajectories — Theil-Sen slope + Politis-Romano bootstrap.
  let projectTrajectoriesCount = 0;
  try {
    const r = await buildProjectTrajectoriesFile(manifest, {
      outDir: options.outDir,
      now,
    });
    projectTrajectoriesCount = r.projects;
  } catch (err) {
    logger.warn(
      `analysis: project-trajectories soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const projectTrajectoriesPath = path.join(analysisDir, 'project-trajectories.json');

  // surface-comparison — depends on archetypes.json. Builder throws on
  // missing archetypes; we wrap and downgrade to a soft warn so a
  // first-run failure doesn't break the whole pipeline.
  let surfaceCellsCount = 0;
  try {
    const r = await buildSurfaceComparisonFile(manifest, {
      outDir: options.outDir,
      now,
    });
    surfaceCellsCount = r.cellsTotal;
  } catch (err) {
    logger.warn(
      `analysis: surface-comparison soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const surfaceComparisonPath = path.join(analysisDir, 'surface-comparison.json');

  // skill-curves — reads topics.json (always present after the v2
  // entity-discovery stage above).
  let skillCurvesCount = 0;
  try {
    const r = await buildSkillCurvesFile(manifest, {
      outDir: options.outDir,
      now,
    });
    skillCurvesCount = r.topicsAnalyzed;
  } catch (err) {
    logger.warn(
      `analysis: skill-curves soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const skillCurvesPath = path.join(analysisDir, 'skill-curves.json');

  // ---- Meta ----
  const exporterRunId = options.exporterRunId ?? randomUUID();
  const gitSha = options.gitSha !== undefined ? options.gitSha : detectGitSha();
  const metaFile = {
    version: 1 as const,
    generatedAt: now,
    exporterVersion: EXPORTER_VERSION,
    exporterRunId,
    ...(gitSha !== null ? { gitSha } : {}),
    tiers: {
      browser: {
        generatedAt: now,
        files: [
          'duplicates.exact.json',
          'zombies.heuristic.json',
          'projects.json',
          'topics.json',
          'narratives.json',
          'correction-candidates.json',
          'continuum-health.json',
          'playbook-candidates.json',
          // Phase 1-3 outcome-substrate sidecars (Wave 5).
          'composite-outcomes.json',
          'config-history.json',
          'its-analysis.json',
          'knowledge-debt.json',
          'reflexive.json',
          'decisions.json',
          'archetypes.json',
          'project-trajectories.json',
          'surface-comparison.json',
          'skill-curves.json',
        ],
      },
    },
    counts: {
      sessions: manifest.sessions.length,
      duplicatesExact: {
        clusters: duplicatesFile.clusters.length,
        sessions: duplicatesSessionCount,
      },
      zombies: classCounts,
      projects: enrichedProjects.length,
      topics: topicsResult.topics.length,
      narratives: narrativesResult.narratives.length,
      correctionCandidates: correctionsResult.correctionsFile.corrections.length,
      playbookPatterns: playbookResult.file.patterns.length,
      playbookHits: playbookResult.totalHits,
      compositeOutcomes: compositeOutcomesCount,
      configHistoryCommits,
      itsContrasts,
      knowledgeDebtClusters,
      reflexivePairs,
      decisions: decisionsCount,
      archetypes: archetypesCount,
      projectTrajectories: projectTrajectoriesCount,
      surfaceCells: surfaceCellsCount,
      skillCurves: skillCurvesCount,
    },
  };
  const metaPath = path.join(analysisDir, 'meta.json');
  await writeFile(metaPath, JSON.stringify(metaFile, null, 2) + '\n', 'utf8');
  logger.info(`analysis: meta.json written (runId=${exporterRunId})`);

  // ---- Continuum health ----
  const priorHealth = await readPriorContinuumHealth(analysisDir);
  const health = buildContinuumHealth(manifest, priorHealth, {
    now,
    scanSucceeded: true,
  });
  const continuumHealthPath = path.join(analysisDir, 'continuum-health.json');
  await writeFile(
    continuumHealthPath,
    JSON.stringify(health, null, 2) + '\n',
    'utf8',
  );
  logger.info(
    `analysis: continuum-health.json — ${health.consecutiveSuccesses} consecutive successes, ${health.warnings.length} warnings`,
  );

  return {
    analysisDir,
    files: {
      duplicates: duplicatesPath,
      zombies: zombiesPath,
      meta: metaPath,
      projects: projectsPath,
      topics: topicsPath,
      narratives: narrativesPath,
      correctionCandidates: correctionCandidatesPath,
      continuumHealth: continuumHealthPath,
      playbookCandidates: playbookCandidatesPath,
      compositeOutcomes: compositeOutcomesPath,
      configHistory: configHistoryPath,
      itsAnalysis: itsPath,
      knowledgeDebt: knowledgeDebtPath,
      reflexive: reflexivePath,
      decisions: decisionsPath,
      archetypes: archetypesPath,
      projectTrajectories: projectTrajectoriesPath,
      surfaceComparison: surfaceComparisonPath,
      skillCurves: skillCurvesPath,
    },
    counts: {
      duplicatesClusters: duplicatesFile.clusters.length,
      duplicatesSessions: duplicatesSessionCount,
      ...classCounts,
      projects: enrichedProjects.length,
      topics: topicsResult.topics.length,
      narratives: narrativesResult.narratives.length,
      correctionCandidates: correctionsResult.correctionsFile.corrections.length,
      playbookPatterns: playbookResult.file.patterns.length,
      playbookHits: playbookResult.totalHits,
      compositeOutcomes: compositeOutcomesCount,
      configHistoryCommits,
      itsContrasts,
      knowledgeDebtClusters,
      reflexivePairs,
      decisions: decisionsCount,
      archetypes: archetypesCount,
      projectTrajectories: projectTrajectoriesCount,
      surfaceCells: surfaceCellsCount,
      skillCurves: skillCurvesCount,
    },
  };
}

/**
 * Read the first human message from a session's transcript.
 *
 * Cloud: JSON with `chat_messages[]`; first `sender === 'human'` entry's `.text`.
 * CLI-direct / CLI-desktop / Cowork: JSONL; first line with `type === 'user'`
 * and `message.role === 'user'` whose `content` contains user text. Cowork
 * `message.content` can be either a string or an array of content parts; CLI
 * uses the array form.
 *
 * Returns null when no first-human text is extractable (missing file, empty
 * transcript, unknown shape).
 */
async function readFirstHumanText(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<string | null> {
  if (entry.transcriptPath === undefined) {
    // No transcript — fall back to preview (the manifest's pre-computed
    // first-200-char preview). Matches the normalization behavior used
    // on sessions with missing transcripts.
    return entry.preview ?? null;
  }
  // Containment check: a hostile or buggy manifest could put `..` or an
  // absolute path in `transcriptPath` and read arbitrary files when we
  // re-analyze a downloaded `chat-arch-data/` bundle. Resolve, then
  // assert the resolved path stays inside `outDir`.
  const baseDir = path.resolve(outDir);
  const abs = path.resolve(baseDir, entry.transcriptPath);
  const rel = path.relative(baseDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return entry.preview ?? null;
  }
  try {
    const raw = await readFile(abs, 'utf8');
    if (entry.source === 'cloud') {
      const j = JSON.parse(raw) as {
        chat_messages?: Array<{ sender?: string; text?: string }>;
      };
      const msgs = j.chat_messages ?? [];
      for (const m of msgs) {
        if (m.sender === 'human' && typeof m.text === 'string' && m.text !== '') {
          return m.text;
        }
      }
      return entry.preview ?? null;
    }
    // JSONL (CLI-direct / CLI-desktop / Cowork).
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (line === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj === null || typeof obj !== 'object') continue;
      const rec = obj as Record<string, unknown>;
      if (rec['type'] !== 'user') continue;
      const msg = rec['message'];
      if (msg === null || typeof msg !== 'object') continue;
      const mrec = msg as Record<string, unknown>;
      if (mrec['role'] !== 'user') continue;
      const content = mrec['content'];
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (
            part !== null &&
            typeof part === 'object' &&
            (part as Record<string, unknown>)['type'] === 'text' &&
            typeof (part as Record<string, unknown>)['text'] === 'string'
          ) {
            return (part as Record<string, unknown>)['text'] as string;
          }
        }
      }
    }
    return entry.preview ?? null;
  } catch {
    return entry.preview ?? null;
  }
}

/**
 * Read the prior `continuum-health.json` sidecar. Returns null when the
 * file is absent or unparseable — first scans and bundles imported fresh
 * from someone else's machine both legitimately have no prior state.
 */
async function readPriorContinuumHealth(
  analysisDir: string,
): Promise<ContinuumHealth | null> {
  try {
    const raw = await readFile(path.join(analysisDir, 'continuum-health.json'), 'utf8');
    return JSON.parse(raw) as ContinuumHealth;
  } catch {
    return null;
  }
}

function detectGitSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[a-f0-9]{7,40}$/i.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
}
