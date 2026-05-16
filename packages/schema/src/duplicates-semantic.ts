/**
 * Semantic-duplicate sidecar shape (v2 §5 A.1 / acceptance #3).
 *
 * Pairs the embedding sidecar with a cosine-similarity clustering pass.
 * Distinct from `duplicates.exact.json` (which keys on first-human text);
 * semantic dedup finds sessions that ask the same thing in different
 * words.
 */

export interface DuplicatesSemanticCluster {
  id: string;
  /** Member session ids (ordered by similarity to centroid, descending). */
  sessionIds: readonly string[];
  /** Session id whose embedding is closest to the cluster centroid. */
  centroidSessionId: string;
  /** Mean pairwise cosine similarity within the cluster. */
  meanSimilarity: number;
}

export interface DuplicatesSemanticFile {
  version: 1;
  generatedAt: number;
  /** Cosine threshold used (default 0.85). */
  threshold: number;
  clusters: readonly DuplicatesSemanticCluster[];
}
