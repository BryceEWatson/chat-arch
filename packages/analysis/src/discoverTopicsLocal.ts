/**
 * Local-session topic extension — spec §5 Layer A (implicit, via
 * embeddings substrate) and acceptance #2.
 *
 * Existing `discoverTopics` only buckets sessions that already carry
 * `entry.topic` (cloud-only today). This module extends it for local
 * sessions (Cowork / CLI-direct / CLI-desktop) by running an embedding-
 * driven complete-linkage cluster pass over sessions without a topic
 * string, then translating each emergent cluster into a Topic record.
 *
 * Pure. The caller wires it up: load embeddings.bin, pass the (sessionId
 * → vector) map plus title+preview text per session, and merge the
 * resulting Topic[] into the heuristic output.
 */

import type { Topic, UnifiedSessionEntry } from '@chat-arch/schema';
import { discoverClusters, type ClusterInput } from './discoverClusters.js';

const STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'you',
  'your',
  'we',
  'our',
  'they',
  'their',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\-\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export interface DiscoverTopicsLocalOptions {
  now?: number;
  /** Cosine threshold for complete-linkage. Default 0.55 — coherent without chain-merging. */
  threshold?: number;
  /** Min member count per cluster. Default 3. */
  minSize?: number;
}

export interface DiscoverTopicsLocalResult {
  topics: Topic[];
  /** sessionId → topicIds[] (each session is in 0 or 1 emergent topic). */
  sessionToTopics: Map<string, string[]>;
  /** Number of local sessions considered (had a vector + were not pre-topiced). */
  consideredCount: number;
}

export function discoverTopicsLocal(
  sessions: readonly UnifiedSessionEntry[],
  sessionEmbeddings: ReadonlyMap<string, Float32Array>,
  sessionToProject: ReadonlyMap<string, string>,
  options: DiscoverTopicsLocalOptions = {},
): DiscoverTopicsLocalResult {
  const now = options.now ?? Date.now();
  const threshold = options.threshold ?? 0.55;
  const minSize = options.minSize ?? 3;

  // Build inputs only for sessions that:
  //   - have an embedding
  //   - do NOT already carry a string topic (cloud-attributed); cloud
  //     sessions are handled by the heuristic discoverTopics
  //   - are not pruned (already filtered upstream when building vectors)
  const inputs: ClusterInput[] = [];
  const inputBySessionId = new Map<string, UnifiedSessionEntry>();
  for (const s of sessions) {
    if (s.topic !== undefined && s.topic !== null && s.topic !== '') continue;
    const vec = sessionEmbeddings.get(s.id);
    if (vec === undefined) continue;
    const text =
      [s.title, s.preview ?? '', ...(s.userTextSamples ?? [])]
        .filter((x) => typeof x === 'string' && x.length > 0)
        .join(' ');
    inputs.push({
      id: s.id,
      vector: vec,
      tokens: tokenize(text),
      text: s.title,
    });
    inputBySessionId.set(s.id, s);
  }

  if (inputs.length < minSize) {
    return { topics: [], sessionToTopics: new Map(), consideredCount: inputs.length };
  }

  const clusters = discoverClusters(inputs, {
    threshold,
    minSize,
    labelStrategy: 'tfidf',
  });

  const topics: Topic[] = [];
  const sessionToTopics = new Map<string, string[]>();
  for (const c of clusters) {
    const projectIds = new Set<string>();
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;
    for (const sid of c.memberIds) {
      const entry = inputBySessionId.get(sid);
      if (entry === undefined) continue;
      const pid = sessionToProject.get(sid);
      if (pid !== undefined) projectIds.add(pid);
      if (entry.startedAt < earliest) earliest = entry.startedAt;
      if (entry.updatedAt > latest) latest = entry.updatedAt;
    }
    const topicId = `topic_local_${c.id}`;
    topics.push({
      id: topicId,
      // Emergent labels keep the `~` prefix convention so the viewer can
      // distinguish them from named topics at render time.
      displayName: `~${c.label}`,
      sessionIds: [...c.memberIds],
      projectIds: [...projectIds],
      firstSeenAt: new Date(earliest === Number.POSITIVE_INFINITY ? now : earliest).toISOString(),
      lastSeenAt: new Date(latest === Number.NEGATIVE_INFINITY ? now : latest).toISOString(),
    });
    for (const sid of c.memberIds) {
      sessionToTopics.set(sid, [topicId]);
    }
  }

  return { topics, sessionToTopics, consideredCount: inputs.length };
}
