/**
 * Per-project narrative-mining sidecar shapes — V1 (feature: narrative-mining).
 *
 * The narrative-mining pipeline runs as SCAN chain step 6 (after
 * `/mine-persona`). Two on-disk artifacts under
 * `apps/standalone/public/chat-arch-data/analysis/`:
 *
 *   - `narrative-candidates.json` — Stage 1, deterministic per-project
 *     candidate-evidence pool, pre-bucketed by recency quartile
 *     (`founding` / `mid-early` / `mid-late` / `recent`). Input to
 *     Stage 2.
 *   - `narratives.json` — pre-existing file. V1 adds two additive
 *     OPTIONAL top-level fields (`thresholds` snapshot + `skipped[]`)
 *     and a new family of rows with `attributedTo: 'llm-derived'`.
 *
 * Per-project sub-agents read `narrative-candidates.json`; the
 * `/mine-narratives` skill writes LLM-derived rows back into the
 * shared `narratives.json` via the `mergeNarrativeFamilies` helper.
 *
 * PII posture: every emitted candidate carries a verbatim session
 * title + preview/summary excerpt. Same surface as
 * `persona-candidates.json` — gitignored under the existing
 * `apps/standalone/public/chat-arch-data/*` wildcard.
 */

import type { Narrative } from './narrative.js';

/** Four recency quartiles. Mirrors the persona-mining time buckets. */
export type NarrativeBucket = 'founding' | 'mid-early' | 'mid-late' | 'recent';

/**
 * One per-session candidate emitted by Stage 1. Carries the per-session
 * payload Stage 2 sub-agents need to recognize durable themes (richer
 * than the `Narrative.evidence[]` shape because it also gives the
 * sub-agent sentiment scoring + outcome markers per session).
 */
export interface NarrativeCandidate {
  sessionId: string;
  /** ms since epoch — used by Stage 2 to anchor "this happened when". */
  updatedAt: number;
  /** Verbatim session title (may be the fallback id). */
  title: string;
  /** Verbatim preview excerpt — truncated to a short prefix. */
  previewExcerpt: string;
  /** Verbatim summary excerpt — truncated to a short prefix. */
  summaryExcerpt: string;
  /** Polarity from `scoreSentiment` over title+preview+summary. */
  sentimentPolarity: 'positive' | 'negative' | 'neutral';
  /** `max(positiveHits, negativeHits)` from `scoreSentiment`. */
  sentimentStrength: number;
  /**
   * Outcome marker tokens detected in the session text (shipped,
   * merged, broken, failed, etc.). Used by Stage 2 to anchor
   * sentiment-polarization claims.
   */
  outcomeMarkers: readonly string[];
}

/** One project's stratified-by-recency candidate set. */
export interface NarrativeCandidateProject {
  projectId: string;
  projectName: string;
  /** Total sessions in this project across all sources. */
  sessionsTotal: number;
  /** Sessions Stage 1 actually sampled (≤ THRESHOLDS.narrative.maxSessionsForCorpus). */
  sessionsSampled: number;
  /** Sessions that produced ≥1 candidate. */
  sessionsWithCandidates: number;
  /** Earliest sampled-session updatedAt (ms since epoch); null when empty. */
  earliestSampledAt: number | null;
  /** Latest sampled-session updatedAt (ms since epoch); null when empty. */
  latestSampledAt: number | null;
  /** Per-bucket candidate arrays. */
  candidatesByBucket: Record<NarrativeBucket, readonly NarrativeCandidate[]>;
}

/** `analysis/narrative-candidates.json` shape. */
export interface NarrativeCandidatesFile {
  /** Wire-format version of the file shape itself. */
  version: 1;
  /** Bumped when the candidate extractor regex/policy changes. */
  heuristicVersion: number;
  /** ms since epoch — write time. */
  generatedAt: number;
  thresholds: {
    minSessionsForLlm: number;
    maxSessionsForCorpus: number;
    maxLlmUsdPerProject: number;
    evidenceMinPerNarrative: number;
  };
  projects: readonly NarrativeCandidateProject[];
}

/**
 * Per-project skip row attached to `narratives.json`'s top-level
 * `skipped[]` field. Enumerated `status` values:
 *
 *   - `insufficient-corpus` — sessionsTotal < minSessionsForLlm
 *   - `budget-exceeded` — first Stage-2 sub-agent landed over the
 *     per-project USD cap
 *   - `no-durable-themes` — synthesis returned zero narratives (all
 *     buckets emitted `bucketEmpty: true`)
 *   - `synthesis-failed` — malformed-JSON retry exhausted; deterministic
 *     rows preserved
 *   - `concurrent-rescan-aborted` — CAS mismatch on `generatedAt` after
 *     a retry; the rescan's write is canonical
 */
export type SkippedRowStatus =
  | 'insufficient-corpus'
  | 'budget-exceeded'
  | 'no-durable-themes'
  | 'synthesis-failed'
  | 'concurrent-rescan-aborted';

export interface SkippedRow {
  projectId: string;
  status: SkippedRowStatus;
  reason: string;
}

/**
 * Snapshot of `THRESHOLDS.narrative.*` values written into
 * `narratives.json` so the viewer can disclose the thresholds it was
 * emitted under. Additive optional top-level field — readers fall back
 * to live `THRESHOLDS.narrative.*` when the snapshot is absent.
 */
export interface NarrativeThresholdsSnapshot {
  minSessionsForLlm: number;
  maxSessionsForCorpus: number;
  minPerProject: number;
  maxPerProject: number;
  evidenceMinPerNarrative: number;
  maxLlmUsdPerProject: number;
}

/**
 * `analysis/narratives.json` file-level shape — V1 additive optional
 * fields (`thresholds`, `skipped[]`) layered onto the existing record
 * set. NO file-level schemaVersion bump (existing readers ignore
 * unknown top-level keys; `EXPORTER_VERSION` 1.6.0 → 1.7.0 is the
 * cutover marker).
 *
 * Unknown future top-level keys round-trip through writers via
 * `buildNarrativesFileObject`'s `_passthrough` opt.
 */
export interface NarrativesFile {
  generatedAt: number | string;
  exporterVersion?: string;
  /** V1 NEW. Optional. Readers fall back to live `THRESHOLDS.narrative.*`. */
  thresholds?: NarrativeThresholdsSnapshot;
  narratives: readonly Narrative[];
  /** V1 NEW. Optional. Absent / empty means "no skips this run". */
  skipped?: readonly SkippedRow[];
}
