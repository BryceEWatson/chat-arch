/**
 * CORRECTIONS selector — the `data → view-model` derivations behind the
 * CORRECTIONS surface, extracted VERBATIM from `CorrectionsPanel.tsx`
 * (Phase 2 of the "Centralize data processing" refactor).
 *
 * Two derivations live here:
 *   - `sortPatterns` — the within-bucket pattern order (recurring-after-
 *     applied first, then confidence, then occurrence count).
 *   - `buildTopicBuckets` — group patterns by topic into ordered buckets.
 *
 * Pure / deterministic / React-free. The component renders the returned
 * `TopicBucket[]` without doing any further derivation. The client-state-
 * coupled merge (`mergeAppliedImprovements`) intentionally STAYS viewer-
 * side (`viewer/src/data/correctionsLoader.ts`) — it composes uploaded-ZIP
 * client state, not schema-typed analysis data (plan's "Escape hatch").
 */

import type { CorrectionPattern } from '@chat-arch/schema';

/**
 * Sentinel topic for patterns emitted by mining runs that predate the
 * `tag-topics` skill stage. Acts as a graceful fallback so the viewer
 * doesn't break on legacy `corrections.json` files; re-mining assigns a
 * real topic and the bucket disappears.
 */
export const UNTAGGED_TOPIC = 'Untagged';

export function topicOf(p: CorrectionPattern): string {
  return typeof p.topic === 'string' && p.topic.trim().length > 0
    ? p.topic.trim()
    : UNTAGGED_TOPIC;
}

export interface TopicBucket {
  key: string;
  label: string;
  patterns: CorrectionPattern[];
  /** Sum of occurrenceCount across all patterns — drives bucket order. */
  weight: number;
  /** True when ≥1 pattern is recurring after applied. Hoists the bucket
   *  toward the top regardless of weight (recurring is the highest-
   *  signal finding the user can act on), AND drives the bucket's
   *  visual urgency via the `data-has-recurring` style hook so the
   *  user can scan the page for hot spots at a glance. */
  hasRecurring: boolean;
  /** True when ≥1 pattern is alreadyEncoded but not recurring — a
   *  weaker urgency signal than `hasRecurring`. Drives the bucket's
   *  visual treatment when `hasRecurring` is false. */
  hasEncoded: boolean;
}

/**
 * Within-bucket pattern order. Recurring-after-applied sorts to the top —
 * the strongest "your rule is failing in practice" signal beats raw
 * confidence.
 */
export function sortPatterns(
  a: CorrectionPattern,
  b: CorrectionPattern,
): number {
  if (a.recurringPostApplication !== b.recurringPostApplication) {
    return a.recurringPostApplication ? -1 : 1;
  }
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return b.occurrenceCount - a.occurrenceCount;
}

/**
 * Group patterns by their LLM-derived topic. Buckets are ordered by:
 *   1. has-recurring desc (recurring topics surface first)
 *   2. weight desc (larger topics before smaller)
 *   3. label asc (stable tiebreak)
 * Within a bucket, recurring patterns sort to the top so the highest-
 * signal items inside a topic are visible without scrolling.
 */
export function buildTopicBuckets(
  patterns: ReadonlyArray<CorrectionPattern>,
): TopicBucket[] {
  const seen = new Set<string>();
  const byTopic = new Map<string, CorrectionPattern[]>();
  for (const p of patterns) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const topic = topicOf(p);
    const arr = byTopic.get(topic);
    if (arr) arr.push(p);
    else byTopic.set(topic, [p]);
  }
  const buckets: TopicBucket[] = [];
  for (const [topic, group] of byTopic) {
    group.sort(sortPatterns);
    let weight = 0;
    let hasRecurring = false;
    let hasEncoded = false;
    for (const p of group) {
      weight += p.occurrenceCount;
      if (p.recurringPostApplication) hasRecurring = true;
      else if (p.alreadyEncoded) hasEncoded = true;
    }
    buckets.push({
      key: topic,
      // The Untagged sentinel gets a friendlier label so a partial
      // re-mine (or legacy corrections.json from before tag-topics
      // landed) doesn't surface a bare "UNTAGGED" header. The
      // bucket's `key` stays `Untagged` so [data-topic] selectors and
      // bucket-order rules can still target it.
      label:
        topic === UNTAGGED_TOPIC
          ? 'UNTAGGED · re-mine to assign'
          : topic.toUpperCase(),
      patterns: group,
      weight,
      hasRecurring,
      hasEncoded,
    });
  }
  buckets.sort((a, b) => {
    // The Untagged bucket is a graceful fallback, not signal — pin it
    // to the bottom regardless of weight/recurring so it doesn't
    // float above named topics on a partial re-mine.
    const aUntagged = a.key === UNTAGGED_TOPIC;
    const bUntagged = b.key === UNTAGGED_TOPIC;
    if (aUntagged !== bUntagged) return aUntagged ? 1 : -1;
    if (a.hasRecurring !== b.hasRecurring) return a.hasRecurring ? -1 : 1;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.label.localeCompare(b.label);
  });
  return buckets;
}
