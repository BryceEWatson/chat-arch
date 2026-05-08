import type { Project, Topic, Narrative } from '@chat-arch/schema';

/**
 * Parallel-fetch the three v2 entity sidecars written by the exporter
 * (Phase 2): `projects.json`, `topics.json`, `narratives.json`. Mirrors
 * the tolerance contract of `analysisFetch.ts`:
 *
 *   - 404 / network / parse errors are NOT thrown — each missing file
 *     resolves to `null`. The viewer treats absent v2 entities as the
 *     pre-discovery cold-start state and just doesn't render the new
 *     chips. (Phase 2 commit explicitly deferred in-browser parallel
 *     emission to Phase 6, so this fetch is the only path until then.)
 *   - Each file's payload shape is `{ generatedAt: number, items: ... }`
 *     where `items` is the spec-typed array. We unwrap to the array
 *     for the caller; `generatedAt` isn't load-bearing in the viewer.
 */

export interface V2EntitiesFetchResult {
  projects: readonly Project[] | null;
  topics: readonly Topic[] | null;
  narratives: readonly Narrative[] | null;
}

interface ProjectsFile {
  generatedAt?: number;
  projects?: readonly Project[];
}
interface TopicsFile {
  generatedAt?: number;
  topics?: readonly Topic[];
}
interface NarrativesFile {
  generatedAt?: number;
  narratives?: readonly Narrative[];
}

async function fetchOne<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function resolveAnalysisUrl(dataRoot: string, filename: string): string {
  const root = dataRoot.endsWith('/') ? dataRoot.slice(0, -1) : dataRoot;
  return `${root}/analysis/${filename}`;
}

export async function fetchV2Entities(dataRoot: string): Promise<V2EntitiesFetchResult> {
  const [projectsFile, topicsFile, narrativesFile] = await Promise.all([
    fetchOne<ProjectsFile>(resolveAnalysisUrl(dataRoot, 'projects.json')),
    fetchOne<TopicsFile>(resolveAnalysisUrl(dataRoot, 'topics.json')),
    fetchOne<NarrativesFile>(resolveAnalysisUrl(dataRoot, 'narratives.json')),
  ]);
  return {
    projects: Array.isArray(projectsFile?.projects) ? projectsFile.projects : null,
    topics: Array.isArray(topicsFile?.topics) ? topicsFile.topics : null,
    narratives: Array.isArray(narrativesFile?.narratives) ? narrativesFile.narratives : null,
  };
}

/**
 * Per-session lookup tables built once from the fetched sidecars.
 * Cards consume these to render topic / narrative chips in O(1).
 */
export interface SessionV2Index {
  /** sessionId → list of topic display names (preserves topics.json order). */
  topicsBySession: Map<string, readonly string[]>;
  /**
   * sessionId → list of narratives whose `sessionIds[]` references it.
   * Used to render the "narrative attached" chip.
   */
  narrativesBySession: Map<string, readonly Narrative[]>;
}

export function buildSessionV2Index(
  topics: readonly Topic[] | null,
  narratives: readonly Narrative[] | null,
): SessionV2Index {
  const topicsBySession = new Map<string, string[]>();
  if (topics) {
    for (const t of topics) {
      for (const sid of t.sessionIds) {
        const arr = topicsBySession.get(sid);
        if (arr) arr.push(t.displayName);
        else topicsBySession.set(sid, [t.displayName]);
      }
    }
  }
  const narrativesBySession = new Map<string, Narrative[]>();
  if (narratives) {
    for (const n of narratives) {
      for (const sid of n.sessionIds) {
        const arr = narrativesBySession.get(sid);
        if (arr) arr.push(n);
        else narrativesBySession.set(sid, [n]);
      }
    }
  }
  return {
    topicsBySession: topicsBySession as Map<string, readonly string[]>,
    narrativesBySession: narrativesBySession as Map<string, readonly Narrative[]>,
  };
}
