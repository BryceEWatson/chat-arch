/**
 * Stage-1 corrections writer — heuristic recall over every session's
 * transcript. Pure data prep: emits `analysis/correction-candidates.json`
 * with `pipeline.llmClassification: false`. The Claude Code skill
 * `/mine-corrections` consumes this file and writes the final
 * `analysis/corrections.json` after running LLM stages.
 *
 * Browser-safety boundary: this module reads files (Node-only), so it
 * lives in the exporter package, not analysis. The detection kernel
 * (`detectCorrectionCandidates`) stays in analysis and is browser-safe.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Correction,
  CorrectionsFile,
  ScanStats,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  HEURISTIC_RECALL_VERSION,
  detectCorrectionCandidates,
  type TurnPair,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';

/**
 * Per-session funnel counters carried back from the parser. The build
 * function aggregates these into the file-level `ScanStats` plus the
 * compact `scanStatsBySession` tuple form that survives cache reuse.
 */
interface SessionScan {
  turns: TurnPair[];
  rawTurns: number;
  wrapperFiltered: number;
  tooLongFiltered: number;
}

export interface BuildCorrectionsOptions {
  outDir: string;
  now: number;
  /** Parallelism for transcript reads. NVMe loves 8-16; spinning disk
   *  loses past 4. Default 8 — works on the audited corpus and is well
   *  under the OS's per-process file-handle ceiling. */
  ioConcurrency?: number;
}

export interface BuildCorrectionsResult {
  correctionsFile: CorrectionsFile;
  scannedSessions: number;
  missingTranscripts: number;
  totalTurnPairs: number;
  /** Sessions whose candidates were reused from the prior run (no
   *  transcript read, no detection re-run). Useful for visibility
   *  into how often the cache hits. */
  reusedSessions: number;
}

const DEFAULT_IO_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with a sliding concurrency window. Preserves
 * input order in the output. Avoids pulling in a dep — the body is
 * ~15 lines and never needs the full p-limit feature set (cancellation,
 * dynamic concurrency, etc.).
 */
async function parallelMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= items.length) return;
          out[i] = await fn(items[i] as T, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

interface PriorCache {
  generatedAt: number;
  /** sessionId → that session's prior corrections (already detected).
   *  Empty array means "scanned and found zero candidates" — distinct
   *  from "not in the map at all" which means "never scanned". */
  bySession: Map<string, Correction[]>;
  /** sessionId → tuple [rawTurns, wrapperFiltered, tooLongFiltered]
   *  preserved from the prior scan so cache-hit sessions still
   *  contribute to the funnel totals. Sessions not in this map (older
   *  files written before scanStatsBySession existed) lose their
   *  per-session contribution; affected aggregates self-heal after
   *  one full rescan. */
  statsBySession: Map<string, readonly [number, number, number]>;
}

/**
 * Load the prior `correction-candidates.json` if its heuristic version
 * matches the current one. A version mismatch invalidates the entire
 * cache — when we add or change a pattern family, every session's
 * candidates must be re-derived against the new ruleset. Returns null
 * on first run, on version mismatch, and on parse failure.
 */
async function loadPriorCache(
  outDir: string,
  currentVersion: number,
): Promise<PriorCache | null> {
  const priorPath = path.join(outDir, 'analysis', 'correction-candidates.json');
  let raw: string;
  try {
    raw = await readFile(priorPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: CorrectionsFile;
  try {
    parsed = JSON.parse(raw) as CorrectionsFile;
  } catch {
    return null;
  }
  if (typeof parsed.generatedAt !== 'number') return null;
  if (parsed.heuristicRecallVersion !== currentVersion) {
    logger.info(
      `analysis: corrections cache invalidated (file v${parsed.heuristicRecallVersion ?? '?'} vs current v${currentVersion}) — full rescan`,
    );
    return null;
  }
  // Seed the map with the explicit scanned set so sessions with zero
  // candidates still hit cache. Files written before this field existed
  // skip this seeding — those sessions get re-scanned (acceptable: one-
  // time cost on the first rescan after upgrading).
  const bySession = new Map<string, Correction[]>();
  for (const sid of parsed.scannedSessionIds ?? []) {
    if (typeof sid === 'string') bySession.set(sid, []);
  }
  for (const c of parsed.corrections ?? []) {
    if (typeof c.sessionId !== 'string') continue;
    const list = bySession.get(c.sessionId);
    if (list) list.push(c);
    else bySession.set(c.sessionId, [c]);
  }
  const statsBySession = new Map<string, readonly [number, number, number]>();
  for (const [sid, tuple] of Object.entries(parsed.scanStatsBySession ?? {})) {
    if (Array.isArray(tuple) && tuple.length === 3 && tuple.every((n) => typeof n === 'number')) {
      statsBySession.set(sid, [tuple[0], tuple[1], tuple[2]] as const);
    }
  }
  return {
    generatedAt: parsed.generatedAt,
    bySession,
    statsBySession,
  };
}

export async function buildCorrectionsCandidatesFile(
  manifest: SessionManifest,
  options: BuildCorrectionsOptions,
): Promise<BuildCorrectionsResult> {
  const t0 = Date.now();
  const concurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  const prior = await loadPriorCache(options.outDir, HEURISTIC_RECALL_VERSION);

  // Per-session work: either reuse prior candidates (no I/O) or re-scan.
  // Reuse rule: prior cache exists, this sessionId is in it, AND the
  // session's `updatedAt` is at-or-before the prior file's `generatedAt`.
  // Anything updated since the cache was written must be re-scanned.
  type PerSession =
    | { kind: 'reused'; corrections: readonly Correction[]; stats: readonly [number, number, number] | null }
    | { kind: 'scanned'; corrections: readonly Correction[]; scan: SessionScan }
    | { kind: 'missing' };

  const results = await parallelMap<UnifiedSessionEntry, PerSession>(
    manifest.sessions,
    concurrency,
    async (entry) => {
      if (prior !== null) {
        const cached = prior.bySession.get(entry.id);
        const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : Infinity;
        const stats = prior.statsBySession.get(entry.id);
        // Cache hit requires BOTH the candidates AND the per-session
        // funnel stats. A cached session without stats (file written
        // before scanStatsBySession existed) gets re-scanned so the
        // funnel converges to accurate totals after one cycle.
        if (
          cached !== undefined &&
          stats !== undefined &&
          updatedAt <= prior.generatedAt
        ) {
          return { kind: 'reused', corrections: cached, stats };
        }
      }
      const scan = await readTurnPairs(entry, options.outDir);
      if (scan === null) return { kind: 'missing' };
      const found = detectCorrectionCandidates(scan.turns);
      return { kind: 'scanned', corrections: found, scan };
    },
  );

  const allCorrections: Correction[] = [];
  const scannedSessionIds: string[] = [];
  const scanStatsBySession: Record<string, readonly [number, number, number]> = {};
  const sessionsBySource: Record<string, number> = {};
  const sessionsMissingBySource: Record<string, number> = {};
  let scanned = 0;
  let reused = 0;
  let missing = 0;
  let aggRaw = 0;
  let aggWrapper = 0;
  let aggTooLong = 0;
  let aggSurviving = 0;

  for (let i = 0; i < results.length; i += 1) {
    const entry = manifest.sessions[i] as UnifiedSessionEntry;
    const src = entry.source ?? 'unknown';
    sessionsBySource[src] = (sessionsBySource[src] ?? 0) + 1;
    const r = results[i] as PerSession;
    if (r.kind === 'missing') {
      missing += 1;
      sessionsMissingBySource[src] = (sessionsMissingBySource[src] ?? 0) + 1;
      continue;
    }
    allCorrections.push(...r.corrections);
    scannedSessionIds.push(entry.id);
    if (r.kind === 'reused') {
      reused += 1;
      // Sessions cached from a pre-stats file have null tuples — they
      // contribute zero to the funnel until they're re-scanned. The
      // top-level scanStats is then a slight under-count for one
      // cycle; subsequent runs converge as cached entries get refreshed.
      if (r.stats !== null) {
        scanStatsBySession[entry.id] = r.stats;
        aggRaw += r.stats[0];
        aggWrapper += r.stats[1];
        aggTooLong += r.stats[2];
        aggSurviving += r.stats[0] - r.stats[1] - r.stats[2];
      }
    } else {
      scanned += 1;
      const tuple: readonly [number, number, number] = [
        r.scan.rawTurns,
        r.scan.wrapperFiltered,
        r.scan.tooLongFiltered,
      ];
      scanStatsBySession[entry.id] = tuple;
      aggRaw += r.scan.rawTurns;
      aggWrapper += r.scan.wrapperFiltered;
      aggTooLong += r.scan.tooLongFiltered;
      aggSurviving += r.scan.turns.length;
    }
  }

  const scanStats: ScanStats = {
    sessionsInManifest: manifest.sessions.length,
    sessionsScanned: scannedSessionIds.length,
    sessionsMissing: missing,
    sessionsBySource,
    sessionsMissingBySource,
    rawUserTurns: aggRaw,
    wrapperFiltered: aggWrapper,
    tooLongFiltered: aggTooLong,
    survivingTurns: aggSurviving,
  };

  logger.info(
    `analysis: corrections candidate scan — ${scanned} scanned, ${reused} reused (cache), ${missing} missing, ${aggSurviving} surviving turn-pairs, ${allCorrections.length} candidates, ${Date.now() - t0}ms`,
  );

  const correctionsFile: CorrectionsFile = {
    generatedAt: options.now,
    corrections: allCorrections,
    patterns: [],
    pipeline: {
      heuristicRecall: true,
      llmClassification: false,
      embeddingClustering: false,
      claudeMdCrossCheck: false,
    },
    heuristicRecallVersion: HEURISTIC_RECALL_VERSION,
    scannedSessionIds,
    scanStats,
    scanStatsBySession,
  };

  return {
    correctionsFile,
    scannedSessions: scanned,
    missingTranscripts: missing,
    totalTurnPairs: aggSurviving,
    reusedSessions: reused,
  };
}

/**
 * Walk a session's transcript and emit (user, assistant) turn pairs
 * along with per-session funnel counters. Each user turn becomes one
 * TurnPair; `precedingAssistantText` is the most recent assistant turn
 * before it (null for the first user turn).
 *
 * Returns null when the transcript is unreadable or absent — the caller
 * counts these as missing rather than producing empty arrays (different
 * meaning).
 */
async function readTurnPairs(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<SessionScan | null> {
  if (entry.transcriptPath === undefined) return null;
  const baseDir = path.resolve(outDir);
  const abs = path.resolve(baseDir, entry.transcriptPath);
  const rel = path.relative(baseDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    return null;
  }

  if (entry.source === 'cloud') {
    return parseCloudTurns(entry.id, raw);
  }
  return parseJsonlTurns(entry.id, raw);
}

interface CloudShape {
  chat_messages?: Array<{
    sender?: string;
    text?: string;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  }>;
}

function parseCloudTurns(sessionId: string, raw: string): SessionScan {
  let j: CloudShape;
  try {
    j = JSON.parse(raw) as CloudShape;
  } catch {
    return { turns: [], rawTurns: 0, wrapperFiltered: 0, tooLongFiltered: 0 };
  }
  const turns: TurnPair[] = [];
  let lastAssistant: string | null = null;
  let userIdx = 0;
  let rawTurns = 0;
  // Cloud transcripts don't carry the CLI tool-result wrapper noise
  // (`<bash-stdout>`, `<system-reminder>`, etc.), so wrapper-filtering
  // is a no-op here. Length-cap also a no-op for parity with the
  // existing cloud parser behavior — Claude.ai turns are user-typed
  // text, not pasted dumps.
  for (const m of j.chat_messages ?? []) {
    const text = extractCloudText(m);
    if (text === null) continue;
    if (m.sender === 'human') {
      rawTurns += 1;
      turns.push({
        sessionId,
        userTurnIndex: userIdx,
        userText: text,
        precedingAssistantText: lastAssistant,
      });
      userIdx += 1;
    } else if (m.sender === 'assistant') {
      lastAssistant = text;
    }
  }
  return { turns, rawTurns, wrapperFiltered: 0, tooLongFiltered: 0 };
}

function extractCloudText(m: {
  text?: string;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
}): string | null {
  if (typeof m.text === 'string' && m.text !== '') return m.text;
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const part of m.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

function parseJsonlTurns(sessionId: string, raw: string): SessionScan {
  const turns: TurnPair[] = [];
  let lastAssistant: string | null = null;
  let userIdx = 0;
  let rawTurns = 0;
  let wrapperFiltered = 0;
  let tooLongFiltered = 0;
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
    const type = rec['type'];
    const msg = rec['message'];
    if (msg === null || typeof msg !== 'object') continue;
    const mrec = msg as Record<string, unknown>;
    const role = mrec['role'];
    const text = extractJsonlText(mrec['content']);
    if (text === null) continue;

    if (type === 'user' && role === 'user') {
      rawTurns += 1;
      // CLI transcripts wrap tool results and meta-blocks as 'user' role
      // entries (sidechain noise). Filter wrapper prefixes / >4000-char
      // pastes / empties; count each drop bucket separately so the
      // funnel can show WHY a turn was excluded.
      const trimmed = text.trim();
      if (trimmed === '') {
        wrapperFiltered += 1;
        continue;
      }
      if (WRAPPER_PREFIXES.some((p) => trimmed.startsWith(p))) {
        wrapperFiltered += 1;
        continue;
      }
      if (trimmed.length > MAX_USER_PROMPT_CHARS) {
        tooLongFiltered += 1;
        continue;
      }
      turns.push({
        sessionId,
        userTurnIndex: userIdx,
        userText: text,
        precedingAssistantText: lastAssistant,
      });
      userIdx += 1;
    } else if (type === 'assistant' && role === 'assistant') {
      lastAssistant = text;
    }
  }
  return { turns, rawTurns, wrapperFiltered, tooLongFiltered };
}

function extractJsonlText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as Record<string, unknown>)['type'] === 'text' &&
        typeof (part as Record<string, unknown>)['text'] === 'string'
      ) {
        parts.push((part as Record<string, unknown>)['text'] as string);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

/**
 * Wrapper prefixes that mark a "user-role" JSONL entry as actually a
 * harness-injected block (tool result, system reminder, file upload,
 * continuation banner) rather than the human's typed prompt. Field
 * audit at 802 candidates (4046 turn pairs over 418 sessions) showed
 * the original allow-list let task-notification blocks, uploaded-file
 * wrappers, conversation-continuation banners, and multi-thousand-char
 * document pastes through, where in-document phrases like "instead of"
 * matched and inflated the candidate count without yielding actionable
 * corrections.
 */
const WRAPPER_PREFIXES: readonly string[] = [
  '<command-message>',
  '<command-name>',
  '<command-args>',
  '<system-reminder>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<scheduled-task',
  '<uploaded_files>',
  'Base directory for this skill:',
  '<file>',
  '<file_path>',
  '<file_uuid>',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  '[Request interrupted by user',
];

/**
 * Trimmed-text length ceiling for what counts as a real user prompt.
 * Anything larger is virtually always a paste of code, a skill
 * definition, an issue body, or a file dump — those produce accidental
 * matches the LLM stage would have to spend tokens to reject.
 */
const MAX_USER_PROMPT_CHARS = 4000;
