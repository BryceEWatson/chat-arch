/**
 * Wave 2 semantic-analysis Node I/O shell.
 *
 * The pure kernels live in `@chat-arch/analysis`. This module wires them
 * to disk:
 *
 *   - Reads `analysis/embeddings.bin` + `embeddings.meta.json` (skip-soft
 *     when the embedding pass was skipped).
 *   - Reads `analysis/applied-improvements.json` (skip-soft when absent;
 *     no prior apply history is the legitimate first-run state).
 *   - Walks every non-pruned session's transcript to collect assistant
 *     messages → calls extractClaims and writes `audit-claims.json`.
 *   - Runs buildSemanticDuplicates + discoverTopicsLocal + scoreManifest
 *     + buildUpgradeOutcomes.
 *   - Writes 4 new sidecars and rewrites `manifest.json` with
 *     discoveryScore populated on every eligible entry.
 *
 * Fail-soft on missing embeddings: discoveryScore + audit-claims still
 * run (they don't need vectors); semantic dedup + local-topic-extension
 * write empty sidecars so downstream consumers see a deterministic shape.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  AuditClaim,
  EmbeddingMeta,
  SessionManifest,
  UnifiedSessionEntry,
  DuplicatesSemanticFile,
  Topic,
  UpgradeOutcomesFile,
} from '@chat-arch/schema';
import {
  buildSemanticDuplicates,
  buildUpgradeOutcomes,
  discoverTopicsLocal,
  extractClaims,
  scoreManifest,
  type AppliedImprovementLite,
  type AssistantMessage,
  type DuplicatesFile,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';

export interface RunSemanticAnalysisOptions {
  outDir: string;
  manifest: SessionManifest;
  now?: number;
  /** Override sessionToProject mapping for tests; otherwise rebuilt from entries. */
  sessionToProject?: ReadonlyMap<string, string>;
}

export interface RunSemanticAnalysisResult {
  manifestPath: string;
  files: {
    duplicatesSemantic: string;
    topicsAppended: string;
    auditClaims: string;
    upgradeOutcomes: string;
    discoveryScores: string;
  };
  counts: {
    discoveryScored: number;
    discoveryHighScored: number;
    semanticDupClusters: number;
    topicsLocal: number;
    auditClaims: number;
    upgradeOutcomes: number;
  };
  embeddingsAvailable: boolean;
}

const DISCOVERY_SCORE_HIGH_THRESHOLD = 0.7;

interface LoadedEmbeddings {
  meta: EmbeddingMeta;
  bin: Buffer;
}

async function loadEmbeddings(analysisDir: string): Promise<LoadedEmbeddings | null> {
  const metaPath = path.join(analysisDir, 'embeddings.meta.json');
  const binPath = path.join(analysisDir, 'embeddings.bin');
  let meta: EmbeddingMeta;
  let bin: Buffer;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8')) as EmbeddingMeta;
  } catch {
    return null;
  }
  try {
    bin = await readFile(binPath);
  } catch {
    return null;
  }
  if (meta.entries.length === 0) return { meta, bin };
  return { meta, bin };
}

function buildVectorMap(loaded: LoadedEmbeddings): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const stride = loaded.meta.dimensions * 4;
  for (const entry of loaded.meta.entries) {
    if (entry.offset < 0 || entry.offset + stride > loaded.bin.length) continue;
    // Copy out into a fresh Float32Array to detach from the Buffer.
    const view = new Float32Array(loaded.meta.dimensions);
    for (let i = 0; i < loaded.meta.dimensions; i += 1) {
      view[i] = loaded.bin.readFloatLE(entry.offset + i * 4);
    }
    out.set(entry.sessionId, view);
  }
  return out;
}

async function loadAppliedImprovements(
  analysisDir: string,
): Promise<readonly AppliedImprovement[]> {
  try {
    const raw = await readFile(path.join(analysisDir, 'applied-improvements.json'), 'utf8');
    const file = JSON.parse(raw) as AppliedImprovementsFile;
    return file.entries ?? [];
  } catch {
    return [];
  }
}

async function loadExactDuplicates(
  analysisDir: string,
): Promise<ReadonlySet<string>> {
  const exclude = new Set<string>();
  try {
    const raw = await readFile(path.join(analysisDir, 'duplicates.exact.json'), 'utf8');
    const file = JSON.parse(raw) as DuplicatesFile;
    for (const cluster of file.clusters ?? []) {
      const ids = cluster.sessionIds;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const a = ids[i] as string;
          const b = ids[j] as string;
          exclude.add(a < b ? `${a}::${b}` : `${b}::${a}`);
        }
      }
    }
  } catch {
    // Missing duplicates file just means no exclusions.
  }
  return exclude;
}

/**
 * Walk a session's transcript and return every assistant message body.
 * Cloud: JSON with `chat_messages[]` where `sender === 'assistant'`.
 * CLI/Cowork: JSONL with `type === 'assistant'` and `message.content[]`
 * (or a string content).
 *
 * Returns [] on any error so a single broken transcript doesn't fail the
 * audit run.
 */
async function readAssistantMessages(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<AssistantMessage[]> {
  if (entry.transcriptPath === undefined) return [];
  const baseDir = path.resolve(outDir);
  const abs = path.resolve(baseDir, entry.transcriptPath);
  const rel = path.relative(baseDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];

  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    return [];
  }

  const out: AssistantMessage[] = [];
  if (entry.source === 'cloud') {
    let j: { chat_messages?: Array<{ sender?: string; text?: string }> };
    try {
      j = JSON.parse(raw) as typeof j;
    } catch {
      return [];
    }
    const msgs = j.chat_messages ?? [];
    let lineNumber = 1;
    for (const m of msgs) {
      if (m.sender === 'assistant' && typeof m.text === 'string' && m.text !== '') {
        out.push({ lineNumber, text: m.text });
      }
      lineNumber += 1;
    }
    return out;
  }

  // JSONL — one record per line.
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;
    if (rec['type'] !== 'assistant') continue;
    const msg = rec['message'];
    if (msg === null || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>)['content'];
    if (typeof content === 'string') {
      if (content !== '') out.push({ lineNumber: i + 1, text: content });
      continue;
    }
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const part of content) {
        if (
          part !== null &&
          typeof part === 'object' &&
          (part as Record<string, unknown>)['type'] === 'text'
        ) {
          const t = (part as Record<string, unknown>)['text'];
          if (typeof t === 'string' && t !== '') textParts.push(t);
        }
      }
      if (textParts.length > 0) {
        out.push({ lineNumber: i + 1, text: textParts.join('\n') });
      }
    }
  }
  return out;
}

export async function runSemanticAnalysis(
  options: RunSemanticAnalysisOptions,
): Promise<RunSemanticAnalysisResult> {
  const now = options.now ?? Date.now();
  const analysisDir = path.join(options.outDir, 'analysis');
  await mkdir(analysisDir, { recursive: true });
  const manifestPath = path.join(options.outDir, 'manifest.json');

  const loaded = await loadEmbeddings(analysisDir);
  const vectorMap = loaded !== null ? buildVectorMap(loaded) : new Map<string, Float32Array>();
  const embeddingsAvailable = loaded !== null && vectorMap.size > 0;

  const applications = await loadAppliedImprovements(analysisDir);
  const exactPairs = await loadExactDuplicates(analysisDir);

  // ---- Discovery scoring (does not need embeddings) ----
  const liteApps: AppliedImprovementLite[] = applications.map(
    (a): AppliedImprovementLite => ({ appliedAt: a.appliedAt }),
  );
  const scoreMap = scoreManifest(options.manifest.sessions, liteApps, new Set<string>());

  // Rewrite manifest sessions with discoveryScore populated.
  const updatedSessions: UnifiedSessionEntry[] = options.manifest.sessions.map((e) => {
    const r = scoreMap.get(e.id);
    if (r === undefined) {
      // pruned or no score — leave as-is, but drop a stale score from prior runs.
      if (e.discoveryScore === undefined) return e;
      // Avoid spreading-then-undefined under exactOptionalPropertyTypes.
      const { discoveryScore: _drop, ...rest } = e;
      void _drop;
      return rest as UnifiedSessionEntry;
    }
    return { ...e, discoveryScore: r.score };
  });

  const updatedManifest: SessionManifest = {
    ...options.manifest,
    sessions: updatedSessions,
  };
  await writeFile(manifestPath, JSON.stringify(updatedManifest, null, 2) + '\n', 'utf8');

  let discoveryHighScored = 0;
  for (const r of scoreMap.values()) {
    if (r.score >= DISCOVERY_SCORE_HIGH_THRESHOLD) discoveryHighScored += 1;
  }

  const discoveryScoresPath = path.join(analysisDir, 'discovery-scores.json');
  const discoveryScores = {
    version: 1 as const,
    generatedAt: now,
    threshold: DISCOVERY_SCORE_HIGH_THRESHOLD,
    scores: Array.from(scoreMap.entries()).map(([sessionId, r]) => ({
      sessionId,
      score: r.score,
      components: r.components,
    })),
  };
  await writeFile(discoveryScoresPath, JSON.stringify(discoveryScores, null, 2) + '\n', 'utf8');
  logger.info(
    `semantic: discovery-scores.json — ${scoreMap.size} scored, ` +
      `${discoveryHighScored} above ${DISCOVERY_SCORE_HIGH_THRESHOLD}`,
  );

  // ---- Semantic dedup ----
  const dupInputs = options.manifest.sessions
    .map((e) => {
      const v = vectorMap.get(e.id);
      return v === undefined ? null : { sessionId: e.id, vector: v };
    })
    .filter((x): x is { sessionId: string; vector: Float32Array } => x !== null);

  const dupFile: DuplicatesSemanticFile = embeddingsAvailable
    ? buildSemanticDuplicates(dupInputs, {
        excludePairs: exactPairs,
        now,
      })
    : {
        version: 1,
        generatedAt: now,
        threshold: 0.92,
        clusters: [],
      };

  const dupPath = path.join(analysisDir, 'duplicates.semantic.json');
  await writeFile(dupPath, JSON.stringify(dupFile, null, 2) + '\n', 'utf8');
  logger.info(`semantic: duplicates.semantic.json — ${dupFile.clusters.length} clusters`);

  // ---- Local-session topic extension ----
  const sessionToProject = options.sessionToProject ?? buildSessionToProject(options.manifest);
  const topicsLocal = embeddingsAvailable
    ? discoverTopicsLocal(options.manifest.sessions, vectorMap, sessionToProject, { now })
    : { topics: [] as Topic[], sessionToTopics: new Map<string, string[]>(), consideredCount: 0 };

  // Append local topics to the existing topics.json (the heuristic pass
  // wrote it earlier in runAnalysis). Re-read, merge, rewrite.
  const topicsPath = path.join(analysisDir, 'topics.json');
  let existingTopics: Topic[] = [];
  try {
    const t = JSON.parse(await readFile(topicsPath, 'utf8')) as { topics?: Topic[] };
    existingTopics = t.topics ?? [];
  } catch {
    existingTopics = [];
  }
  // Filter out any prior local-topic entries so re-runs are idempotent.
  const baseTopics = existingTopics.filter((t) => !t.id.startsWith('topic_local_'));
  const mergedTopics = [...baseTopics, ...topicsLocal.topics];
  await writeFile(
    topicsPath,
    JSON.stringify({ generatedAt: now, topics: mergedTopics }, null, 2) + '\n',
    'utf8',
  );
  logger.info(
    `semantic: topics.json — appended ${topicsLocal.topics.length} local topic(s) ` +
      `from ${topicsLocal.consideredCount} considered local sessions`,
  );

  // ---- Audit claims (F.1) ----
  const allClaims: AuditClaim[] = [];
  let scannedTranscripts = 0;
  for (const entry of options.manifest.sessions) {
    if (entry.transcriptStatus === 'pruned') continue;
    const msgs = await readAssistantMessages(entry, options.outDir);
    if (msgs.length === 0) continue;
    scannedTranscripts += 1;
    const r = extractClaims(entry.id, entry.source, msgs);
    for (const c of r.claims) allClaims.push(c);
  }
  const auditClaimsFile = {
    version: 1 as const,
    generatedAt: now,
    totalClaims: allClaims.length,
    scannedTranscripts,
    claims: allClaims,
  };
  const auditClaimsPath = path.join(analysisDir, 'audit-claims.json');
  await writeFile(auditClaimsPath, JSON.stringify(auditClaimsFile, null, 2) + '\n', 'utf8');
  logger.info(
    `semantic: audit-claims.json — ${allClaims.length} claims from ${scannedTranscripts} transcripts`,
  );

  // ---- Upgrade outcomes ----
  const upgradeOutcomes: UpgradeOutcomesFile = buildUpgradeOutcomes(
    options.manifest.sessions,
    applications,
    { now },
  );
  const upgradePath = path.join(analysisDir, 'upgrade-outcomes.json');
  await writeFile(upgradePath, JSON.stringify(upgradeOutcomes, null, 2) + '\n', 'utf8');
  logger.info(`semantic: upgrade-outcomes.json — ${upgradeOutcomes.outcomes.length} outcomes`);

  return {
    manifestPath,
    files: {
      duplicatesSemantic: dupPath,
      topicsAppended: topicsPath,
      auditClaims: auditClaimsPath,
      upgradeOutcomes: upgradePath,
      discoveryScores: discoveryScoresPath,
    },
    counts: {
      discoveryScored: scoreMap.size,
      discoveryHighScored,
      semanticDupClusters: dupFile.clusters.length,
      topicsLocal: topicsLocal.topics.length,
      auditClaims: allClaims.length,
      upgradeOutcomes: upgradeOutcomes.outcomes.length,
    },
    embeddingsAvailable,
  };
}

function buildSessionToProject(manifest: SessionManifest): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of manifest.sessions) {
    const key = s.projectId ?? s.project;
    if (key !== undefined) m.set(s.id, key);
  }
  return m;
}
