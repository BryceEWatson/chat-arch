/**
 * Row-level reader-side normalization + family classification for
 * `narratives.json` — single source of truth used by every consumer
 * (`ProjectsMode.tsx`, `mergeNarrativeFamilies`, `narrativeTier`-via-
 * opts, the curator-feed builder, `clear-narratives.ts`).
 *
 * Legacy rows written before EXPORTER_VERSION 1.7.0 lack the
 * `attributedTo` / `contradictingCount` / `verifiedAt` fields the V1
 * narrative-mining feature adds. `normalizeNarrativeRow` defaults
 * those fields so every downstream caller works against a consistent
 * shape without having to pepper `?? 'deterministic'` defensively.
 *
 * `classifyAttribution` buckets the 4-value `NarrativeAttribution` into
 * two families — heuristic vs LLM — per the spec's row-classification
 * table. Unknown future attribution values fall to `'unknown'` and the
 * caller MUST drop the row with a log (NOT silently coerce to either
 * family).
 *
 * Pure, browser-safe.
 */

import type { Narrative, NarrativeAttribution } from '@chat-arch/schema';

/** Family the merge helper + viewer surfaces use. */
export type NarrativeFamily = 'heuristic' | 'llm' | 'unknown';

/**
 * Apply V1 reader-side defaults to a row read from disk. Legacy rows
 * without `attributedTo` / `contradictingCount` / `verifiedAt` get
 * filled in:
 *
 *   - `attributedTo` → `'deterministic'` (legacy heuristic kernel output)
 *   - `contradictingCount` → `0` (V1 has no contrary-evidence finder)
 *   - `verifiedAt` → `null` (not falsifier-verified)
 *
 * Rows that already have the fields populated pass through unchanged.
 */
export function normalizeNarrativeRow(row: Narrative): Narrative {
  return {
    ...row,
    attributedTo: row.attributedTo ?? 'deterministic',
    contradictingCount: row.contradictingCount ?? 0,
    verifiedAt: row.verifiedAt ?? null,
  };
}

/**
 * Map a row's `attributedTo` to a family bucket. Pass a row that has
 * already been through `normalizeNarrativeRow`; this function does NOT
 * default — it inspects the value as-given.
 *
 *   - `'deterministic'` | `'deterministic-with-prior'` → `'heuristic'`
 *   - `'llm-derived'` | `'falsifier-verified'` → `'llm'`
 *   - any other / unknown future value → `'unknown'`
 *
 * Callers MUST treat `'unknown'` as "drop this row with a log line",
 * never silently coerce.
 */
export function classifyAttribution(row: Narrative): NarrativeFamily {
  const attrib: NarrativeAttribution | undefined = row.attributedTo;
  switch (attrib) {
    case 'deterministic':
    case 'deterministic-with-prior':
      return 'heuristic';
    case 'llm-derived':
    case 'falsifier-verified':
      return 'llm';
    default:
      return 'unknown';
  }
}
