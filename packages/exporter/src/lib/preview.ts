import { unwrapEnvelope } from '@chat-arch/analysis';

const MAX_PREVIEW_CHARS = 200;

/**
 * Build a preview string for a UnifiedSessionEntry from a raw user-facing
 * string (typically `manifest.initialMessage`).
 *
 * - Unwraps Claude Code / Cowork harness envelopes (slash-command triples,
 *   scheduled-task blocks, system-reminder / task-notification blocks).
 *   Without this, scheduled-task and slash-command sessions render with
 *   wrapper markup as their entire preview. See `unwrapEnvelope` for the
 *   full rule set.
 * - Trims leading/trailing whitespace.
 * - Collapses internal whitespace runs to single spaces for card display.
 * - Truncates to 200 chars (no ellipsis — avoids silently implying "more").
 * - Returns `null` for empty / missing input so the schema's required-nullable
 *   `preview` contract is honored.
 */
export function buildPreview(raw: string | undefined | null): string | null {
  const unwrapped = unwrapEnvelope(raw);
  if (unwrapped === null) return null;
  const collapsed = unwrapped.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= MAX_PREVIEW_CHARS) return collapsed;
  return collapsed.slice(0, MAX_PREVIEW_CHARS);
}
