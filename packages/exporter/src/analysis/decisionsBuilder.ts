/**
 * Phase 2 #1 — decisions builder (heuristic-recall stage only).
 *
 * Mirrors `corrections.ts` shape: parses each session's transcript,
 * feeds (user, assistant) turn pairs into {@link detectDecisions},
 * collects DecisionCandidate[] per session, joins to the composite
 * outcome via sessionId, and writes `analysis/decisions.json`
 * atomically. Cache keyed on `DECISION_HEURISTIC_VERSION`.
 *
 * **No LLM stage in this PR.** Every record is emitted with
 * `classification: null`. The Phase 2 LLM-classification follow-up
 * fills in `classification` (normalized kind, distilled statement,
 * chosen/rejected, actionable flag).
 *   TODO(Phase 2 #1 follow-up): wire LLM classification stage that
 *   consumes `analysis/decisions.json` (this builder's output) and
 *   overwrites with classification + clustered patterns. Skill name
 *   TBD; should mirror /mine-corrections shape.
 *
 * Node-only — reads transcript files. Pure detection kernel lives
 * in `@chat-arch/analysis`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CompositeOutcome,
  CompositeOutcomesFile,
  Decision,
  DecisionCandidate,
  DecisionOutcomeRef,
  DecisionsFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  DECISION_HEURISTIC_VERSION,
  detectDecisions,
  type DecisionTurnPair,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';
import { atomicWriteJson } from '../lib/atomicWrite.js';

export interface BuildDecisionsOptions {
  outDir: string;
  now: number;
  /** Parallelism for transcript reads. Defaults to 8 (NVMe sweet spot). */
  ioConcurrency?: number;
}

export interface BuildDecisionsResult {
  file: DecisionsFile;
  scannedSessions: number;
  reusedSessions: number;
  missingTranscripts: number;
  totalCandidates: number;
}

const DEFAULT_IO_CONCURRENCY = 8;

/** Same wrapper/length filters as the corrections parser — keep in sync. */
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
const MAX_USER_PROMPT_CHARS = 4000;

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
  /** sessionId → Decision[] (cached). Empty array = scanned, found nothing. */
  bySession: Map<string, Decision[]>;
}

/**
 * Load the prior decisions.json. Version-mismatch invalidates the
 * entire cache. Returns null on first run, on version mismatch, and
 * on parse failure.
 */
async function loadPriorCache(
  outDir: string,
  currentVersion: number,
): Promise<PriorCache | null> {
  const p = path.join(outDir, 'analysis', 'decisions.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  let parsed: DecisionsFile;
  try {
    parsed = JSON.parse(raw) as DecisionsFile;
  } catch {
    return null;
  }
  if (typeof parsed.generatedAt !== 'number') return null;
  if (parsed.decisionHeuristicVersion !== currentVersion) {
    logger.info(
      `analysis: decisions cache invalidated (file v${parsed.decisionHeuristicVersion ?? '?'} vs current v${currentVersion}) — full rescan`,
    );
    return null;
  }
  const bySession = new Map<string, Decision[]>();
  for (const sid of parsed.scannedSessionIds ?? []) {
    if (typeof sid === 'string') bySession.set(sid, []);
  }
  for (const d of parsed.decisions ?? []) {
    const sid = d.candidate?.sessionId;
    if (typeof sid !== 'string') continue;
    const list = bySession.get(sid);
    if (list) list.push(d);
    else bySession.set(sid, [d]);
  }
  return { generatedAt: parsed.generatedAt, bySession };
}

/**
 * Read `analysis/composite-outcomes.json` if present and return a
 * sessionId → CompositeOutcome map. Returns null when the file is
 * absent or malformed — the builder still emits decisions, just with
 * `outcomeRef: null` (the join is best-effort).
 */
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

function compositeToOutcomeRef(o: CompositeOutcome): DecisionOutcomeRef {
  const binary: 'good' | 'bad' | 'neutral' =
    o.binary === 'good' ? 'good' : o.binary === 'bad' ? 'bad' : 'neutral';
  return {
    sessionId: o.sessionId,
    compositeScore: o.score,
    binaryClass: binary,
  };
}

export async function buildDecisionsFile(
  manifest: SessionManifest,
  options: BuildDecisionsOptions,
): Promise<BuildDecisionsResult> {
  const t0 = Date.now();
  const concurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  const prior = await loadPriorCache(options.outDir, DECISION_HEURISTIC_VERSION);
  const outcomesById = await loadCompositeOutcomes(options.outDir);

  type PerSession =
    | { kind: 'reused'; decisions: readonly Decision[] }
    | { kind: 'scanned'; candidates: readonly DecisionCandidate[] }
    | { kind: 'missing' };

  const results = await parallelMap<UnifiedSessionEntry, PerSession>(
    manifest.sessions,
    concurrency,
    async (entry) => {
      if (prior !== null) {
        const cached = prior.bySession.get(entry.id);
        const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : Infinity;
        if (cached !== undefined && updatedAt <= prior.generatedAt) {
          return { kind: 'reused', decisions: cached };
        }
      }
      const turns = await readTurnPairs(entry, options.outDir);
      if (turns === null) return { kind: 'missing' };
      const candidates = detectDecisions(turns);
      return { kind: 'scanned', candidates };
    },
  );

  const allDecisions: Decision[] = [];
  const scannedSessionIds: string[] = [];
  let scanned = 0;
  let reused = 0;
  let missing = 0;

  for (let i = 0; i < results.length; i += 1) {
    const entry = manifest.sessions[i] as UnifiedSessionEntry;
    const r = results[i] as PerSession;
    if (r.kind === 'missing') {
      missing += 1;
      continue;
    }
    scannedSessionIds.push(entry.id);
    if (r.kind === 'reused') {
      reused += 1;
      // Cached decisions already carry their outcomeRef from the
      // prior run. If the composite-outcomes file has since changed
      // (e.g. weightsHash bumped), re-attach so the denormalized
      // values stay current.
      for (const d of r.decisions) {
        const outcome = outcomesById?.get(d.candidate.sessionId);
        allDecisions.push({
          candidate: d.candidate,
          classification: d.classification,
          outcomeRef: outcome !== undefined ? compositeToOutcomeRef(outcome) : null,
        });
      }
    } else {
      scanned += 1;
      const outcome = outcomesById?.get(entry.id);
      const outcomeRef = outcome !== undefined ? compositeToOutcomeRef(outcome) : null;
      for (const c of r.candidates) {
        allDecisions.push({
          candidate: c,
          classification: null,
          outcomeRef,
        });
      }
    }
  }

  const file: DecisionsFile = {
    generatedAt: options.now,
    decisionHeuristicVersion: DECISION_HEURISTIC_VERSION,
    decisions: allDecisions,
    scannedSessionIds,
  };

  const outPath = path.join(options.outDir, 'analysis', 'decisions.json');
  await atomicWriteJson(outPath, JSON.stringify(file, null, 2) + '\n');

  logger.info(
    `analysis: decisions.json — ${allDecisions.length} candidates from ${scanned} scanned, ${reused} reused, ${missing} missing, ${Date.now() - t0}ms`,
  );

  return {
    file,
    scannedSessions: scanned,
    reusedSessions: reused,
    missingTranscripts: missing,
    totalCandidates: allDecisions.length,
  };
}

async function readTurnPairs(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<DecisionTurnPair[] | null> {
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
  if (entry.source === 'cloud') return parseCloudTurns(entry.id, raw);
  return parseJsonlTurns(entry.id, raw);
}

interface CloudShape {
  chat_messages?: Array<{
    sender?: string;
    text?: string;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  }>;
}

function parseCloudTurns(sessionId: string, raw: string): DecisionTurnPair[] {
  let j: CloudShape;
  try {
    j = JSON.parse(raw) as CloudShape;
  } catch {
    return [];
  }
  const turns: DecisionTurnPair[] = [];
  let lastAssistant: string | null = null;
  let userIdx = 0;
  for (const m of j.chat_messages ?? []) {
    const text = extractCloudText(m);
    if (text === null) continue;
    if (m.sender === 'human') {
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
  return turns;
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

function parseJsonlTurns(sessionId: string, raw: string): DecisionTurnPair[] {
  const turns: DecisionTurnPair[] = [];
  let lastAssistant: string | null = null;
  let userIdx = 0;
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
      const trimmed = text.trim();
      if (trimmed === '') continue;
      if (WRAPPER_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
      if (trimmed.length > MAX_USER_PROMPT_CHARS) continue;
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
  return turns;
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
