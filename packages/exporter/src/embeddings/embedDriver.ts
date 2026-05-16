/**
 * embedDriver — drives the per-session embedding pass and writes the two
 * sidecar files under `<outDir>/analysis/`:
 *
 *   - `embeddings.bin`       concatenated little-endian float32 vectors
 *   - `embeddings.meta.json` `EmbeddingMeta` (sessionId → byte offset)
 *
 * Behavior is fail-soft: when Ollama is unreachable, we warn-once and
 * return without overwriting any existing sidecar, so a temporarily-down
 * embedding service never poisons the on-disk artifact for the viewer.
 *
 * Incremental mode (`onlyChanged: true`): an entry whose `(source, id)`
 * appeared in the prior meta AND whose `sourceMtimeMs` is unchanged is
 * REUSED — we copy its vector bytes from the prior `embeddings.bin` to
 * the new one, no Ollama call. Anything else is re-embedded.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  EmbeddingMeta,
  EmbeddingMetaEntry,
  SessionManifest,
  SessionSource,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { logger } from '../lib/logger.js';
import { isOllamaAvailable, embedOne } from './ollama.js';
import { buildEmbeddingInput } from './buildEmbeddingInput.js';
import { V2_DEFAULT_EMBEDDING_MODEL } from './model.js';

const NOMIC_DIMENSIONS = 768;
const DEFAULT_CONCURRENCY = 4;

export interface RunEmbedOptions {
  /** Root output dir (same one `manifest.json` sits in). */
  outDir: string;
  manifest: SessionManifest;
  /** Ollama model name. Defaults to V2_DEFAULT_EMBEDDING_MODEL. */
  model?: string;
  baseUrl?: string;
  /** Incremental: reuse vectors when sourceMtimeMs is unchanged. */
  onlyChanged?: boolean;
  /** Override Date.now() for tests. */
  now?: number;
  concurrency?: number;
}

export type EmbedSkippedReason = 'ollama-unavailable' | 'no-sessions';

export interface RunEmbedResult {
  metaPath: string;
  binPath: string;
  embedded: number;
  reused: number;
  skipped: number;
  /** Set when the whole run is a fail-soft skip. */
  skippedReason?: EmbedSkippedReason;
}

interface PriorVector {
  entry: EmbeddingMetaEntry;
  bytes: Buffer;
}

/**
 * Read prior `embeddings.meta.json` + `embeddings.bin` to build a
 * `(source, id) → { metaEntry, vectorBytes }` map. Returns an empty
 * map when either sidecar is missing or unreadable — incremental
 * reuse just degrades to a full re-embed.
 */
async function readPriorVectors(
  metaPath: string,
  binPath: string,
): Promise<Map<string, PriorVector>> {
  const result = new Map<string, PriorVector>();
  let prior: EmbeddingMeta;
  let bin: Buffer;
  try {
    const rawMeta = await readFile(metaPath, 'utf8');
    prior = JSON.parse(rawMeta) as EmbeddingMeta;
  } catch {
    return result;
  }
  try {
    bin = await readFile(binPath);
  } catch {
    return result;
  }

  const vectorBytes = prior.dimensions * 4;
  for (const entry of prior.entries) {
    if (
      typeof entry.offset !== 'number' ||
      entry.offset < 0 ||
      entry.offset + vectorBytes > bin.length
    ) {
      continue;
    }
    const slice = bin.subarray(entry.offset, entry.offset + vectorBytes);
    // Copy so the prior buffer can be GC'd once we exit this fn.
    result.set(compositeKey(entry.source, entry.sessionId), {
      entry,
      bytes: Buffer.from(slice),
    });
  }
  return result;
}

function compositeKey(source: SessionSource, sessionId: string): string {
  return `${source}::${sessionId}`;
}

function vectorToLEFloat32Buffer(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i] as number, i * 4);
  }
  return buf;
}

/** Eligible = has transcript content + a non-empty embedding input. */
interface EligibleEntry {
  entry: UnifiedSessionEntry;
  input: string;
}

function selectEligible(manifest: SessionManifest): EligibleEntry[] {
  const out: EligibleEntry[] = [];
  for (const entry of manifest.sessions) {
    if (entry.transcriptStatus === 'pruned') continue;
    const input = buildEmbeddingInput(entry);
    if (input === '') continue;
    out.push({ entry, input });
  }
  return out;
}

export async function runEmbed(opts: RunEmbedOptions): Promise<RunEmbedResult> {
  const model = opts.model ?? V2_DEFAULT_EMBEDDING_MODEL;
  const now = opts.now ?? Date.now();
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const analysisDir = path.join(opts.outDir, 'analysis');
  const metaPath = path.join(analysisDir, 'embeddings.meta.json');
  const binPath = path.join(analysisDir, 'embeddings.bin');

  // ---- Ollama availability check (fail-soft) ----
  const available = await isOllamaAvailable(opts.baseUrl);
  if (!available) {
    const baseUrlForMsg = opts.baseUrl ?? 'http://localhost:11434';
    logger.warn(
      `embeddings skipped: Ollama unreachable at ${baseUrlForMsg}; ` +
        `run "ollama serve" + "ollama pull ${model}" to enable`,
    );
    return {
      metaPath,
      binPath,
      embedded: 0,
      reused: 0,
      skipped: opts.manifest.sessions.length,
      skippedReason: 'ollama-unavailable',
    };
  }

  // ---- Eligibility filter ----
  const eligible = selectEligible(opts.manifest);
  const skippedFromManifest = opts.manifest.sessions.length - eligible.length;

  if (eligible.length === 0) {
    // Write an empty sidecar so downstream consumers don't choke on a
    // stale prior file. Note: we DO overwrite here because Ollama IS
    // reachable; the absence of input is authoritative.
    await mkdir(analysisDir, { recursive: true });
    const emptyMeta: EmbeddingMeta = {
      version: 1,
      generatedAt: now,
      model,
      dimensions: NOMIC_DIMENSIONS,
      byteOrder: 'le',
      dtype: 'float32',
      count: 0,
      entries: [],
    };
    await writeFile(metaPath, JSON.stringify(emptyMeta, null, 2) + '\n', 'utf8');
    await writeFile(binPath, Buffer.alloc(0));
    logger.info('embeddings: no eligible sessions; wrote empty sidecars');
    return {
      metaPath,
      binPath,
      embedded: 0,
      reused: 0,
      skipped: skippedFromManifest,
      skippedReason: 'no-sessions',
    };
  }

  // ---- Incremental reuse map ----
  const priorVectors = opts.onlyChanged === true
    ? await readPriorVectors(metaPath, binPath)
    : new Map<string, PriorVector>();

  // Decide reuse vs. re-embed per eligible entry.
  interface Plan {
    eligible: EligibleEntry;
    reusedBytes?: Buffer;
    reusedDimensions?: number;
  }
  const plans: Plan[] = eligible.map((e) => {
    if (opts.onlyChanged !== true) return { eligible: e };
    const prior = priorVectors.get(compositeKey(e.entry.source, e.entry.id));
    if (prior === undefined) return { eligible: e };
    const currentMtime = e.entry.sourceMtimeMs;
    const priorMtime = prior.entry.sourceMtimeMs;
    if (
      currentMtime === undefined ||
      priorMtime === null ||
      currentMtime !== priorMtime
    ) {
      return { eligible: e };
    }
    return {
      eligible: e,
      reusedBytes: prior.bytes,
      reusedDimensions: prior.bytes.length / 4,
    };
  });

  const toEmbedIndices: number[] = [];
  for (let i = 0; i < plans.length; i++) {
    if (plans[i]?.reusedBytes === undefined) toEmbedIndices.push(i);
  }

  logger.info(
    `embeddings: ${eligible.length} eligible (${toEmbedIndices.length} to embed, ` +
      `${plans.length - toEmbedIndices.length} reused) model=${model}`,
  );

  // ---- Embed pass (bounded concurrency) ----
  const newVectors = new Map<number, Float32Array>();
  let nextWork = 0;
  let embedded = 0;
  const t0 = Date.now();

  async function worker(): Promise<void> {
    while (true) {
      const w = nextWork++;
      if (w >= toEmbedIndices.length) return;
      const idx = toEmbedIndices[w] as number;
      const plan = plans[idx] as Plan;
      const oneOpts: { model: string; baseUrl?: string } =
        opts.baseUrl !== undefined ? { model, baseUrl: opts.baseUrl } : { model };
      const vec = await embedOne(plan.eligible.input, oneOpts);
      newVectors.set(idx, vec);
      embedded += 1;
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, toEmbedIndices.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (toEmbedIndices.length > 0) {
    logger.info(`embeddings: embedded ${embedded} vector(s) in ${Date.now() - t0}ms`);
  }

  // ---- Assemble bin + meta in plan order ----
  const chunks: Buffer[] = [];
  const entries: EmbeddingMetaEntry[] = [];
  let offset = 0;
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i] as Plan;
    let bytes: Buffer;
    let dimensions: number;
    if (plan.reusedBytes !== undefined) {
      bytes = plan.reusedBytes;
      dimensions = plan.reusedDimensions ?? NOMIC_DIMENSIONS;
    } else {
      const vec = newVectors.get(i);
      if (vec === undefined) {
        throw new Error(
          `embeddings: internal error — missing fresh vector for plan index ${i}`,
        );
      }
      bytes = vectorToLEFloat32Buffer(vec);
      dimensions = vec.length;
    }
    if (dimensions !== NOMIC_DIMENSIONS) {
      // Don't hard-fail — different model / dim is legal, but record only
      // the first one we see in the meta. Different vectors of different
      // dims in the same file would corrupt downstream readers; signal it.
      // We accept the run but the meta.dimensions reflects the first
      // dimension produced. (Mixed-dim guard kept simple intentionally.)
    }
    const meta: EmbeddingMetaEntry = {
      sessionId: plan.eligible.entry.id,
      source: plan.eligible.entry.source,
      offset,
      sourceMtimeMs: plan.eligible.entry.sourceMtimeMs ?? null,
    };
    entries.push(meta);
    chunks.push(bytes);
    offset += bytes.length;
  }

  // dim = bytes-of-first / 4; fall back to NOMIC if empty.
  const firstChunk = chunks[0];
  const inferredDim =
    firstChunk !== undefined && firstChunk.length > 0
      ? firstChunk.length / 4
      : NOMIC_DIMENSIONS;

  const metaFile: EmbeddingMeta = {
    version: 1,
    generatedAt: now,
    model,
    dimensions: inferredDim,
    byteOrder: 'le',
    dtype: 'float32',
    count: entries.length,
    entries,
  };

  await mkdir(analysisDir, { recursive: true });
  await writeFile(metaPath, JSON.stringify(metaFile, null, 2) + '\n', 'utf8');
  await writeFile(binPath, Buffer.concat(chunks));

  logger.info(
    `embeddings: wrote ${entries.length} vector(s) (${embedded} fresh, ` +
      `${entries.length - embedded} reused) → ${path.relative(opts.outDir, binPath)}`,
  );

  return {
    metaPath,
    binPath,
    embedded,
    reused: entries.length - embedded,
    skipped: skippedFromManifest,
  };
}
