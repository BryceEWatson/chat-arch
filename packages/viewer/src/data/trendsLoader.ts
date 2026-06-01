import type {
  ArchetypesFile,
  ProjectTrajectoriesFile,
  SkillCurvesFile,
  SurfaceComparisonFile,
  TrendsBundle,
} from '@chat-arch/analysis';

/**
 * Trends data — Stream J #4. Loads the four sidecars used by the TRENDS
 * surface:
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
 * The wrapper *types* now live in `@chat-arch/analysis`
 * (`sidecarFiles.ts`) — Phase 3 of the "Centralize data processing"
 * refactor moved the envelope shapes next to the payloads they wrap. The
 * fetchers below STAY here: they do browser `fetch` I/O, which must not
 * enter the React-free / Node-free analysis kernel. Re-export the types
 * so existing consumers that import them from this loader keep working.
 */

export type {
  ArchetypesFile,
  ProjectTrajectoriesFile,
  ProjectTrajectoryEntry,
  SkillCurvesFile,
  SurfaceCell,
  SurfaceComparisonFile,
  SurfacePairwiseTest,
  TrajectoryClassification,
  TrendsBundle,
} from '@chat-arch/analysis';

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
