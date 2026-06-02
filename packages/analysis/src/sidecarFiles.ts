/**
 * Sidecar file wrappers — the thin `*File` / `*Bundle` envelope types for
 * the analysis sidecars the viewer fetches at runtime
 * (`analysis/*.json`).
 *
 * Phase 3 of the "Centralize data processing" refactor moved these
 * VERBATIM out of `packages/viewer/src/data/insightsLoader.ts` and
 * `trendsLoader.ts`. The payload types they wrap (`ItsResult`,
 * `KnowledgeDebtCluster`, `ArchetypeCentroid`, `SkillCurveResult`, …)
 * already live in this package, so the envelope shape belongs here too —
 * one home for "what an analysis sidecar looks like on disk."
 *
 * The *fetcher* functions (`loadInsightsBundle`, `loadTrendsBundle`, the
 * per-file loaders + their `validate*` guards) intentionally STAY
 * viewer-side: they do browser `fetch` I/O, which must not enter this
 * React-free / Node-free kernel package. The loaders re-import these
 * types from here.
 *
 * Each wrapper is the shape emitted by a Wave-3 builder in
 * `packages/exporter/src/analysis/`:
 *
 *   INSIGHTS surface (insightsLoader.ts):
 *     - `analysis/config-history.json`   — `configHistory.ts`
 *     - `analysis/its-analysis.json`     — `itsBuilder.ts`
 *     - `analysis/knowledge-debt.json`   — `knowledgeDebtBuilder.ts`
 *     - `analysis/reflexive.json`        — `reflexiveBuilder.ts`
 *
 *   TRENDS surface (trendsLoader.ts):
 *     - `analysis/project-trajectories.json`
 *     - `analysis/archetypes.json`
 *     - `analysis/surface-comparison.json`
 *     - `analysis/skill-curves.json`
 */

import type {
  ArchetypeCentroid,
  ItsConfigCommit,
  ItsResult,
  KnowledgeDebtCluster,
  ReflexiveResult,
  SkillCurveResult,
} from './index.js';

// ─────────────────────────────────────────────────────────────────────
// INSIGHTS sidecars (was insightsLoader.ts)
// ─────────────────────────────────────────────────────────────────────

export interface ConfigHistoryFile {
  version: 1;
  generatedAt: number;
  commits: readonly ItsConfigCommit[];
}

export interface ItsFile {
  version: 1;
  generatedAt: number;
  windowDays: number;
  results: readonly ItsResult[];
}

export interface KnowledgeDebtFile {
  version: 1;
  generatedAt: number;
  confidence: 'high' | 'low' | 'mixed' | 'none';
  clusters: readonly KnowledgeDebtCluster[];
}

export interface ReflexiveFile {
  version: 1;
  generatedAt: number;
  result: ReflexiveResult;
  methodology: {
    covariates: readonly string[];
    notes: string;
  };
}

export interface InsightsBundle {
  configHistory: ConfigHistoryFile | null;
  its: ItsFile | null;
  knowledgeDebt: KnowledgeDebtFile | null;
  reflexive: ReflexiveFile | null;
}

// ─────────────────────────────────────────────────────────────────────
// TRENDS sidecars (was trendsLoader.ts)
// ─────────────────────────────────────────────────────────────────────

export type TrajectoryClassification =
  | 'stalling'
  | 'stalled-finished'
  | 'accelerating'
  | 'flat';

export interface ProjectTrajectoryEntry {
  projectId: string;
  projectName: string;
  classification: TrajectoryClassification;
  totalSessions: number;
  recentSessions: number;
  slope: number | null;
  ci: { low: number; high: number } | null;
  blockLength: number | null;
  bootstrapStatus: 'ok' | 'series-too-short';
  series: readonly number[];
}

export interface ProjectTrajectoriesFile {
  version: number;
  generatedAt: number;
  rollingWindow: number;
  projects: readonly ProjectTrajectoryEntry[];
}

export interface ArchetypesFile {
  version: number;
  generatedAt: number;
  archetypeVersion: number;
  centroids: readonly ArchetypeCentroid[];
  assignments: Record<string, string | null>;
  silhouette: number;
  chosenK: number;
  scannedSessionIds: readonly string[];
}

export interface SurfaceCell {
  key: string;
  source: string;
  archetypeId: string;
  n: number;
  good: number;
  pHat: number;
  ci: { low: number; high: number };
  meetsDisplayN: boolean;
}

export interface SurfacePairwiseTest {
  a: string;
  b: string;
  pValue: number;
  pValueAdjusted: number;
  significant: boolean;
  /**
   * Which test produced `pValue` — `'z-test'` (pooled two-proportion z,
   * large-sample) or `'fisher-exact'` (two-sided Fisher's exact,
   * small-sample where any expected cell count < 5). The viewer's
   * methodology disclosure can surface which rule fired per pair so
   * users see why a small-cell pair's p-value differs from the naive
   * z-test they might have computed.
   */
  testMethod: 'z-test' | 'fisher-exact';
}

export interface SurfaceComparisonFile {
  version: number;
  generatedAt: number;
  familyAlpha: number;
  cells: readonly SurfaceCell[];
  pairwise: readonly SurfacePairwiseTest[];
}

export interface SkillCurvesFile {
  version: number;
  generatedAt: number;
  minWeeksPresent: number;
  bhFdrAlpha: number;
  results: readonly SkillCurveResult[];
}

export interface TrendsBundle {
  trajectories: ProjectTrajectoriesFile | null;
  archetypes: ArchetypesFile | null;
  surfaceComparison: SurfaceComparisonFile | null;
  skillCurves: SkillCurvesFile | null;
}
