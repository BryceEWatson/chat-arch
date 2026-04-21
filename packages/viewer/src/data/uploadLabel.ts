/**
 * Screenshot-safe label for an uploaded archive.
 *
 * claude.ai Privacy Exports are named `data-YYYY-MM-DD-<email>.zip` by
 * default, which means the raw `file.name` carries the user's email
 * address verbatim. The viewer:
 *
 *   - persists the label in IndexedDB (`UploadedCloudData.sourceLabel`),
 *     so it survives refresh,
 *   - renders it in the AnalysisLauncher / EmptyState UI, and
 *   - writes it to the activity log that users screenshot when asking
 *     for help.
 *
 * All three surfaces must keep the raw filename out. This module owns
 * the one-line redaction rule — intentionally a standalone file with
 * zero imports so the rule (and its tests) can run even when the rest
 * of the viewer's module graph has unrelated compile issues.
 */

/**
 * Produce `upload.<ext> (<size>)` — e.g. `"upload.zip (27.6 MB)"`.
 *
 * Extension policy: the raw extension must match `^[a-z0-9]{1,5}$`
 * (case-insensitive on input, lowercased on output). Anything else —
 * no dot, a long tail, or non-alnum characters — collapses to bare
 * `"upload"`. This defeats crafted filenames like
 * `archive.<script>alert(1)</script>` or `file.verylongextension`
 * that try to smuggle data through a naive regex.
 *
 * Size formatting matches the existing `formatBytes` rule: B / KB / MB
 * with one decimal place above the kilobyte threshold.
 */
export function maskedUploadLabel(file: File): string {
  const name = typeof file.name === 'string' ? file.name : '';
  const dot = name.lastIndexOf('.');
  const rawExt = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const safeExt = /^[a-z0-9]{1,5}$/.test(rawExt) ? `.${rawExt}` : '';
  return `upload${safeExt} (${formatBytes(file.size)})`;
}

/** Human-readable byte formatter shared by the label + legacy callers. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
