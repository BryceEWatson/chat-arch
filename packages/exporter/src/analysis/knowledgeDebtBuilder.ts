/**
 * Knowledge-debt builder — Phase 1 Wave 3 (Stream F, task 5).
 *
 * Node-only I/O wrapper around `detectKnowledgeDebt` (kernel) +
 * `renderObsidianMarkdown` (also kernel).
 *
 * Reads each session's first user turn from the transcript, probes
 * Ollama for embeddings (when available — graceful fallback to TF-IDF
 * inside the kernel when embeddings are absent), and emits:
 *
 *   - `analysis/knowledge-debt.json` — structured cluster output
 *   - `analysis/exports/knowledge-debt.md` — Obsidian-targeted markdown
 *
 * Atomic writes on both.
 */

import {
  atomicWriteJsonSync as atomicWriteJson,
  atomicWriteTextSync as atomicWriteText,
} from '../lib/atomicWrite.js';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import {
  detectKnowledgeDebt,
  renderObsidianMarkdown,
  type KnowledgeDebtCluster,
  type KnowledgeDebtEntry,
} from '@chat-arch/analysis';
import { embed, isOllamaAvailable } from '../embeddings/index.js';
import { logger } from '../lib/logger.js';

export interface BuildKnowledgeDebtOptions {
  outDir: string;
  now: number;
  /** I/O concurrency for transcript reads. */
  ioConcurrency?: number;
  /** Override embeddings probe (tests). When false, kernel uses TF-IDF fallback. */
  embeddingsEnabled?: boolean;
  /** Ollama baseUrl override (tests). */
  ollamaBaseUrl?: string;
}

export interface KnowledgeDebtFile {
  version: 1;
  generatedAt: number;
  confidence: 'high' | 'low' | 'mixed' | 'none';
  clusters: readonly KnowledgeDebtCluster[];
}

export interface BuildKnowledgeDebtResult {
  file: KnowledgeDebtFile;
  markdownPath: string;
  scannedSessions: number;
  usedEmbeddings: boolean;
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

// atomicWriteJson / atomicWriteText are now the shared sync helpers
// from ../lib/atomicWrite.js (aliased on import) — consolidated per
// DN3.

interface FirstTurn {
  sessionId: string;
  text: string;
  timestamp: number;
}

/**
 * Read the first user turn from a session. Same parsing strategy as
 * the other builders (cloud chat_messages vs JSONL lines). Returns
 * null on missing/unreadable transcripts — we just drop those sessions
 * from clustering (they can't contribute a question shape anyway).
 */
async function readFirstUserTurn(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<string | null> {
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
    try {
      const j = JSON.parse(raw) as {
        chat_messages?: Array<{ sender?: string; text?: string }>;
      };
      for (const m of j.chat_messages ?? []) {
        if (m.sender === 'human' && typeof m.text === 'string' && m.text !== '') {
          return m.text;
        }
      }
    } catch {
      return null;
    }
    return null;
  }
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
  return null;
}

export async function buildKnowledgeDebtFile(
  manifest: SessionManifest,
  options: BuildKnowledgeDebtOptions,
): Promise<BuildKnowledgeDebtResult> {
  const t0 = Date.now();
  const concurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;

  // 1. Walk transcripts and collect first user turns.
  const reads = await parallelMap(
    manifest.sessions,
    concurrency,
    async (entry): Promise<FirstTurn | null> => {
      const text = await readFirstUserTurn(entry, options.outDir);
      if (text === null) return null;
      return {
        sessionId: entry.id,
        text,
        timestamp: typeof entry.startedAt === 'number' ? entry.startedAt : 0,
      };
    },
  );
  const turns = reads.filter((t): t is FirstTurn => t !== null);

  // 2. Embed (best-effort). Probe Ollama once; if unreachable, skip
  // embeddings entirely (the kernel falls back to TF-IDF on a uniform
  // "no embeddings" input, which keeps the confidence band consistent
  // — partial embeddings would force the kernel to disagree with itself
  // about distance metrics).
  let usedEmbeddings = false;
  let embeddings: ReadonlyArray<Float32Array> | undefined;
  if (options.embeddingsEnabled !== false && turns.length > 0) {
    const probeOpts =
      options.ollamaBaseUrl !== undefined ? { baseUrl: options.ollamaBaseUrl } : {};
    const available = await isOllamaAvailable(
      options.ollamaBaseUrl ?? 'http://127.0.0.1:11434',
    );
    if (available) {
      try {
        embeddings = await embed(
          turns.map((t) => t.text),
          probeOpts,
        );
        usedEmbeddings = true;
      } catch (err) {
        logger.warn(
          `knowledge-debt: ollama embedding failed (${err instanceof Error ? err.message : String(err)}) — falling back to TF-IDF`,
        );
      }
    } else {
      logger.info(
        'knowledge-debt: ollama unreachable; using TF-IDF fallback',
      );
    }
  }

  // 3. Hand to kernel.
  const entries: KnowledgeDebtEntry[] = turns.map((t, i) => {
    if (usedEmbeddings && embeddings !== undefined) {
      return {
        sessionId: t.sessionId,
        firstUserTurn: t.text,
        timestamp: t.timestamp,
        embedding: embeddings[i] as Float32Array,
      };
    }
    return {
      sessionId: t.sessionId,
      firstUserTurn: t.text,
      timestamp: t.timestamp,
    };
  });
  const clusters = detectKnowledgeDebt(entries);

  // 4. Write JSON sidecar.
  const confidence: KnowledgeDebtFile['confidence'] =
    clusters.length === 0
      ? 'none'
      : clusters.every((c) => c.confidence === 'high')
        ? 'high'
        : clusters.every((c) => c.confidence === 'low')
          ? 'low'
          : 'mixed';
  const file: KnowledgeDebtFile = {
    version: 1,
    generatedAt: options.now,
    confidence,
    clusters,
  };
  const target = path.join(options.outDir, 'analysis', 'knowledge-debt.json');
  atomicWriteJson(target, file);

  // 5. Write markdown.
  const mdDir = path.join(options.outDir, 'analysis', 'exports');
  await mkdir(mdDir, { recursive: true });
  const markdown = renderObsidianMarkdown(clusters, { generatedAt: options.now });
  const mdPath = path.join(mdDir, 'knowledge-debt.md');
  atomicWriteText(mdPath, markdown);

  logger.info(
    `knowledge-debt: ${clusters.length} clusters from ${turns.length} first-user-turns ` +
      `(${usedEmbeddings ? 'embeddings' : 'tf-idf'}), ${Date.now() - t0}ms`,
  );

  return {
    file,
    markdownPath: mdPath,
    scannedSessions: turns.length,
    usedEmbeddings,
  };
}
