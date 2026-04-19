import type { UnifiedSessionEntry } from '@chat-arch/schema';
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
