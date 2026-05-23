/**
 * Composite-outcome builder — Phase 1 Wave 3 (Stream F).
 *
 * Node-only I/O wrapper around the pure `composeOutcome` kernel + the
 * existing `verifySessions` verifier (already exposed by @chat-arch/analysis).
 * Reads each session's transcript, projects it to the audit-claim +
 * timeline-event pair, runs the verifier, and composes one
 * `CompositeOutcome` per session.
 *
 * Output sidecar: `analysis/composite-outcomes.json`, conforming to
 * `CompositeOutcomesFile` in `@chat-arch/schema`. Embeds `weightsHash`
 * at the file root and on every row (the kernel returns it per-row;
 * we propagate the root-level copy from the canonical weights).
 *
 * Atomic write: tmp → fsync → renameSync (POSIX rename is atomic on a
 * single filesystem, the only environment we target).
 *
 * Cache invalidation is gated on the tuple `(AUDIT_CONFIG_VERSION,
 * COMPOSITE_VERSION, WEIGHTS_VERSION)`. Any change to one invalidates
 * the whole file — composite rows depend on every layer below.
 */

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AuditClaim,
  AuditResult,
  CompositeOutcome,
  CompositeOutcomesFile,
  CompositeWeights,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  AUDIT_CONFIG_VERSION,
  composeOutcome,
  extractClaims,
  THRESHOLDS,
  verifySessions,
  weightsHashFnv,
  type AssistantMessage,
  type TimelineEvent,
  type VerifySessionInput,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';

/**
 * Schema-shape version. Phase 2 #13 bumps 1 → 2 when `secondary` ships
 * on `CompositeOutcome`. Cache key.
 */
export const COMPOSITE_VERSION = 1 as const;

/**
 * Weights-set version. Bump when the calibration refit lands new
 * numbers in `THRESHOLDS.composite.weights`. Cache key — composite
 * rows are invalidated wholesale when weights change because the
 * sigmoid score is non-linear in the weights.
 */
export const WEIGHTS_VERSION = 1;

export interface BuildComposeOutcomesOptions {
  outDir: string;
  now: number;
  /** Parallelism for transcript reads. */
  ioConcurrency?: number;
  /** Override weights for the run (sensitivity / refit tooling). */
  weights?: CompositeWeights;
}

export interface BuildComposeOutcomesResult {
  file: CompositeOutcomesFile;
  scannedSessions: number;
  reusedSessions: number;
  missingTranscripts: number;
}

const DEFAULT_IO_CONCURRENCY = 8;

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
  bySession: Map<string, CompositeOutcome>;
}

/**
 * Cache-load is gated on the version tuple. A mismatch on any of
 * (AUDIT_CONFIG_VERSION, COMPOSITE_VERSION, WEIGHTS_VERSION) invalidates
 * the entire prior file — derived rows are not reusable across versions.
 */
async function loadPriorCache(
  outDir: string,
  auditConfigVersion: number,
  compositeVersion: number,
  weightsVersion: number,
  weightsHash: string,
): Promise<PriorCache | null> {
  const priorPath = path.join(outDir, 'analysis', 'composite-outcomes.json');
  let raw: string;
  try {
    raw = await readFile(priorPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: CompositeOutcomesFile & {
    auditConfigVersion?: number;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.generatedAt !== 'number') return null;
  if (parsed.compositeVersion !== compositeVersion) {
    logger.info(
      `analysis: composite-outcomes cache invalidated (compositeVersion ${parsed.compositeVersion} vs ${compositeVersion})`,
    );
    return null;
  }
  if (parsed.weightsVersion !== weightsVersion) {
    logger.info(
      `analysis: composite-outcomes cache invalidated (weightsVersion ${parsed.weightsVersion} vs ${weightsVersion})`,
    );
    return null;
  }
  if (parsed.weightsHash !== weightsHash) {
    logger.info(
      `analysis: composite-outcomes cache invalidated (weightsHash mismatch)`,
    );
    return null;
  }
  if (
    parsed.auditConfigVersion !== undefined &&
    parsed.auditConfigVersion !== auditConfigVersion
  ) {
    logger.info(
      `analysis: composite-outcomes cache invalidated (auditConfigVersion ${parsed.auditConfigVersion} vs ${auditConfigVersion})`,
    );
    return null;
  }
  const bySession = new Map<string, CompositeOutcome>();
  for (const row of parsed.outcomes ?? []) {
    if (typeof row.sessionId !== 'string') continue;
    // Belt + suspenders: also reject rows whose per-row weightsHash
    // doesn't match the file root — partial-write detector per the
    // kernel docstring. A mismatched row is silently dropped (re-derived).
    if (row.weightsHash !== weightsHash) continue;
    bySession.set(row.sessionId, row);
  }
  return { generatedAt: parsed.generatedAt, bySession };
}

/**
 * Atomic file write: tmp → fsync → renameSync. `writeFileSync` plus
 * `fsyncSync` guarantees the bytes are durable before the rename, so a
 * crash mid-write never leaves the canonical filename pointing at a
 * partially-written file.
 */
function atomicWriteJson(target: string, value: unknown): void {
  // Stamped tmp name to avoid concurrent-writer rename races. (S3)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const json = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(tmp, json, 'utf8');
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

export async function buildCompositeOutcomesFile(
  manifest: SessionManifest,
  options: BuildComposeOutcomesOptions,
): Promise<BuildComposeOutcomesResult> {
  const t0 = Date.now();
  const concurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  const weights = (options.weights ?? THRESHOLDS.composite.weights) as CompositeWeights;
  const weightsHash = weightsHashFnv(weights);

  const prior = await loadPriorCache(
    options.outDir,
    AUDIT_CONFIG_VERSION,
    COMPOSITE_VERSION,
    WEIGHTS_VERSION,
    weightsHash,
  );

  type PerSession =
    | { kind: 'reused'; outcome: CompositeOutcome }
    | { kind: 'scanned'; outcome: CompositeOutcome }
    | { kind: 'missing' };

  const results = await parallelMap<UnifiedSessionEntry, PerSession>(
    manifest.sessions,
    concurrency,
    async (entry): Promise<PerSession> => {
      if (prior !== null) {
        const cached = prior.bySession.get(entry.id);
        const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : Infinity;
        if (cached !== undefined && updatedAt <= prior.generatedAt) {
          return { kind: 'reused', outcome: cached };
        }
      }
      const parsed = await readTranscript(entry, options.outDir);
      if (parsed === null) return { kind: 'missing' };
      const { messages, timeline } = parsed;
      const { claims } = extractClaims(entry.id, entry.source, messages);
      const input: VerifySessionInput = { sessionId: entry.id, timeline, claims };
      const { results: verified } = verifySessions([input], options.now);
      // composeOutcome expects all results to share sessionId + source.
      // The grouping above guarantees this.
      const outcome = composeOutcome(
        entry.id,
        entry.source,
        verified as readonly AuditResult[],
        null,
        { weights },
      );
      return { kind: 'scanned', outcome };
    },
  );

  const outcomes: CompositeOutcome[] = [];
  const scannedSessionIds: string[] = [];
  let scanned = 0;
  let reused = 0;
  let missing = 0;
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i] as PerSession;
    const entry = manifest.sessions[i] as UnifiedSessionEntry;
    if (r.kind === 'missing') {
      missing += 1;
      continue;
    }
    outcomes.push(r.outcome);
    scannedSessionIds.push(entry.id);
    if (r.kind === 'reused') reused += 1;
    else scanned += 1;
  }

  const file: CompositeOutcomesFile & { auditConfigVersion: number } = {
    compositeVersion: COMPOSITE_VERSION,
    weightsVersion: WEIGHTS_VERSION,
    weights,
    weightsHash,
    auditConfigVersion: AUDIT_CONFIG_VERSION,
    generatedAt: options.now,
    outcomes,
    scannedSessionIds,
  };

  const target = path.join(options.outDir, 'analysis', 'composite-outcomes.json');
  atomicWriteJson(target, file);

  logger.info(
    `analysis: composite-outcomes.json — ${outcomes.length} outcomes ` +
      `(${scanned} scanned, ${reused} reused, ${missing} missing), ${Date.now() - t0}ms`,
  );

  return {
    file,
    scannedSessions: scanned,
    reusedSessions: reused,
    missingTranscripts: missing,
  };
}

interface ParsedTranscript {
  messages: AssistantMessage[];
  timeline: TimelineEvent[];
}

async function readTranscript(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<ParsedTranscript | null> {
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

  if (entry.source === 'cloud') return parseCloud(raw);
  return parseJsonl(raw);
}

interface CloudShape {
  chat_messages?: Array<{
    sender?: string;
    text?: string;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  }>;
}

function parseCloud(raw: string): ParsedTranscript {
  const messages: AssistantMessage[] = [];
  const timeline: TimelineEvent[] = [];
  let j: CloudShape;
  try {
    j = JSON.parse(raw) as CloudShape;
  } catch {
    return { messages, timeline };
  }
  let lineNumber = 1;
  for (const m of j.chat_messages ?? []) {
    const text = extractCloudText(m);
    if (text !== null && text !== '') {
      if (m.sender === 'assistant') {
        messages.push({ lineNumber, text });
        timeline.push({ kind: 'assistant', lineNumber, text });
      } else if (m.sender === 'human') {
        timeline.push({ kind: 'user', lineNumber, text });
      }
    }
    lineNumber += 1;
  }
  return { messages, timeline };
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

function parseJsonl(raw: string): ParsedTranscript {
  const messages: AssistantMessage[] = [];
  const timeline: TimelineEvent[] = [];
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
    const msg = rec['message'];
    if (msg === null || typeof msg !== 'object') continue;
    const mrec = msg as Record<string, unknown>;
    const content = mrec['content'];
    const lineNumber = i + 1;

    if (type === 'user') {
      if (typeof content === 'string' && content !== '') {
        timeline.push({ kind: 'user', lineNumber, text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part !== null && typeof part === 'object') {
            const p = part as Record<string, unknown>;
            if (p['type'] === 'text' && typeof p['text'] === 'string') {
              timeline.push({ kind: 'user', lineNumber, text: p['text'] });
            } else if (p['type'] === 'tool_result') {
              const c = p['content'];
              const text =
                typeof c === 'string'
                  ? c
                  : Array.isArray(c)
                    ? c
                        .map((x) =>
                          x !== null &&
                          typeof x === 'object' &&
                          typeof (x as Record<string, unknown>)['text'] === 'string'
                            ? ((x as Record<string, unknown>)['text'] as string)
                            : '',
                        )
                        .join('\n')
                    : '';
              timeline.push({
                kind: 'tool_result',
                lineNumber,
                text: String(text),
                isError: p['is_error'] === true,
              });
            }
          }
        }
      }
    } else if (type === 'assistant') {
      if (typeof content === 'string' && content !== '') {
        messages.push({ lineNumber, text: content });
        timeline.push({ kind: 'assistant', lineNumber, text: content });
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
              timeline.push({ kind: 'tool_use', lineNumber, name, input });
            }
          }
        }
        if (textParts.length > 0) {
          const joined = textParts.join('\n');
          messages.push({ lineNumber, text: joined });
          timeline.push({ kind: 'assistant', lineNumber, text: joined });
        }
      }
    }
  }
  return { messages, timeline };
}
