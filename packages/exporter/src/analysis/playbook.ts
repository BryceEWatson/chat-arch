/**
 * Stage-1 playbook builder — heuristic recall + (optional) audit join.
 *
 * Mirrors the corrections builder: parses each session's transcript,
 * feeds user turns into the {@link detectPlaybookCandidates} kernel,
 * groups hits by pattern key, and — when an `audit-results.json`
 * sidecar exists — joins each hit against the next-N downstream
 * audit claims in the same session to compute a per-pattern
 * downstream pass-rate.
 *
 * Node-only (reads files). Pure-function kernel lives in @chat-arch/analysis.
 *
 * The audit dependency is intentionally LATE-BOUND with a minimal local
 * shape rather than importing `AuditResult` from @chat-arch/schema. That
 * file doesn't exist on `main` yet — it ships with the audit pipeline
 * (PR #50). When that lands, the local interface here will match the
 * canonical schema; the join surface stays stable either way.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  PlaybookCandidatesFile,
  PlaybookHit,
  PlaybookPattern,
  PlaybookPatternAudit,
  ScanStats,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  PLAYBOOK_HEURISTIC_VERSION,
  PLAYBOOK_PATTERN_META,
  detectPlaybookCandidates,
  type PlaybookTurnInput,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';

export interface BuildPlaybookOptions {
  outDir: string;
  now: number;
  ioConcurrency?: number;
  /**
   * Window length: per phrasing hit, the audit join inspects the next
   * N claims in the same session whose lineNumber > hit.lineNumber.
   * Spec: "N events following the phrasing". 5 covers the typical
   * working-window without picking up unrelated end-of-session work.
   */
  downstreamWindow?: number;
}

export interface BuildPlaybookResult {
  file: PlaybookCandidatesFile;
  scannedSessions: number;
  missingTranscripts: number;
  totalHits: number;
  hasAuditSignal: boolean;
}

const DEFAULT_IO_CONCURRENCY = 8;
const DEFAULT_DOWNSTREAM_WINDOW = 5;

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

interface SessionParse {
  turns: PlaybookTurnInput[];
  rawTurns: number;
  wrapperFiltered: number;
  tooLongFiltered: number;
}

interface MinimalAuditResult {
  sessionId: string;
  lineNumber: number;
  outcome: 'pass' | 'fail' | 'inconclusive';
}

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

/**
 * Read audit-results.json if present and return a per-session sorted
 * array of (lineNumber, outcome). Returns null if the sidecar is
 * missing, malformed, or has no results — caller falls back to
 * occurrence-only ranking.
 */
async function loadAuditByLine(
  outDir: string,
): Promise<Map<string, MinimalAuditResult[]> | null> {
  const p = path.join(outDir, 'analysis', 'audit-results.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  let parsed: { results?: ReadonlyArray<Record<string, unknown>> };
  try {
    parsed = JSON.parse(raw) as { results?: ReadonlyArray<Record<string, unknown>> };
  } catch {
    return null;
  }
  const results = parsed.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const bySession = new Map<string, MinimalAuditResult[]>();
  for (const r of results) {
    const sid = r['sessionId'];
    const ln = r['lineNumber'];
    const outcome = r['outcome'];
    if (
      typeof sid !== 'string' ||
      typeof ln !== 'number' ||
      (outcome !== 'pass' && outcome !== 'fail' && outcome !== 'inconclusive')
    ) {
      continue;
    }
    const slot = bySession.get(sid) ?? [];
    slot.push({ sessionId: sid, lineNumber: ln, outcome });
    bySession.set(sid, slot);
  }
  // Sort each session's audit results by lineNumber so the downstream
  // window join is a linear scan rather than O(n²).
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.lineNumber - b.lineNumber);
  }
  return bySession;
}

export async function buildPlaybookCandidatesFile(
  manifest: SessionManifest,
  options: BuildPlaybookOptions,
): Promise<BuildPlaybookResult> {
  const t0 = Date.now();
  const concurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  const window = options.downstreamWindow ?? DEFAULT_DOWNSTREAM_WINDOW;

  const auditByLine = await loadAuditByLine(options.outDir);
  const hasAuditSignal = auditByLine !== null;

  const parseResults = await parallelMap<UnifiedSessionEntry, SessionParse | null>(
    manifest.sessions,
    concurrency,
    async (entry) => parseTranscript(entry, options.outDir),
  );

  const sessionsBySource: Record<string, number> = {};
  const sessionsMissingBySource: Record<string, number> = {};
  let scanned = 0;
  let missing = 0;
  let aggRaw = 0;
  let aggWrapper = 0;
  let aggTooLong = 0;
  let aggSurviving = 0;

  // Collect every hit across the whole manifest, grouped by pattern key.
  const hitsByKey = new Map<string, PlaybookHit[]>();
  // Track distinct sessions per pattern.
  const sessionsByKey = new Map<string, Set<string>>();
  let totalHits = 0;

  for (let i = 0; i < parseResults.length; i += 1) {
    const entry = manifest.sessions[i] as UnifiedSessionEntry;
    const src = entry.source ?? 'unknown';
    sessionsBySource[src] = (sessionsBySource[src] ?? 0) + 1;
    const parsed = parseResults[i] ?? null;
    if (parsed === null) {
      missing += 1;
      sessionsMissingBySource[src] = (sessionsMissingBySource[src] ?? 0) + 1;
      continue;
    }
    scanned += 1;
    aggRaw += parsed.rawTurns;
    aggWrapper += parsed.wrapperFiltered;
    aggTooLong += parsed.tooLongFiltered;
    aggSurviving += parsed.turns.length;

    const kernelHits = detectPlaybookCandidates(parsed.turns);
    for (const k of kernelHits) {
      const hit: PlaybookHit = {
        sessionId: k.sessionId,
        userTurnIndex: k.userTurnIndex,
        lineNumber: k.lineNumber,
        phrase: k.phrase,
        excerpt: k.excerpt,
      };
      const list = hitsByKey.get(k.patternKey) ?? [];
      list.push(hit);
      hitsByKey.set(k.patternKey, list);
      const ss = sessionsByKey.get(k.patternKey) ?? new Set<string>();
      ss.add(k.sessionId);
      sessionsByKey.set(k.patternKey, ss);
      totalHits += 1;
    }
  }

  // Compute per-pattern audit rollup (best-effort; zeros when no signal).
  const patterns: PlaybookPattern[] = [];
  for (const [key, hits] of hitsByKey) {
    const meta = PLAYBOOK_PATTERN_META.get(key);
    const label = meta?.label ?? key;
    const description = meta?.description ?? '';
    const sessionIds = [...(sessionsByKey.get(key) ?? new Set<string>())];

    const audit = computeAudit(hits, auditByLine, window);
    const occurrence = hits.length;
    const score = hasAuditSignal && audit.passRate > 0
      ? occurrence * audit.passRate
      : occurrence;

    patterns.push({
      patternKey: key,
      label,
      description,
      // Sort hits by session, then turn — stable ordering on disk for diffs.
      hits: [...hits].sort(
        (a, b) =>
          a.sessionId.localeCompare(b.sessionId) ||
          a.userTurnIndex - b.userTurnIndex,
      ),
      occurrenceCount: occurrence,
      sessionIds: [...sessionIds].sort(),
      audit,
      score,
    });
  }
  patterns.sort((a, b) => b.score - a.score);

  const scanStats: ScanStats = {
    sessionsInManifest: manifest.sessions.length,
    sessionsScanned: scanned,
    sessionsMissing: missing,
    sessionsBySource,
    sessionsMissingBySource,
    rawUserTurns: aggRaw,
    wrapperFiltered: aggWrapper,
    tooLongFiltered: aggTooLong,
    survivingTurns: aggSurviving,
  };

  const file: PlaybookCandidatesFile = {
    version: 1,
    generatedAt: options.now,
    heuristicVersion: PLAYBOOK_HEURISTIC_VERSION,
    hasAuditSignal,
    patterns,
    scanStats,
  };

  logger.info(
    `analysis: playbook-candidates.json — ${patterns.length} patterns, ${totalHits} hits, audit=${hasAuditSignal ? 'yes' : 'no'}, ${Date.now() - t0}ms`,
  );

  return {
    file,
    scannedSessions: scanned,
    missingTranscripts: missing,
    totalHits,
    hasAuditSignal,
  };
}

/**
 * For each hit, find the next `window` audit claims in the same session
 * whose lineNumber > hit.lineNumber. Tally outcomes. The session-level
 * list is pre-sorted by lineNumber, so the scan is linear in matches.
 */
function computeAudit(
  hits: ReadonlyArray<PlaybookHit>,
  auditByLine: Map<string, MinimalAuditResult[]> | null,
  window: number,
): PlaybookPatternAudit {
  if (auditByLine === null) {
    return { pass: 0, fail: 0, inconclusive: 0, passRate: 0, hitsWithSignal: 0 };
  }
  let pass = 0;
  let fail = 0;
  let inconclusive = 0;
  let hitsWithSignal = 0;
  for (const h of hits) {
    const arr = auditByLine.get(h.sessionId);
    if (arr === undefined || arr.length === 0) continue;
    // Binary search for first lineNumber > hit.lineNumber.
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((arr[mid] as MinimalAuditResult).lineNumber > h.lineNumber) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    if (lo >= arr.length) continue;
    let contributed = false;
    for (let i = lo; i < arr.length && i < lo + window; i += 1) {
      const r = arr[i] as MinimalAuditResult;
      if (r.outcome === 'pass') pass += 1;
      else if (r.outcome === 'fail') fail += 1;
      else inconclusive += 1;
      contributed = true;
    }
    if (contributed) hitsWithSignal += 1;
  }
  const total = pass + fail + inconclusive;
  return {
    pass,
    fail,
    inconclusive,
    passRate: total === 0 ? 0 : pass / total,
    hitsWithSignal,
  };
}

/**
 * Parse one session's transcript into PlaybookTurnInput[]. Returns null
 * when the transcript is unreadable or absent.
 *
 * `lineNumber` semantics:
 *   - JSONL transcripts (cli-direct, cli-desktop, cowork): 1-based
 *     index into the line-split file. Matches audit-results.json's
 *     convention.
 *   - Cloud JSON transcripts: 1-based ordinal within `chat_messages[]`.
 *     Cloud doesn't have transcript line numbers in the audit sense;
 *     this approximation collides with how the audit pipeline keys
 *     cloud claims. If the audit join produces zeros for cloud
 *     sessions, that's the mismatch — fixable in a follow-up once
 *     audit-results lands on main.
 */
async function parseTranscript(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<SessionParse | null> {
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
  if (entry.source === 'cloud') return parseCloud(entry.id, raw);
  return parseJsonl(entry.id, raw);
}

interface CloudShape {
  chat_messages?: Array<{
    sender?: string;
    text?: string;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  }>;
}

function parseCloud(sessionId: string, raw: string): SessionParse {
  let j: CloudShape;
  try {
    j = JSON.parse(raw) as CloudShape;
  } catch {
    return { turns: [], rawTurns: 0, wrapperFiltered: 0, tooLongFiltered: 0 };
  }
  const turns: PlaybookTurnInput[] = [];
  let userIdx = 0;
  let rawTurns = 0;
  let tooLongFiltered = 0;
  const msgs = j.chat_messages ?? [];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (m === undefined) continue;
    const text = extractCloudText(m);
    if (text === null) continue;
    if (m.sender !== 'human') continue;
    rawTurns += 1;
    if (text.length > MAX_USER_PROMPT_CHARS) {
      tooLongFiltered += 1;
      continue;
    }
    turns.push({
      sessionId,
      userTurnIndex: userIdx,
      lineNumber: i + 1,
      userText: text,
    });
    userIdx += 1;
  }
  return { turns, rawTurns, wrapperFiltered: 0, tooLongFiltered };
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

function parseJsonl(sessionId: string, raw: string): SessionParse {
  const turns: PlaybookTurnInput[] = [];
  let userIdx = 0;
  let rawTurns = 0;
  let wrapperFiltered = 0;
  let tooLongFiltered = 0;
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
    if (rec['type'] !== 'user') continue;
    const msg = rec['message'];
    if (msg === null || typeof msg !== 'object') continue;
    const mrec = msg as Record<string, unknown>;
    if (mrec['role'] !== 'user') continue;
    const text = extractJsonlText(mrec['content']);
    if (text === null) continue;

    rawTurns += 1;
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
      lineNumber: i + 1,
      userText: text,
    });
    userIdx += 1;
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
