/**
 * Blog-draft pipeline shapes (v2 §5 Layer D extension).
 *
 * The pipeline runs in two passes:
 *   1. `BlogCandidate` selection — cluster high-discoveryScore sessions,
 *      score by narrative arc + F-audit verdict + novelty vs existing site.
 *   2. `BlogDraftMeta` — per-draft metadata after generation + F-audit.
 *      Each draft itself is a markdown file at
 *      `analysis/blog-drafts/{slug}.md`; this struct is the index.
 */

export interface BlogCandidate {
  id: string;
  /** Member session ids in the cluster, ordered by discoveryScore desc. */
  clusterSessionIds: readonly string[];
  meanDiscoveryScore: number;
  /** null when no audit results exist for any member session. */
  meanAuditPassRate: number | null;
  /** Number of days between earliest and latest session in the cluster. */
  spanDays: number;
  /** 0..1; 1 = no overlap with existing posts on the user's site. */
  noveltyScore: number;
  /** Composite ranking score. Higher = better candidate. */
  score: number;
  /**
   * Optional human-readable title fragment for the draft prompt
   * (typically the centroid session's title, lightly cleaned).
   */
  workingTitle: string;
}

export interface BlogCandidatesFile {
  version: 1;
  generatedAt: number;
  /** Threshold used for cluster admission (cosine, default 0.78). */
  clusterThreshold: number;
  /** Threshold used for discoveryScore admission (default 0.7). */
  discoveryScoreThreshold: number;
  candidates: readonly BlogCandidate[];
}

export interface BlogDraftAuditSummary {
  totalClaims: number;
  passed: number;
  failed: number;
  inconclusive: number;
  /** passed / max(totalClaims, 1). */
  passRate: number;
}

export interface BlogDraftMeta {
  /** YYYY-MM-DD-slug-form filename stem. */
  slug: string;
  generatedAt: number;
  candidateId: string;
  /** Session ids cited inline via `[SID:...]` in the draft body. */
  citedSessionIds: readonly string[];
  audit: BlogDraftAuditSummary;
  /** Relative path under `analysis/` (e.g. `blog-drafts/2026-05-16-foo.md`). */
  draftPath: string;
  /** Plain-text title rendered from the first H1 of the draft. */
  title: string;
}

export interface BlogDraftsIndexFile {
  version: 1;
  generatedAt: number;
  drafts: readonly BlogDraftMeta[];
}
