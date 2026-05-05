import type { UnifiedSessionEntry, Project, Topic, Narrative } from '@chat-arch/schema';
import {
  discoverProjects,
  discoverTopics,
  discoverNarratives,
} from '@chat-arch/analysis';

/**
 * In-browser parallel emission of the three v2 entity sidecars
 * (Phase 6, deferred from Phase 2 per the analysis kernel's commit
 * note). Mirrors the wiring in `packages/exporter/src/analysis/index.ts`
 * verbatim — same kernel calls, same backfill of `narrativeIds`,
 * `topicIds`, and rolled-up `sentiment` onto each Project — so an
 * uploaded ZIP renders identical PROJECTS / TOPICS surfaces to a
 * server-rendered manifest.
 *
 * Pure. Deterministic given identical input + `now` override.
 */

export interface ComputeV2EntitiesOptions {
  now?: number;
}

export interface ComputeV2EntitiesResult {
  projects: Project[];
  topics: Topic[];
  narratives: Narrative[];
}

export function computeV2Entities(
  sessions: readonly UnifiedSessionEntry[],
  options: ComputeV2EntitiesOptions = {},
): ComputeV2EntitiesResult {
  const now = options.now ?? Date.now();

  const projectsResult = discoverProjects(sessions, { now });
  const topicsResult = discoverTopics(sessions, projectsResult.sessionToProject, { now });
  const narrativesResult = discoverNarratives(sessions, projectsResult.projects, { now });

  // Backfill narrativeIds + topicIds + sentiment onto each Project so
  // the browser-emitted shape matches the exporter's enriched output.
  const enrichedProjects: Project[] = projectsResult.projects.map((p) => {
    const topicIds = new Set<string>();
    for (const sid of p.sessionIds) {
      for (const tid of topicsResult.sessionToTopics.get(sid) ?? []) {
        topicIds.add(tid);
      }
    }
    return {
      ...p,
      narrativeIds: narrativesResult.narrativesByProject.get(p.id) ?? [],
      topicIds: [...topicIds],
      sentiment: narrativesResult.projectSentiment.get(p.id) ?? p.sentiment,
    };
  });

  return {
    projects: enrichedProjects,
    topics: topicsResult.topics,
    narratives: narrativesResult.narratives,
  };
}
