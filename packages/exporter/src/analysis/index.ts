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
 * Phase 7 writers do NOT land here (they live in a separate skill/package
 * per Decision 1). Never writes tier-2 filenames.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { logger } from '../lib/logger.js';
import {
  buildDuplicatesFile,
  buildZombiesFile,
  discoverProjects,
  discoverTopics,
  discoverNarratives,
  type DuplicateInput,
} from '@chat-arch/analysis';
import { buildCorrectionsCandidatesFile } from './corrections.js';

export interface RunAnalysisOptions {
  /** Root output dir (same one `manifest.json` sits in). */
  outDir: string;
  /** Override "now" for tests. Defaults to Date.now(). */
  now?: number;
  /** Override exporterRunId for tests. */
  exporterRunId?: string;
  /** Override gitSha detection for tests. */
  gitSha?: string | null;
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
  };
}

/**
 * Exported so the per-source cache loaders (cli.ts, cowork.ts) can
 * gate reuse on a version match — when the on-disk entry shape
 * changes, all prior caches self-invalidate on next rescan.
 */
export const EXPORTER_VERSION = '0.10.0';

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
    },
  };
  const metaPath = path.join(analysisDir, 'meta.json');
  await writeFile(metaPath, JSON.stringify(metaFile, null, 2) + '\n', 'utf8');
  logger.info(`analysis: meta.json written (runId=${exporterRunId})`);

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
    },
    counts: {
      duplicatesClusters: duplicatesFile.clusters.length,
      duplicatesSessions: duplicatesSessionCount,
      ...classCounts,
      projects: enrichedProjects.length,
      topics: topicsResult.topics.length,
      narratives: narrativesResult.narratives.length,
      correctionCandidates: correctionsResult.correctionsFile.corrections.length,
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
