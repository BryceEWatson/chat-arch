import type { SessionSource, UnifiedSessionEntry } from '@chat-arch/schema';
import type { FilterState } from '../types.js';
import { weekStart } from '../util/time.js';

/**
 * Case-insensitive substring filter on (title + summary + preview),
 * plus source-set membership.
 *
 * Empty query = pass-through on query axis (plan decision 7).
 * Empty filter set = pass-through on source axis (plan decision 15).
 */
export function filterSessions(
  sessions: readonly UnifiedSessionEntry[],
  query: string,
  filter: FilterState,
): readonly UnifiedSessionEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '' && filter.size === 0) return sessions;
  return sessions.filter((s) => {
    if (filter.size > 0 && !filter.has(s.source)) return false;
    if (q === '') return true;
    if (s.title.toLowerCase().includes(q)) return true;
    if (s.summary && s.summary.toLowerCase().includes(q)) return true;
    if (s.preview && s.preview.toLowerCase().includes(q)) return true;
    // Substring match also covers cwd, project, topTools[].name,
    // modelsUsed[].modelId so users can find a session by project name
    // or tool name (e.g. `web_search`, `WebFetch`) without scanning
    // the list manually.
    if (s.cwd && s.cwd.toLowerCase().includes(q)) return true;
    if (s.project && s.project.toLowerCase().includes(q)) return true;
    if (s.topTools) {
      for (const name of Object.keys(s.topTools)) {
        if (name.toLowerCase().includes(q)) return true;
      }
    }
    if (s.modelsUsed) {
      for (const m of s.modelsUsed) {
        if (m.toLowerCase().includes(q)) return true;
      }
    }
    return false;
  });
}

/** Stable sort by `updatedAt` descending. Does not mutate input. */
export function sortByUpdatedDesc(
  sessions: readonly UnifiedSessionEntry[],
): readonly UnifiedSessionEntry[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Sort axis exposed by the SORT dropdown in the MidBar (redesign
 * Phase 6a). The viewer persists the user's pick in localStorage and
 * applies it to the `filtered` list before rendering.
 *
 * `recent` / `oldest` are the only options that are meaningful across
 * all modes — `cost`, `turns`, `project` are session-level axes that
 * primarily apply to the Command grid, which is where the dropdown
 * surfaces.
 */
export type SortBy = 'recent' | 'oldest' | 'cost' | 'turns' | 'project';

export const VALID_SORTS: readonly SortBy[] = [
  'recent',
  'oldest',
  'cost',
  'turns',
  'project',
];

/**
 * Pure, non-mutating sort over a session list. Secondary sort by
 * `updatedAt desc` when the primary axis ties — keeps output stable
 * and prevents the grid from reshuffling when two sessions have
 * identical cost or turn counts.
 */
export function applySort(
  sessions: readonly UnifiedSessionEntry[],
  sortBy: SortBy,
): readonly UnifiedSessionEntry[] {
  const out = [...sessions];
  switch (sortBy) {
    case 'recent':
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      break;
    case 'oldest':
      out.sort((a, b) => a.updatedAt - b.updatedAt);
      break;
    case 'cost': {
      // Treat sessions without exact cost but with an estimate as
      // that estimate; sessions without either as zero. Sort desc so
      // the user sees the biggest spenders first.
      const costOf = (s: UnifiedSessionEntry): number =>
        s.totalCostUsd ?? s.costEstimatedUsd ?? 0;
      out.sort((a, b) => costOf(b) - costOf(a) || b.updatedAt - a.updatedAt);
      break;
    }
    case 'turns':
      out.sort(
        (a, b) => (b.userTurns ?? 0) - (a.userTurns ?? 0) || b.updatedAt - a.updatedAt,
      );
      break;
    case 'project':
      // Alphabetical. Untagged sessions (no project) sink to the
      // bottom by using a `~~` sentinel that sorts last.
      out.sort((a, b) => {
        const pa = a.project ?? '~~';
        const pb = b.project ?? '~~';
        const cmp = pa.localeCompare(pb);
        return cmp !== 0 ? cmp : b.updatedAt - a.updatedAt;
      });
      break;
  }
  return out;
}

export interface WeekBucket {
  /** ms-since-epoch, aligned to Sunday 00:00 UTC. */
  start: number;
  count: number;
}

/**
 * Bucket sessions into weekly counts (Sunday-aligned, UTC).
 * Returns dense buckets from the earliest to latest session, inclusive.
 */
export function bucketByWeek(sessions: readonly UnifiedSessionEntry[]): readonly WeekBucket[] {
  if (sessions.length === 0) return [];
  const WEEK_MS = 7 * 86_400_000;
  let min = sessions[0]!.updatedAt;
  let max = sessions[0]!.updatedAt;
  for (const s of sessions) {
    if (s.updatedAt < min) min = s.updatedAt;
    if (s.updatedAt > max) max = s.updatedAt;
  }
  const first = weekStart(min);
  const last = weekStart(max);
  const buckets = new Map<number, number>();
  for (let t = first; t <= last; t += WEEK_MS) buckets.set(t, 0);
  for (const s of sessions) {
    const key = weekStart(s.updatedAt);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, count]) => ({ start, count }));
}

export interface WeekBucketBySource {
  /** ms-since-epoch, aligned to Sunday 00:00 UTC. */
  start: number;
  /** Count per session source in this week. Sources with zero sessions
   *  are omitted (the consumer sums values for the total). */
  bySource: Partial<Record<SessionSource, number>>;
  /** Total across all sources — pre-summed for convenience. */
  total: number;
}

/**
 * Like `bucketByWeek` but subdivides each bucket by `session.source`.
 * Returns dense buckets from the earliest to latest session, inclusive,
 * so the caller can render per-source stacks with consistent week
 * alignment. When a source is absent from a week, its slot is omitted
 * from `bySource` (the renderer should default to zero).
 */
export function bucketByWeekBySource(
  sessions: readonly UnifiedSessionEntry[],
): readonly WeekBucketBySource[] {
  if (sessions.length === 0) return [];
  const WEEK_MS = 7 * 86_400_000;
  let min = sessions[0]!.updatedAt;
  let max = sessions[0]!.updatedAt;
  for (const s of sessions) {
    if (s.updatedAt < min) min = s.updatedAt;
    if (s.updatedAt > max) max = s.updatedAt;
  }
  const first = weekStart(min);
  const last = weekStart(max);
  const buckets = new Map<number, { bySource: Partial<Record<SessionSource, number>>; total: number }>();
  for (let t = first; t <= last; t += WEEK_MS) {
    buckets.set(t, { bySource: {}, total: 0 });
  }
  for (const s of sessions) {
    const key = weekStart(s.updatedAt);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.bySource[s.source] = (bucket.bySource[s.source] ?? 0) + 1;
    bucket.total += 1;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, { bySource, total }]) => ({ start, bySource, total }));
}
