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
  AuditResult,
  AuditResultsFile,
  AuditSummary,
  BlogCandidatesFile,
  ContinuumHealth,
  CorrectionsFile,
  EmbeddingMeta,
  SessionManifest,
  SessionSource,
  UnifiedSessionEntry,
  DuplicatesSemanticFile,
  Topic,
  UpgradeOutcomesFile,
} from '@chat-arch/schema';
import {
  buildBlogCandidates,
  buildDailyBrief,
  buildSemanticDuplicates,
  buildUpgradeOutcomes,
  discoverTopicsLocal,
  extractClaims,
  scoreManifest,
  verifySessions,
  type AppliedImprovementLite,
  type AssistantMessage,
  type CalibrationCurve,
  type DuplicatesFile,
  type TimelineEvent,
  type VerifySessionInput,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';
import { countDefinedFields } from '../merge.js';

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
    auditResults: string;
    auditSummary: string;
    upgradeOutcomes: string;
    discoveryScores: string;
    blogCandidates: string;
    dailyBrief: string;
  };
  counts: {
    discoveryScored: number;
    discoveryHighScored: number;
    semanticDupClusters: number;
    topicsLocal: number;
    auditClaims: number;
    auditPass: number;
    auditFail: number;
    auditInconclusive: number;
    upgradeOutcomes: number;
    blogCandidates: number;
  };
  embeddingsAvailable: boolean;
}

const DISCOVERY_SCORE_HIGH_THRESHOLD = 0.7;

interface LoadedEmbeddings {
  meta: EmbeddingMeta;
  bin: Buffer;
}

async function loadCalibration(outDir: string): Promise<CalibrationCurve | undefined> {
  const p = path.join(outDir, 'calibration.json');
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'schemaVersion' in parsed &&
      'knots' in parsed &&
      Array.isArray((parsed as { knots: unknown }).knots)
    ) {
      return parsed as CalibrationCurve;
    }
    return undefined;
  } catch {
    // Absent file is the cold-start path — fall back to literature
    // threshold downstream. Not an error.
    return undefined;
  }
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

/**
 * Build the (sessionId → vector) lookup used by downstream semantic kernels.
 *
 * The embeddings sidecar's primary key is `(source, sessionId)` — see
 * `EmbeddingMetaEntry` — and a single id can appear in both `cli-direct`
 * and `cli-desktop` entries pointing at the same underlying transcript.
 * Keying the map by `sessionId` alone would let one source's vector
 * overwrite the other's silently.
 *
 * The semantic-analysis caller has already collapsed manifest sessions
 * to one entry per id (see `collapseByIdRicher`); the resulting
 * `sourceById` map tells us which source's embedding to keep for each
 * id. Embeddings whose source doesn't match the collapsed selection are
 * skipped — the downstream sidecar formats are bare-id-keyed, so making
 * sure each id resolves to ONE consistent vector is the correctness
 * boundary that matters here.
 */
function buildVectorMap(
  loaded: LoadedEmbeddings,
  sourceById: ReadonlyMap<string, SessionSource>,
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const stride = loaded.meta.dimensions * 4;
  for (const entry of loaded.meta.entries) {
    if (entry.offset < 0 || entry.offset + stride > loaded.bin.length) continue;
    const selected = sourceById.get(entry.sessionId);
    if (selected !== undefined && selected !== entry.source) continue;
    // Copy out into a fresh Float32Array to detach from the Buffer.
    const view = new Float32Array(loaded.meta.dimensions);
    for (let i = 0; i < loaded.meta.dimensions; i += 1) {
      view[i] = loaded.bin.readFloatLE(entry.offset + i * 4);
    }
    out.set(entry.sessionId, view);
  }
  return out;
}

/**
 * Collapse the manifest's session list to ONE entry per `id`, picking the
 * "richest" entry when multiple sources share an id. Uses the same richness
 * metric as `mergeSources` (`countDefinedFields`) so the analysis stage
 * agrees with the merge on which row carries the canonical content.
 *
 * Why we collapse for analysis but not in the manifest itself: the manifest
 * is the authoritative ledger of every ingest path's view of a session
 * (the schema's `(source, id)` primary key contract). Semantic analysis,
 * however, writes bare-id-keyed sidecars (audit-claims, duplicates.semantic,
 * topics) — if both views participate, each id resolves to two competing
 * outcomes that the sidecar shape can't disambiguate. Two views of the
 * same transcript should produce ONE analysis. The richer row wins so we
 * don't drop fields that only the richer ingest path filled in.
 */
function collapseByIdRicher(
  sessions: readonly UnifiedSessionEntry[],
): { sessions: UnifiedSessionEntry[]; sourceById: Map<string, SessionSource> } {
  const byId = new Map<string, UnifiedSessionEntry>();
  for (const e of sessions) {
    const existing = byId.get(e.id);
    if (existing === undefined) {
      byId.set(e.id, e);
      continue;
    }
    if (countDefinedFields(e) >= countDefinedFields(existing)) byId.set(e.id, e);
  }
  const sourceById = new Map<string, SessionSource>();
  for (const [id, e] of byId) sourceById.set(id, e.source);
  return { sessions: [...byId.values()], sourceById };
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
    let j: {
      chat_messages?: Array<{
        sender?: string;
        text?: string;
        content?: unknown;
      }>;
    };
    try {
      j = JSON.parse(raw) as typeof j;
    } catch {
      return [];
    }
    const msgs = j.chat_messages ?? [];
    let lineNumber = 1;
    for (const m of msgs) {
      if (m.sender === 'assistant') {
        // Prefer the flat `text` field when populated. Cloud exports
        // sometimes leave `text` empty and put the message body into
        // `content[]` blocks (each `{type:'text', text:'…'}`), the
        // same shape the JSONL `content` arrays use below. Falling
        // through to the block parser catches those sessions, which
        // otherwise emit zero assistant messages and silently miss
        // every claim they contain.
        if (typeof m.text === 'string' && m.text !== '') {
          out.push({ lineNumber, text: m.text });
        } else if (Array.isArray(m.content)) {
          const textParts: string[] = [];
          for (const part of m.content) {
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
            out.push({ lineNumber, text: textParts.join('\n') });
          }
        }
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

/**
 * Walk a transcript and emit the full timeline (assistant, user,
 * tool_use, tool_result events) for the F.2 verifier. Returns [] on
 * any error — broken transcripts cost the verifier visibility, not
 * the run.
 */
async function readTimeline(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<TimelineEvent[]> {
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

  const out: TimelineEvent[] = [];

  if (entry.source === 'cloud') {
    let j: { chat_messages?: Array<{ sender?: string; text?: string }> };
    try {
      j = JSON.parse(raw) as typeof j;
    } catch {
      return [];
    }
    let lineNumber = 1;
    for (const m of j.chat_messages ?? []) {
      const t = typeof m.text === 'string' ? m.text : '';
      if (m.sender === 'assistant' && t !== '') {
        out.push({ kind: 'assistant', lineNumber, text: t });
      } else if (m.sender === 'human' && t !== '') {
        out.push({ kind: 'user', lineNumber, text: t });
      }
      lineNumber += 1;
    }
    // Cloud transcripts don't surface tool_use/tool_result discretely
    // in chat_messages; the verifier degrades to 'inconclusive' for
    // most claim types on cloud sessions. That's expected — cloud is
    // a chat surface, not an agent surface.
    return out;
  }

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
    const type = rec['type'];

    if (type === 'user') {
      const msg = rec['message'];
      if (msg !== null && typeof msg === 'object') {
        const content = (msg as Record<string, unknown>)['content'];
        if (typeof content === 'string' && content !== '') {
          out.push({ kind: 'user', lineNumber: i + 1, text: content });
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part !== null && typeof part === 'object') {
              const p = part as Record<string, unknown>;
              if (p['type'] === 'text' && typeof p['text'] === 'string') {
                out.push({ kind: 'user', lineNumber: i + 1, text: p['text'] });
              } else if (p['type'] === 'tool_result') {
                const c = p['content'];
                const text =
                  typeof c === 'string'
                    ? c
                    : Array.isArray(c)
                      ? c
                          .map((x) =>
                            x !== null && typeof x === 'object' && typeof (x as Record<string, unknown>)['text'] === 'string'
                              ? (x as Record<string, unknown>)['text']
                              : '',
                          )
                          .join('\n')
                      : '';
                out.push({
                  kind: 'tool_result',
                  lineNumber: i + 1,
                  text: String(text),
                  isError: p['is_error'] === true,
                });
              }
            }
          }
        }
      }
    } else if (type === 'assistant') {
      const msg = rec['message'];
      if (msg !== null && typeof msg === 'object') {
        const content = (msg as Record<string, unknown>)['content'];
        if (typeof content === 'string' && content !== '') {
          out.push({ kind: 'assistant', lineNumber: i + 1, text: content });
        } else if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const part of content) {
            if (part !== null && typeof part === 'object') {
              const p = part as Record<string, unknown>;
              if (p['type'] === 'text' && typeof p['text'] === 'string') {
                textParts.push(p['text']);
              } else if (p['type'] === 'tool_use') {
                const name = typeof p['name'] === 'string' ? p['name'] : '';
                const input =
                  p['input'] !== null && typeof p['input'] === 'object'
                    ? (p['input'] as Record<string, unknown>)
                    : {};
                out.push({ kind: 'tool_use', lineNumber: i + 1, name, input });
              }
            }
          }
          if (textParts.length > 0) {
            out.push({ kind: 'assistant', lineNumber: i + 1, text: textParts.join('\n') });
          }
        }
      }
    }
  }
  return out;
}

async function loadCorrections(analysisDir: string): Promise<CorrectionsFile | null> {
  try {
    const raw = await readFile(path.join(analysisDir, 'corrections.json'), 'utf8');
    return JSON.parse(raw) as CorrectionsFile;
  } catch {
    return null;
  }
}

async function loadContinuumHealth(analysisDir: string): Promise<ContinuumHealth | null> {
  try {
    const raw = await readFile(path.join(analysisDir, 'continuum-health.json'), 'utf8');
    return JSON.parse(raw) as ContinuumHealth;
  } catch {
    return null;
  }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function runSemanticAnalysis(
  options: RunSemanticAnalysisOptions,
): Promise<RunSemanticAnalysisResult> {
  const now = options.now ?? Date.now();
  const analysisDir = path.join(options.outDir, 'analysis');
  await mkdir(analysisDir, { recursive: true });
  const manifestPath = path.join(options.outDir, 'manifest.json');

  // Collapse (source, id) duplicates to one entry per id for analysis
  // purposes. The manifest itself keeps both rows (schema's primary key
  // is `(source, id)`) — only the in-process semantic analysis works on
  // the collapsed view so downstream bare-id-keyed sidecars don't get
  // contradictory rows per id. `sourceById` lets `buildVectorMap` pick
  // the embedding for the selected source.
  const collapsed = collapseByIdRicher(options.manifest.sessions);
  const analysisSessions = collapsed.sessions;

  const loaded = await loadEmbeddings(analysisDir);
  const vectorMap =
    loaded !== null
      ? buildVectorMap(loaded, collapsed.sourceById)
      : new Map<string, Float32Array>();
  const embeddingsAvailable = loaded !== null && vectorMap.size > 0;

  // Load the probability calibration curve produced by
  // `scripts/fit-calibration.mjs` (Platt at small n, isotonic above
  // ~500 labels). Absent file → undefined → dedup falls back to the
  // literature cosine threshold. Motivation: residual absolute-cosine
  // miscalibration even on contrastively-trained sentence embedders
  // (Tacheny 2026 arXiv:2601.16907; Ethayarajh 2019 D19-1006). See
  // research/dedup-calibration-design.md and the audit at
  // research/calibration-audit-2026-05-19.md.
  const calibration = await loadCalibration(options.outDir);
  if (calibration !== undefined) {
    logger.info(
      `semantic: calibration loaded — ${calibration.labelCount} labels, ${calibration.knots.length} knots`,
    );
  }

  const applications = await loadAppliedImprovements(analysisDir);
  const exactPairs = await loadExactDuplicates(analysisDir);

  // ---- Discovery scoring (does not need embeddings) ----
  const liteApps: AppliedImprovementLite[] = applications.map(
    (a): AppliedImprovementLite => ({ appliedAt: a.appliedAt }),
  );
  const scoreMap = scoreManifest(analysisSessions, liteApps, new Set<string>());

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
  // Use the collapsed view so each id contributes ONE entry (and one
  // vector) to dedup — otherwise two ingest views of the same transcript
  // would always show up as a "duplicate" of themselves.
  const dupInputs = analysisSessions
    .map((e) => {
      const v = vectorMap.get(e.id);
      return v === undefined ? null : { sessionId: e.id, vector: v };
    })
    .filter((x): x is { sessionId: string; vector: Float32Array } => x !== null);

  const dupFile: DuplicatesSemanticFile = embeddingsAvailable
    ? buildSemanticDuplicates(dupInputs, {
        excludePairs: exactPairs,
        // Complete-linkage avoids the single-linkage chaining bug
        // (A~B~C~D collapsing into one mega-cluster even when cos(A,D)
        // is well below threshold). At 1k sessions the wall-clock cost
        // is indistinguishable; at 10k+ it's the difference between a
        // trustable dedup view and a noisy one. See module header on
        // `duplicatesSemantic.ts` for the linkage tradeoff.
        linkage: 'complete',
        ...(calibration !== undefined ? { calibration } : {}),
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
    ? discoverTopicsLocal(analysisSessions, vectorMap, sessionToProject, { now })
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
  // Walk the collapsed view so each id contributes ONE transcript's claims
  // — extracting from both cli-direct and cli-desktop views of the same
  // transcript would double-count and then mis-attribute on the verifier
  // join. Output's `AuditClaim.source` records which ingest path the
  // analysis used; the bare `sessionId` field is unambiguous now that
  // each id resolves to a single analyzed entry.
  const allClaims: AuditClaim[] = [];
  let scannedTranscripts = 0;
  for (const entry of analysisSessions) {
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
  // Use the collapsed view — outcome calculations count sessions per
  // window, and two ingest views of the same session would inflate the
  // counts.
  const upgradeOutcomes: UpgradeOutcomesFile = buildUpgradeOutcomes(
    analysisSessions,
    applications,
    { now },
  );
  const upgradePath = path.join(analysisDir, 'upgrade-outcomes.json');
  await writeFile(upgradePath, JSON.stringify(upgradeOutcomes, null, 2) + '\n', 'utf8');
  logger.info(`semantic: upgrade-outcomes.json — ${upgradeOutcomes.outcomes.length} outcomes`);

  // ---- Wave 3: F.2 evidence verifier ----
  // Group claims by session and walk each session's timeline once.
  // analysisSessions is already collapsed to one entry per id, and
  // allClaims only contains claims extracted from those entries, so
  // grouping by `c.sessionId` no longer crosses sources.
  const claimsBySession = new Map<string, AuditClaim[]>();
  for (const c of allClaims) {
    const list = claimsBySession.get(c.sessionId);
    if (list === undefined) claimsBySession.set(c.sessionId, [c]);
    else list.push(c);
  }
  const entryById = new Map<string, UnifiedSessionEntry>();
  // Build entryById from the collapsed view but keep discoveryScore by
  // joining against the full-manifest updatedSessions map (every id is
  // present there with its score). This gives the verifier the right
  // transcript path AND the score data the blog scorer needs later.
  const updatedById = new Map<string, UnifiedSessionEntry>();
  for (const e of updatedSessions) {
    const existing = updatedById.get(e.id);
    if (existing === undefined || countDefinedFields(e) >= countDefinedFields(existing)) {
      updatedById.set(e.id, e);
    }
  }
  for (const e of analysisSessions) {
    entryById.set(e.id, updatedById.get(e.id) ?? e);
  }

  const verifyInputs: VerifySessionInput[] = [];
  for (const [sessionId, claims] of claimsBySession) {
    const entry = entryById.get(sessionId);
    if (entry === undefined) continue;
    const timeline = await readTimeline(entry, options.outDir);
    const projectKey = entry.projectId ?? entry.project;
    verifyInputs.push({
      sessionId,
      timeline,
      claims,
      ...(projectKey !== undefined ? { projectKey } : {}),
    });
  }
  const verifyResult = verifySessions(verifyInputs, now);
  const auditResultsFile: AuditResultsFile = {
    version: 1,
    generatedAt: now,
    totals: verifyResult.summary.totals,
    results: verifyResult.results,
  };
  const auditResultsPath = path.join(analysisDir, 'audit-results.json');
  await writeFile(
    auditResultsPath,
    JSON.stringify(auditResultsFile, null, 2) + '\n',
    'utf8',
  );
  const auditSummaryPath = path.join(analysisDir, 'audit-summary.json');
  await writeFile(
    auditSummaryPath,
    JSON.stringify(verifyResult.summary, null, 2) + '\n',
    'utf8',
  );
  logger.info(
    `semantic: audit-results.json — pass=${verifyResult.summary.totals.pass} ` +
      `fail=${verifyResult.summary.totals.fail} inconclusive=${verifyResult.summary.totals.inconclusive}`,
  );

  // ---- Wave 3: blog candidate selector ----
  const sessionPassRate = new Map<string, number>();
  // Pre-aggregate per-session pass rate over the verifier results.
  {
    const perSession = new Map<string, { pass: number; total: number }>();
    for (const r of verifyResult.results) {
      const slot = perSession.get(r.sessionId) ?? { pass: 0, total: 0 };
      slot.total += 1;
      if (r.outcome === 'pass') slot.pass += 1;
      perSession.set(r.sessionId, slot);
    }
    for (const [sid, { pass, total }] of perSession) {
      sessionPassRate.set(sid, total === 0 ? 0 : pass / total);
    }
  }

  // Blog candidates run on the collapsed view but with the discoveryScore-
  // enriched entries (analysisSessions is the collapsed list before
  // scoring; we re-resolve each id to its scored counterpart from
  // updatedSessions so the cluster scorer sees the score field).
  const scoredAnalysisSessions = analysisSessions.map(
    (e) => updatedById.get(e.id) ?? e,
  );
  const blogCandidates: BlogCandidatesFile = embeddingsAvailable
    ? buildBlogCandidates(scoredAnalysisSessions, vectorMap, {
        sessionAuditPassRate: sessionPassRate,
        now,
      })
    : {
        version: 1,
        generatedAt: now,
        clusterThreshold: 0.78,
        discoveryScoreThreshold: 0.7,
        candidates: [],
      };
  const blogCandidatesPath = path.join(analysisDir, 'blog-candidates.json');
  await writeFile(
    blogCandidatesPath,
    JSON.stringify(blogCandidates, null, 2) + '\n',
    'utf8',
  );
  logger.info(`semantic: blog-candidates.json — ${blogCandidates.candidates.length} candidates`);

  // Emit draft-prompt notes for the top 3 candidates (the chat-answer
  // skill consumes these). Drafts themselves require an LLM pass; per
  // spec Blog.2 the user runs the chat-answer skill in draft mode
  // against this prompt to produce the markdown. The exporter does NOT
  // call the LLM directly to keep the all-pipeline offline-able.
  const draftsDir = path.join(analysisDir, 'blog-drafts');
  await mkdir(draftsDir, { recursive: true });
  const top = blogCandidates.candidates.slice(0, 3);
  for (const cand of top) {
    const slug = `${isoDate(now)}-${slugify(cand.workingTitle)}-${cand.id}`;
    const promptPath = path.join(draftsDir, `${slug}.prompt.md`);
    const memberLines = cand.clusterSessionIds.map((sid) => {
      const e = entryById.get(sid);
      return e === undefined
        ? `- [SID:${sid}] (entry not found)`
        : `- [SID:${sid}] · ${e.title} · ${new Date(e.startedAt).toISOString().slice(0, 10)} · discoveryScore=${(e.discoveryScore ?? 0).toFixed(2)}`;
    });
    const lines = [
      `# Blog draft prompt — ${cand.workingTitle}`,
      '',
      `Candidate id: ${cand.id}`,
      `Cluster score: ${cand.score.toFixed(3)} (mean discovery=${cand.meanDiscoveryScore.toFixed(2)}, span=${cand.spanDays.toFixed(1)}d, novelty=${cand.noveltyScore.toFixed(2)})`,
      cand.meanAuditPassRate !== null
        ? `Mean F-audit pass rate over cluster: ${(cand.meanAuditPassRate * 100).toFixed(0)}%`
        : 'Mean F-audit pass rate: n/a',
      '',
      '## Member sessions',
      ...memberLines,
      '',
      '## How to generate',
      '',
      'Invoke the chat-answer skill in draft mode against the member sessions above. The skill should:',
      '',
      '- Read each [SID:...] session in full.',
      '- Identify the through-line that makes them a single story.',
      '- Draft a markdown blog post with inline [SID:...] citations.',
      "- Match the user's voice (sample posts cached at brycewatson.com/blog).",
      '',
      'Drop the resulting markdown next to this file as',
      `\`analysis/blog-drafts/${slug}.md\` and the F-audit pass will pick it up on the next rescan.`,
    ];
    await writeFile(promptPath, lines.join('\n') + '\n', 'utf8');
  }
  logger.info(`semantic: wrote ${top.length} blog-draft prompt(s) to ${draftsDir}`);

  // ---- Wave 3: daily brief ----
  const corrections = await loadCorrections(analysisDir);
  const continuumHealth = await loadContinuumHealth(analysisDir);
  const briefDate = isoDate(now);
  const briefDir = path.join(analysisDir, 'briefs');
  await mkdir(briefDir, { recursive: true });
  const brief = buildDailyBrief({
    date: briefDate,
    now,
    patterns: corrections?.patterns ?? [],
    upgradeOutcomes: upgradeOutcomes.outcomes,
    blogDrafts: [],
    auditResults: verifyResult.results,
    auditSummary: verifyResult.summary,
    continuumHealth,
  });
  const briefPath = path.join(briefDir, `${briefDate}.md`);
  await writeFile(briefPath, brief.markdown, 'utf8');
  logger.info(
    `semantic: briefs/${briefDate}.md — patterns=${brief.counts.patternsShifted} ` +
      `upgrades=${brief.counts.upgradesShown} drafts=${brief.counts.blogDraftsShown} ` +
      `concerns=${brief.counts.auditConcernsShown}`,
  );

  // void the unused AuditSummary symbol so the import is meaningful.
  void (null as unknown as AuditSummary | null);

  return {
    manifestPath,
    files: {
      duplicatesSemantic: dupPath,
      topicsAppended: topicsPath,
      auditClaims: auditClaimsPath,
      auditResults: auditResultsPath,
      auditSummary: auditSummaryPath,
      upgradeOutcomes: upgradePath,
      discoveryScores: discoveryScoresPath,
      blogCandidates: blogCandidatesPath,
      dailyBrief: briefPath,
    },
    counts: {
      discoveryScored: scoreMap.size,
      discoveryHighScored,
      semanticDupClusters: dupFile.clusters.length,
      topicsLocal: topicsLocal.topics.length,
      auditClaims: allClaims.length,
      auditPass: verifyResult.summary.totals.pass,
      auditFail: verifyResult.summary.totals.fail,
      auditInconclusive: verifyResult.summary.totals.inconclusive,
      upgradeOutcomes: upgradeOutcomes.outcomes.length,
      blogCandidates: blogCandidates.candidates.length,
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
