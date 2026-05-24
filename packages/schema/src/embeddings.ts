/**
 * Embedding sidecar shapes (v2 §4).
 *
 * The exporter emits two files under `analysis/`:
 *   - `embeddings.bin` — concatenated little-endian float32 vectors.
 *   - `embeddings.meta.json` — this file, mapping sessionId → byte offset.
 *
 * The split avoids name-collision with the existing `analysis/meta.json`
 * (the global analysis run-meta sidecar). The vectors are stored in a flat
 * binary because at ~10k sessions × 768 dims × 4 bytes ≈ 30 MB it is small
 * enough to mmap or read whole, and storing in JSON would 5–10× the size.
 */

import type { SessionSource } from './unified.js';

export type EmbeddingDtype = 'float32';
export type EmbeddingByteOrder = 'le';

export interface EmbeddingMetaEntry {
  /** UnifiedSessionEntry.id (composite primary key uses (source, id)). */
  sessionId: string;
  source: SessionSource;
  /** Byte offset into `embeddings.bin`. */
  offset: number;
  /**
   * sourceMtimeMs at embedding time. Used by `--only-changed` to skip
   * re-embedding when the upstream transcript has not been re-aggregated.
   * null when the upstream source does not carry mtime (e.g. cloud).
   */
  sourceMtimeMs: number | null;
}

export interface EmbeddingMeta {
  version: 1;
  generatedAt: number;
  /** Ollama model name (e.g. 'nomic-embed-text'). */
  model: string;
  /** Vector dimensionality (nomic-embed-text = 768). */
  dimensions: number;
  byteOrder: EmbeddingByteOrder;
  dtype: EmbeddingDtype;
  /** Total embedded sessions; equals entries.length. */
  count: number;
  entries: readonly EmbeddingMetaEntry[];
}
