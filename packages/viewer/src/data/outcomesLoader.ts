import type {
  CompositeOutcome,
  CompositeOutcomesFile,
} from '@chat-arch/schema';

/**
 * Loader for `analysis/composite-outcomes.json`.
 *
 * Per the Wave 1 schema + Wave 3 builder contract:
 *   - The file is self-describing: it carries its own `compositeVersion`,
 *     `weightsVersion`, and root `weightsHash`.
 *   - Each row also carries a `weightsHash`. The builder's `loadPriorCache`
 *     drops rows whose per-row hash mismatches the file root (partial-
 *     write recovery). The viewer applies the same belt-and-suspenders
 *     check at read time: mismatched rows are marked `binary: 'unknown'`
 *     so the EffectivenessMode surface won't render them until the next
 *     rescan rewrites the file end-to-end.
 *
 * Returns `null` for missing / unreadable / unparseable files so the
 * caller can render the empty state. A version-future file (unknown
 * `compositeVersion`) is rejected outright — the viewer does not
 * speculatively decode unknown shapes.
 */

const SUPPORTED_COMPOSITE_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

function joinAnalysisUrl(baseUrl: string, filename: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/analysis/${filename}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Per-row weightsHash cross-check. Rows whose hash doesn't match the
 * file root are stamped `binary: 'unknown'` so downstream consumers can
 * skip them without throwing. We don't drop them outright — keeping the
 * stub in place lets the viewer report "K rows skipped" without losing
 * provenance.
 */
function normalizeRows(
  file: CompositeOutcomesFile,
): readonly CompositeOutcome[] {
  const rootHash = file.weightsHash;
  const normalized: CompositeOutcome[] = [];
  for (const row of file.outcomes ?? []) {
    if (row === null || typeof row !== 'object') continue;
    if (typeof row.sessionId !== 'string') continue;
    if (typeof row.score !== 'number' || !Number.isFinite(row.score)) continue;
    if (row.weightsHash !== rootHash) {
      normalized.push({ ...row, binary: 'unknown' });
      continue;
    }
    normalized.push(row);
  }
  return normalized;
}

export async function loadCompositeOutcomesFile(
  baseUrl: string,
): Promise<CompositeOutcomesFile | null> {
  const body = await fetchJson<CompositeOutcomesFile>(
    joinAnalysisUrl(baseUrl, 'composite-outcomes.json'),
  );
  if (body === null) return null;
  if (
    typeof body.compositeVersion !== 'number' ||
    !SUPPORTED_COMPOSITE_VERSIONS.has(body.compositeVersion)
  ) {
    return null;
  }
  if (typeof body.weightsVersion !== 'number') return null;
  if (typeof body.weightsHash !== 'string' || body.weightsHash.length === 0) {
    return null;
  }
  if (!Array.isArray(body.outcomes)) return null;
  return { ...body, outcomes: normalizeRows(body) };
}
