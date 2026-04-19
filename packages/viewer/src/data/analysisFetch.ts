/**
 * Parallel-fetch all `analysis/*.json` files and report tier status.
 *
 * Phase 6 decision 1 + 17 + AC14 contract:
 *   - Six Phase-7-reserved filenames are enumerated in code (exported as
 *     `PHASE_7_RESERVED_FILES` so the TierSheet component uses the same
 *     source of truth).
 *   - 404 on any of these is NOT an error — it's the default "not installed
 *     yet" state. Network / JSON-parse errors are also tolerated (we treat
 *     them as absent, never throw).
 *   - Tier-1 files (`duplicates.exact.json`, `zombies.heuristic.json`)
 *     belong to Team A (exporter). They are NOT enumerated by TierIndicator,
 *     but are fetched separately elsewhere (Team C's data plumbing).
 *
 * Returned shape (consumed by Team C via `analysisState`):
 *   - `tierStatus`: `'browser'` when zero tier-2 files present,
 *     `'browser+local'` when any tier-2 file is present. Drives the
 *     TierIndicator pill copy + palette (`[R-D17]`).
 *   - `tierPresentCount`: N in the `CORE + EXTENDED ANALYSIS (N/6)` copy.
 *   - `tierFiles`: per-filename `{present, generatedAt?}`. TierSheet
 *     enumerates all six with present/absent icon + timestamp.
 */

/**
 * The six Phase-7-reserved filenames. Viewer reads these but Phase 6 never
 * writes them. Order is intentional (stable UI ordering in TierSheet).
 */
export const PHASE_7_RESERVED_FILES = [
  'duplicates.semantic.json',
  'zombies.diagnosed.json',
  'reloops.json',
  'handoffs.json',
  'cost-diagnoses.json',
  'skill-seeds.json',
] as const;

export type Phase7ReservedFile = (typeof PHASE_7_RESERVED_FILES)[number];

/** Per-file presence + timestamp tuple. `generatedAt` is only set when present. */
export interface TierFileState {
  present: boolean;
  /** ms-since-epoch from the file's top-level `generatedAt` field, if we could read it. */
  generatedAt?: number;
}

export interface AnalysisFetchResult {
  tierStatus: 'browser' | 'browser+local';
  tierPresentCount: number;
  tierFiles: Record<string, TierFileState>;
}

/**
 * Minimal shape we read from any tier-2 file. We only need `generatedAt`
 * for TierSheet's "last generated {date}" label; everything else is
 * opaque at this layer.
 */
interface AnalysisFileHeader {
  generatedAt?: number;
}

/**
 * Fetch one file. Never throws. 404 → `{present: false}`. Parse failure →
 * `{present: false}` as well (can't trust a file we can't parse, and the
 * cold-start empty state is the safe default).
 */
async function fetchOne(url: string): Promise<TierFileState> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { present: false };
  }
  if (!res.ok) return { present: false };
  try {
    const body = (await res.json()) as AnalysisFileHeader;
    const out: TierFileState = { present: true };
    if (typeof body.generatedAt === 'number' && Number.isFinite(body.generatedAt)) {
      out.generatedAt = body.generatedAt;
    }
    return out;
  } catch {
    return { present: false };
  }
}

/**
 * Resolve `analysis/{filename}` against `dataRoot`. Mirrors `resolveDataUrl`
 * in `fetch.ts` but kept local to avoid a circular-ish dependency on the
 * manifest-fetch module.
 */
function resolveAnalysisUrl(dataRoot: string, filename: string): string {
  const root = dataRoot.endsWith('/') ? dataRoot.slice(0, -1) : dataRoot;
  return `${root}/analysis/${filename}`;
}

/**
 * Parallel-fetch all six Phase-7-reserved files. Returns `tierStatus` +
 * counts + per-file state. Never throws — caller can always consume the
 * result. Tier-1 files are NOT probed here; Team C handles those via
 * their own fetch path because they feed CONSTELLATION + COST rendering
 * directly (not the TierIndicator state).
 */
export async function fetchAnalysisTierStatus(dataRoot: string): Promise<AnalysisFetchResult> {
  const entries = await Promise.all(
    PHASE_7_RESERVED_FILES.map(async (name) => {
      const state = await fetchOne(resolveAnalysisUrl(dataRoot, name));
      return [name, state] as const;
    }),
  );
  const tierFiles: Record<string, TierFileState> = {};
  let tierPresentCount = 0;
  for (const [name, state] of entries) {
    tierFiles[name] = state;
    if (state.present) tierPresentCount += 1;
  }
  return {
    tierStatus: tierPresentCount > 0 ? 'browser+local' : 'browser',
    tierPresentCount,
    tierFiles,
  };
}
