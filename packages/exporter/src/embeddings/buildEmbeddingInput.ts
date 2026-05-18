/**
 * buildEmbeddingInput — assemble the per-session text input for the
 * embedding model.
 *
 * Spec §4: "concatenation of `title`, `summary` (if present), `preview`,
 * all `userTextSamples`, truncated to ~2k chars. Same input shape as
 * `discoverNarratives` widening so signals stay consistent."
 *
 * Pure function. Returns an empty string when no signal-bearing field is
 * populated; callers MUST skip empty results rather than embed whitespace.
 *
 * Two exports:
 *
 *   `buildEmbeddingInput(entry)` — the original. Returns a single
 *     string truncated at MAX_CHARS. Cheap; one vector per session.
 *     Used by the production embedDriver (today).
 *
 *   `buildEmbeddingInputChunks(entry, maxCharsPerChunk)` — chunked.
 *     Returns string[] split at word boundaries. Callers embed each
 *     chunk and mean-pool the resulting vectors to one per session.
 *     Preserves discriminative content from later in long sessions
 *     that the single-truncate version drops. Mirrors the viewer-side
 *     `conversationToChunks` strategy (semanticClassify.ts:316-323)
 *     so cosine comparisons across both stacks stay comparable.
 *
 *     Production NOT yet wired to the chunked variant — flipping it
 *     requires invalidating the on-disk embeddings cache (every prior
 *     session vector was built from a truncated single-string input;
 *     re-running chunked produces a different vector for any session
 *     whose text exceeds the chunk window). See `embedDriver.ts` and
 *     the EmbeddingMeta schema for the cache-busting work needed
 *     before flipping.
 */
import type { UnifiedSessionEntry } from '@chat-arch/schema';

const MAX_CHARS = 2000;
/**
 * Per-chunk size for `buildEmbeddingInputChunks`. Matches the viewer's
 * `MAX_CHARS_PER_CHUNK = 1800` constant in semanticClassify.ts — same
 * model family (mxbai/bge) → same ~512-token window → same 1800-char
 * safety margin. Keeping the two stacks aligned means a session's
 * exporter-side mean-pooled vector and viewer-side mean-pooled vector
 * land in the same neighborhood for cosine purposes.
 */
export const DEFAULT_CHUNK_CHARS = 1800;
const SECTION_SEPARATOR = '\n\n';

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function gatherSections(entry: UnifiedSessionEntry): string[] {
  const sections: string[] = [];
  if (hasText(entry.title)) sections.push(entry.title.trim());
  if (hasText(entry.summary)) sections.push(entry.summary.trim());
  if (hasText(entry.preview)) sections.push(entry.preview.trim());
  if (entry.userTextSamples !== undefined) {
    for (const sample of entry.userTextSamples) {
      if (hasText(sample)) sections.push(sample.trim());
    }
  }
  return sections;
}

export function buildEmbeddingInput(entry: UnifiedSessionEntry): string {
  const sections = gatherSections(entry);
  if (sections.length === 0) return '';
  const joined = sections.join(SECTION_SEPARATOR);
  if (joined.length <= MAX_CHARS) return joined;
  return joined.slice(0, MAX_CHARS);
}

/**
 * Split `text` into ≤ `maxChars` chunks. Cuts at word boundaries when
 * one is available within the back-up window (2/3 of maxChars from the
 * end); otherwise falls through to a hard cut to bound the worst case
 * on very long single tokens.
 *
 * The boundary-search keeps chunks readable to the model — the
 * embedder is far more sensitive to mid-word cuts than to slightly
 * uneven chunk sizes.
 */
function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const lastSpace = window.lastIndexOf(' ');
      const lastNewline = window.lastIndexOf('\n');
      const cut = Math.max(lastSpace, lastNewline);
      if (cut > maxChars * 0.66) {
        end = start + cut;
      }
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) out.push(chunk);
    start = end;
  }
  return out;
}

/**
 * Chunk-pool variant. Returns the embedding input split into chunks
 * each ≤ `maxCharsPerChunk` (default 1800). Callers feed each chunk to
 * the embedder and mean-pool the vectors per session before storing.
 *
 * Returns `[]` (not `['']`) when the entry has no signal-bearing
 * content — callers MUST skip empty arrays rather than dispatch a
 * zero-chunk embed call.
 *
 * The title is included in chunk 0 (sections are concatenated in
 * order: title → summary → preview → samples). Chunks past 0 may not
 * carry the title, so for very long sessions the later chunks
 * contribute "what this session is about" via the user-sample
 * content rather than via the title anchor. This matches the viewer-
 * side strategy and is the deliberate tradeoff for keeping chunk
 * boundaries simple.
 */
export function buildEmbeddingInputChunks(
  entry: UnifiedSessionEntry,
  maxCharsPerChunk: number = DEFAULT_CHUNK_CHARS,
): string[] {
  const sections = gatherSections(entry);
  if (sections.length === 0) return [];
  const joined = sections.join(SECTION_SEPARATOR);
  return chunkText(joined, maxCharsPerChunk);
}
