/**
 * Stream J #6 — exports manifest loader.
 *
 * Fetches `analysis/exports/manifest.json` (written by the Export
 * submodule via `packages/exporter/src/export/manifest.ts`). Returns
 * null on 404 / network failure / parse failure so the panel can
 * render an empty state gracefully.
 */

const GENERATE_EXPORTS_PATH = '/api/generate-exports';

/** Mirrors `ExportManifestEntry` from `packages/exporter/src/export/manifest.ts`. */
export interface ExportManifestEntry {
  id: string;
  kind: 'post-mortem' | 'knowledge-debt' | 'other';
  relativePath: string;
  generatedAt: string;
  title?: string;
  tags?: readonly string[];
}

export interface ExportManifest {
  manifestVersion: number;
  generatedAt: string;
  entries: readonly ExportManifestEntry[];
}

function joinUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const tail = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return `${root}/${tail}`;
}

export async function loadExportsManifest(
  baseUrl: string,
): Promise<ExportManifest | null> {
  const url = joinUrl(baseUrl, 'analysis/exports/manifest.json');
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as ExportManifest;
    if (!body || !Array.isArray(body.entries)) return null;
    return body;
  } catch {
    return null;
  }
}

export interface GenerateExportsOptions {
  /** Kinds to generate (subset of the checklist). */
  kinds?: ReadonlyArray<'post-mortem' | 'knowledge-debt' | 'decision-log' | 'trust-report'>;
  /** Date range filter (ms epoch). */
  dateFrom?: number;
  dateTo?: number;
  /** Project filter. */
  projectId?: string;
  /** Archetype filter. */
  archetypeId?: string;
  /** Outcome-percentile filter (0..100). */
  outcomePercentile?: number;
}

export interface GenerateExportsResponse {
  ok: boolean;
  outputDir?: string;
  count?: number;
  error?: string;
}

/**
 * POST `/api/generate-exports`. Mirrors the `mineCorrectionsClient.ts`
 * call shape: header-tagged, JSON body, returns a small summary
 * payload. Returns a structured error result rather than throwing,
 * so the ExportMode UI can surface failures inline.
 */
export async function startGenerateExports(
  opts: GenerateExportsOptions = {},
): Promise<GenerateExportsResponse> {
  try {
    const res = await fetch(GENERATE_EXPORTS_PATH, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'chat-arch-generate-exports',
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `generate-exports failed (status ${res.status}): ${text}`,
      };
    }
    const body = (await res.json()) as GenerateExportsResponse;
    return body;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe the generate-exports endpoint. Returns false when absent
 * (hosted static build); the panel hides the GENERATE button.
 */
export async function probeGenerateExports(): Promise<boolean> {
  try {
    const res = await fetch(GENERATE_EXPORTS_PATH, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
