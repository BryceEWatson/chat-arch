const MAX_PREVIEW_CHARS = 200;

/**
 * Build a preview string for a UnifiedSessionEntry from a raw user-facing
 * string (typically `manifest.initialMessage`).
 *
 * - Trims leading/trailing whitespace.
 * - Collapses internal whitespace runs to single spaces for card display.
 * - Truncates to 200 chars (no ellipsis — avoids silently implying "more").
 * - Returns `null` for empty / missing input so the schema's required-nullable
 *   `preview` contract is honored.
 */
export function buildPreview(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const collapsed = trimmed.replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_PREVIEW_CHARS) return collapsed;
  return collapsed.slice(0, MAX_PREVIEW_CHARS);
}
