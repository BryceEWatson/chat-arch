import type { SessionManifest, SessionSource, UnifiedSessionEntry } from '@chat-arch/schema';
import { CURRENT_SCHEMA_VERSION } from '@chat-arch/schema';
import { estimateCost } from './cost/estimate.js';
import { logger } from './lib/logger.js';

/**
 * Pure merge — D15/D16 of phase4-plan, extended for Phase 6.
 *
 * Dedup key: `"${source}|${id}"`. When two entries collide (same key), prefer
 * the one with MORE defined-and-non-null fields. On a tie, prefer the later-
 * seen entry, which — given the fixed cowork → cli → cloud call order in
 * `runAllSubcommand` — guarantees Phase 3's enriched cli-desktop row beats
 * Phase 2's stub when both are present.
 *
 * Phase 6 addition: after dedup + sort, populate `costEstimatedUsd` and
 * `costIsEstimate` on every entry (Decision 2) and warn-log unknown modelIds
 * with session counts (Decision 3). Schema version bumped to
 * `CURRENT_SCHEMA_VERSION` (2).
 *
 * Output is sorted by `updatedAt` desc. Counts cover all four source keys
 * (always emitted, even if zero).
 */
export function mergeSources(
  cowork: readonly UnifiedSessionEntry[],
  cli: readonly UnifiedSessionEntry[],
  cloud: readonly UnifiedSessionEntry[],
  generatedAt: number = Date.now(),
): SessionManifest {
  const merged = new Map<string, UnifiedSessionEntry>();
  // Order matters: cowork first, cli next (overrides cowork's cli-desktop
  // stubs when richer), cloud last.
  for (const source of [cowork, cli, cloud] as const) {
    for (const entry of source) {
      const key = `${entry.source}|${entry.id}`;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, entry);
        continue;
      }
      // Prefer richer; on tie, prefer the later-seen (current `entry`).
      const existingRichness = countDefinedFields(existing);
      const candidateRichness = countDefinedFields(entry);
      if (candidateRichness >= existingRichness) {
        merged.set(key, entry);
      }
    }
  }

  const sorted = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  // Phase 6 cost-annotation pass. Pure per-entry math via `estimateCost`.
  const unknownCounts = new Map<string, number>();
  const sessions = sorted.map((e): UnifiedSessionEntry => {
    const r = estimateCost(e);
    if (r.unknownModelId !== undefined) {
      unknownCounts.set(r.unknownModelId, (unknownCounts.get(r.unknownModelId) ?? 0) + 1);
    }
    return {
      ...e,
      costEstimatedUsd: r.costEstimatedUsd,
      costIsEstimate: r.costIsEstimate,
      ...(r.breakdown !== undefined ? { costBreakdown: r.breakdown } : {}),
    };
  });

  for (const [modelId, count] of unknownCounts) {
    logger.warn(
      `cost: unknown modelId "${modelId}" seen in ${count} session(s); costEstimatedUsd set to null`,
    );
  }

  const counts: Record<SessionSource, number> = {
    cowork: 0,
    'cli-direct': 0,
    'cli-desktop': 0,
    cloud: 0,
  };
  for (const e of sessions) counts[e.source] += 1;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt,
    counts,
    sessions,
  };
}

/**
 * Count of keys on the entry whose value is defined (present) AND not null.
 * Used as the tiebreaker for collisions. Richness metric only — not a deep
 * structural compare; equal counts yield a later-seen preference.
 */
function countDefinedFields(entry: UnifiedSessionEntry): number {
  let n = 0;
  for (const v of Object.values(entry as unknown as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    n += 1;
  }
  return n;
}
