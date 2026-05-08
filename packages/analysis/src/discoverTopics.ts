/**
 * Topic discovery — spec §4.2, decision D2.
 *
 * Browser-safe heuristic: derives `Topic` entities from the existing
 * `session.topic` strings already populated by the upstream classifier.
 * Sessions without a topic contribute to no topic entity (they may still
 * belong to a project via the unassigned bucket — topics and projects are
 * independent axes per spec §4.2).
 *
 * v2.0 keeps this lightweight to preserve the kernel-parity invariant
 * (`packages/analysis` runs identically in Node and browser; no embedding
 * inference at this layer). LLM/embedding-driven topic enrichment is
 * descoped to v2.1 (D7).
 *
 * Pure. The caller writes the result to `analysis/topics.json` per D2.
 */

import type { UnifiedSessionEntry, Topic } from '@chat-arch/schema';

export interface DiscoverTopicsOptions {
  now?: number;
}

export interface DiscoverTopicsResult {
  topics: Topic[];
  /** Map: sessionId → topicIds[]. Empty array when the session has no topic. */
  sessionToTopics: Map<string, string[]>;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function discoverTopics(
  sessions: readonly UnifiedSessionEntry[],
  sessionToProject: ReadonlyMap<string, string>,
  options: DiscoverTopicsOptions = {},
): DiscoverTopicsResult {
  void options;
  type Bucket = {
    id: string;
    displayName: string;
    sessionIds: string[];
    projectIds: Set<string>;
    earliest: number;
    latest: number;
  };

  const buckets = new Map<string, Bucket>();
  const sessionToTopics = new Map<string, string[]>();

  for (const s of sessions) {
    const topicLabel = s.topic;
    if (topicLabel === undefined || topicLabel === null || topicLabel === '') {
      sessionToTopics.set(s.id, []);
      continue;
    }
    const id = stableTopicId(topicLabel);
    const projectId = sessionToProject.get(s.id);
    const existing = buckets.get(id);
    if (existing === undefined) {
      buckets.set(id, {
        id,
        displayName: topicLabel,
        sessionIds: [s.id],
        projectIds: new Set(projectId !== undefined ? [projectId] : []),
        earliest: s.startedAt,
        latest: s.updatedAt,
      });
    } else {
      existing.sessionIds.push(s.id);
      if (projectId !== undefined) existing.projectIds.add(projectId);
      existing.earliest = Math.min(existing.earliest, s.startedAt);
      existing.latest = Math.max(existing.latest, s.updatedAt);
    }
    sessionToTopics.set(s.id, [id]);
  }

  const topics: Topic[] = [...buckets.values()].map(
    (b): Topic => ({
      id: b.id,
      displayName: b.displayName,
      sessionIds: b.sessionIds,
      projectIds: [...b.projectIds],
      firstSeenAt: isoFromMs(b.earliest),
      lastSeenAt: isoFromMs(b.latest),
    }),
  );

  return { topics, sessionToTopics };
}

function stableTopicId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/^~/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `topic_${simpleHash(label)}` : `topic_${slug}`;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
