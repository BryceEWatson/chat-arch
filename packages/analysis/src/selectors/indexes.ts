/**
 * INDEX selectors — the `data → view-model` ordering derivations behind
 * the index/grouping surfaces (PROJECTS, TOPICS, and any other surface
 * that lists schema entities in a stable order). Phase 3 of the
 * "Centralize data processing" refactor.
 *
 * These are the pure, schema-typed sorts the index components used to do
 * inline in `useMemo` bodies. The components keep their UI-coupled state
 * (search-string filters, show/hide toggles, id→entity lookup maps for
 * click-through) and call these for the deterministic ordering.
 *
 * Pure / deterministic / React-free.
 */

import type { Project, Topic, UnifiedSessionEntry } from '@chat-arch/schema';
import { isUnassignedProject } from '@chat-arch/schema';

/**
 * Project index order: real projects before the `[UNASSIGNED]`
 * pseudo-project, then most-recent activity first (by `lastActivityAt`).
 * Does not mutate the input. Mirrors `ProjectsIndex`'s inline sort.
 */
export function rankProjectsByActivity(
  projects: readonly Project[],
): Project[] {
  return [...projects].sort((a, b) => {
    const aU = isUnassignedProject(a);
    const bU = isUnassignedProject(b);
    if (aU !== bU) return aU ? 1 : -1;
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

/**
 * Topic index order: most sessions first. Does not mutate the input.
 * Mirrors `TopicsIndex`'s inline sort.
 */
export function rankTopicsBySessionCount(topics: readonly Topic[]): Topic[] {
  return [...topics].sort((a, b) => b.sessionIds.length - a.sessionIds.length);
}

/**
 * Resolve a list of session ids against a lookup map and return the
 * resolved entries ordered most-recently-updated first. Ids with no
 * entry in the map are dropped. Used by the PROJECTS / TOPICS detail
 * surfaces for their session lists. Does not mutate the map.
 */
export function sortSessionsByRecency(
  sessionIds: readonly string[],
  sessionById: ReadonlyMap<string, UnifiedSessionEntry>,
): UnifiedSessionEntry[] {
  const list: UnifiedSessionEntry[] = [];
  for (const sid of sessionIds) {
    const s = sessionById.get(sid);
    if (s) list.push(s);
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}
