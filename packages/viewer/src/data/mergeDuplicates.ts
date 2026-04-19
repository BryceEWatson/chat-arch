/**
 * Viewer-side merge of `duplicates.exact.json` and `duplicates.semantic.json`.
 *
 * Phase 6 Decision 14 (`[R-D14]`) + Decision 1 precedence rule:
 *
 *   - Decision 1 says filenames never collide across tiers. The exporter
 *     writes `duplicates.exact.json` only; Phase 7's analyzer will later
 *     write `duplicates.semantic.json`. Both files can coexist.
 *
 *   - When a session appears in BOTH files, the user should see ONE chip
 *     badged `DUP · exact+semantic` and ONE merged cluster card in
 *     CONSTELLATION — not two overlapping cards with the same member.
 *     The merge happens here (at render time in the viewer), NEVER in the
 *     exporter. This preserves the never-collide-filenames rule.
 *
 * Merge algorithm (set-cover over cluster graph):
 *   1. Build a graph where each cluster is a node and edges connect
 *      clusters that share any session.
 *   2. Compute connected components — each component becomes ONE merged
 *      cluster. The union of member sessions defines the merged
 *      `sessionIds`; the union of origin tiers (`exact` ∪ `semantic`)
 *      defines the `kind`.
 *   3. Stable id/hash/sampleText from the first-seen cluster in each
 *      component (deterministic for screenshot tests).
 *
 * Phase 6 reality: `duplicates.semantic.json` is always absent, so
 * every merged cluster has `kind = 'exact'` and is a 1:1 pass-through.
 * The test fixture exercises the "both present" path so Phase 7 Just
 * Works when the file drops.
 */

export interface DuplicateCluster {
  id: string;
  hash: string;
  sessionIds: readonly string[];
  sampleText: string;
}

export interface DuplicatesFile {
  version: number;
  tier: 'browser' | 'local';
  generatedAt: number;
  clusters: readonly DuplicateCluster[];
}

export type MergedClusterKind = 'exact' | 'semantic' | 'exact+semantic';

export interface MergedDuplicateCluster {
  /** Stable id from the first-seen origin cluster in this component. */
  id: string;
  /** Hash from the first-seen origin cluster. */
  hash: string;
  /** Sample text from the first-seen origin cluster. */
  sampleText: string;
  /** Union of session ids across every cluster in this component. */
  sessionIds: readonly string[];
  /** Which tier(s) contributed to this cluster. Drives the chip suffix. */
  kind: MergedClusterKind;
  /** Origin-cluster ids that were merged into this one (debug aid). */
  originClusterIds: readonly string[];
}

type Origin = 'exact' | 'semantic';

interface TaggedCluster {
  origin: Origin;
  cluster: DuplicateCluster;
}

/**
 * Parse an unknown JSON payload into a `DuplicatesFile` (tolerant). Returns
 * `null` when the payload is missing, malformed, or lacks a usable
 * `clusters` array — this is the common "file absent" case, not an error.
 */
export function parseDuplicatesFile(
  payload: unknown,
  tier: 'browser' | 'local',
): DuplicatesFile | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj['clusters'])) return null;
  const clusters: DuplicateCluster[] = [];
  for (const c of obj['clusters']) {
    if (!c || typeof c !== 'object') continue;
    const cc = c as Record<string, unknown>;
    if (
      typeof cc['id'] !== 'string' ||
      typeof cc['hash'] !== 'string' ||
      !Array.isArray(cc['sessionIds']) ||
      typeof cc['sampleText'] !== 'string'
    ) {
      continue;
    }
    const ids = (cc['sessionIds'] as unknown[]).filter((x): x is string => typeof x === 'string');
    clusters.push({
      id: cc['id'],
      hash: cc['hash'],
      sessionIds: ids,
      sampleText: cc['sampleText'],
    });
  }
  return {
    version: typeof obj['version'] === 'number' ? obj['version'] : 1,
    tier,
    generatedAt: typeof obj['generatedAt'] === 'number' ? obj['generatedAt'] : 0,
    clusters,
  };
}

/**
 * Merge exact-cluster and semantic-cluster arrays into a single union.
 *
 * Both inputs are optional — pass `null` for a file that's absent. The
 * Phase 6 common case is `semantic === null`, which short-circuits to a
 * 1:1 pass-through over `exact`.
 */
export function mergeDuplicateClusters(
  exact: DuplicatesFile | null,
  semantic: DuplicatesFile | null,
): readonly MergedDuplicateCluster[] {
  const exactClusters = exact?.clusters ?? [];
  const semanticClusters = semantic?.clusters ?? [];

  // Fast path: semantic absent. Every exact cluster is its own merged
  // cluster with kind 'exact'. Matches Phase 6 runtime 100% of the time.
  if (semanticClusters.length === 0) {
    return exactClusters.map((c) => ({
      id: c.id,
      hash: c.hash,
      sampleText: c.sampleText,
      sessionIds: c.sessionIds,
      kind: 'exact' as const,
      originClusterIds: [c.id],
    }));
  }

  if (exactClusters.length === 0) {
    return semanticClusters.map((c) => ({
      id: c.id,
      hash: c.hash,
      sampleText: c.sampleText,
      sessionIds: c.sessionIds,
      kind: 'semantic' as const,
      originClusterIds: [c.id],
    }));
  }

  // Both present — walk the cluster graph. Node = (origin, clusterIndex).
  // Each session appears in zero or more clusters; a shared session joins
  // two clusters in the same component.
  const tagged: TaggedCluster[] = [
    ...exactClusters.map((c) => ({ origin: 'exact' as const, cluster: c })),
    ...semanticClusters.map((c) => ({ origin: 'semantic' as const, cluster: c })),
  ];

  // Index: sessionId -> list of tagged cluster indices containing it.
  const sessionToClusters = new Map<string, number[]>();
  for (let i = 0; i < tagged.length; i += 1) {
    for (const sid of tagged[i]!.cluster.sessionIds) {
      const arr = sessionToClusters.get(sid) ?? [];
      arr.push(i);
      sessionToClusters.set(sid, arr);
    }
  }

  // Union-find over tagged-cluster indices.
  const parent = new Array<number>(tagged.length);
  for (let i = 0; i < tagged.length; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r]! !== r) r = parent[r]!;
    // path compression
    let cur = x;
    while (parent[cur]! !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const [, idxs] of sessionToClusters) {
    if (idxs.length < 2) continue;
    for (let i = 1; i < idxs.length; i += 1) {
      union(idxs[0]!, idxs[i]!);
    }
  }

  // Bucket clusters by root and fold into merged clusters.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < tagged.length; i += 1) {
    const r = find(i);
    const arr = byRoot.get(r) ?? [];
    arr.push(i);
    byRoot.set(r, arr);
  }

  const out: MergedDuplicateCluster[] = [];
  // Preserve first-seen order for deterministic output: iterate tagged[] and
  // emit each component on first encounter.
  const emitted = new Set<number>();
  for (let i = 0; i < tagged.length; i += 1) {
    const r = find(i);
    if (emitted.has(r)) continue;
    emitted.add(r);
    const members = byRoot.get(r)!;
    const hasExact = members.some((m) => tagged[m]!.origin === 'exact');
    const hasSemantic = members.some((m) => tagged[m]!.origin === 'semantic');
    const kind: MergedClusterKind =
      hasExact && hasSemantic ? 'exact+semantic' : hasExact ? 'exact' : 'semantic';
    const seed = tagged[members[0]!]!.cluster;
    const unionIds = new Set<string>();
    for (const m of members) {
      for (const sid of tagged[m]!.cluster.sessionIds) unionIds.add(sid);
    }
    out.push({
      id: seed.id,
      hash: seed.hash,
      sampleText: seed.sampleText,
      sessionIds: [...unionIds],
      kind,
      originClusterIds: members.map((m) => tagged[m]!.cluster.id),
    });
  }
  return out;
}

/**
 * Build a per-session lookup that SessionCard uses to decide whether to
 * render a `DUP · …` chip. Returns null when a session is not duplicated.
 */
export interface SessionDuplicateInfo {
  cluster: MergedDuplicateCluster;
  memberCount: number;
}

export function buildSessionDuplicateIndex(
  clusters: readonly MergedDuplicateCluster[],
): Map<string, SessionDuplicateInfo> {
  const out = new Map<string, SessionDuplicateInfo>();
  for (const c of clusters) {
    for (const sid of c.sessionIds) {
      // First-cluster-wins if a session ever appears in multiple merged
      // clusters (should not happen post-union-find, but safe default).
      if (!out.has(sid)) out.set(sid, { cluster: c, memberCount: c.sessionIds.length });
    }
  }
  return out;
}
