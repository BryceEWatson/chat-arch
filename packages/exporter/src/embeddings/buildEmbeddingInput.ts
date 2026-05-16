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
 */
import type { UnifiedSessionEntry } from '@chat-arch/schema';

const MAX_CHARS = 2000;
const SECTION_SEPARATOR = '\n\n';

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function buildEmbeddingInput(entry: UnifiedSessionEntry): string {
  const sections: string[] = [];

  if (hasText(entry.title)) {
    sections.push(entry.title.trim());
  }
  if (hasText(entry.summary)) {
    sections.push(entry.summary.trim());
  }
  if (hasText(entry.preview)) {
    sections.push(entry.preview.trim());
  }
  if (entry.userTextSamples !== undefined) {
    for (const sample of entry.userTextSamples) {
      if (hasText(sample)) {
        sections.push(sample.trim());
      }
    }
  }

  if (sections.length === 0) return '';

  const joined = sections.join(SECTION_SEPARATOR);
  if (joined.length <= MAX_CHARS) return joined;
  return joined.slice(0, MAX_CHARS);
}
