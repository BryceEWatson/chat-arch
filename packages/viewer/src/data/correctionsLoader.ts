import type { CorrectionsFile } from '@chat-arch/schema';

/**
 * Load a JSON sidecar from the analysis/ directory. Returns `null` for
 * 404 / network failure / parse failure — the panel treats absent files
 * the same as "pipeline hasn't run yet", which is the safe default.
 *
 * Sibling of `analysisFetch.ts` but typed against the corrections shape
 * because the panel cares about more than `generatedAt`.
 */
async function fetchCorrectionsJson(url: string): Promise<CorrectionsFile | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as CorrectionsFile;
    return body;
  } catch {
    return null;
  }
}

function joinAnalysisUrl(baseUrl: string, filename: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/analysis/${filename}`;
}

/** Fetch `analysis/corrections.json`. */
export async function loadCorrectionsFile(baseUrl: string): Promise<CorrectionsFile | null> {
  return fetchCorrectionsJson(joinAnalysisUrl(baseUrl, 'corrections.json'));
}

/**
 * Fetch `analysis/correction-candidates.json`. Same shape as `corrections.json`
 * but contains pre-classification heuristic hits — used by the panel to
 * tell the user "N candidates ready, click MINE to classify them" before
 * the LLM pass has been run.
 */
export async function loadCorrectionCandidatesFile(
  baseUrl: string,
): Promise<CorrectionsFile | null> {
  return fetchCorrectionsJson(joinAnalysisUrl(baseUrl, 'correction-candidates.json'));
}
