import type {
  ArchetypeCentroid,
  SkillCurveResult,
} from '@chat-arch/analysis';

/**
 * Trends data — Stream J #4. Loads the four Phase-3 sidecars used by
 * the TRENDS surface:
 *
 *   - `analysis/project-trajectories.json`
 *   - `analysis/archetypes.json`
 *   - `analysis/surface-comparison.json`
 *   - `analysis/skill-curves.json`
 *
 * All four are best-effort: when missing or malformed, the loader
 * returns null for that slot and TrendsMode falls back to a
 * per-section empty state.
 *
 * Types are defined locally rather than imported from the exporter
 * package because the viewer doesn't import from `@chat-arch/exporter`
 * (its `exports` field only declares the root, and the analysis
 * builders live in node-only subpaths).
 */

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

function joinAnalysisUrl(baseUrl: string, filename: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/analysis/${filename}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadProjectTrajectoriesFile(
  baseUrl: string,
): Promise<ProjectTrajectoriesFile | null> {
  const body = await fetchJson<ProjectTrajectoriesFile>(
    joinAnalysisUrl(baseUrl, 'project-trajectories.json'),
  );
  if (body === null || !Array.isArray(body.projects)) return null;
  return body;
}

export async function loadArchetypesFile(
  baseUrl: string,
): Promise<ArchetypesFile | null> {
  const body = await fetchJson<ArchetypesFile>(
    joinAnalysisUrl(baseUrl, 'archetypes.json'),
  );
  if (body === null || !Array.isArray(body.centroids)) return null;
  return body;
}

export async function loadSurfaceComparisonFile(
  baseUrl: string,
): Promise<SurfaceComparisonFile | null> {
  const body = await fetchJson<SurfaceComparisonFile>(
    joinAnalysisUrl(baseUrl, 'surface-comparison.json'),
  );
  if (body === null || !Array.isArray(body.cells)) return null;
  return body;
}

export async function loadSkillCurvesFile(
  baseUrl: string,
): Promise<SkillCurvesFile | null> {
  const body = await fetchJson<SkillCurvesFile>(
    joinAnalysisUrl(baseUrl, 'skill-curves.json'),
  );
  if (body === null || !Array.isArray(body.results)) return null;
  return body;
}

/**
 * One-shot bundle fetcher. Used by ChatArchViewer to populate the
 * TRENDS surface with a single Promise.all (mirrors how Stream I
 * fetches outcomes).
 */
export async function loadTrendsBundle(baseUrl: string): Promise<TrendsBundle> {
  const [trajectories, archetypes, surfaceComparison, skillCurves] =
    await Promise.all([
      loadProjectTrajectoriesFile(baseUrl),
      loadArchetypesFile(baseUrl),
      loadSurfaceComparisonFile(baseUrl),
      loadSkillCurvesFile(baseUrl),
    ]);
  return { trajectories, archetypes, surfaceComparison, skillCurves };
}
