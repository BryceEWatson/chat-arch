import type { DecisionsFile } from '@chat-arch/schema';

/**
 * Fetcher for `analysis/decisions.json` (Stream J #1 / Phase 2 #1).
 *
 * Same posture as `correctionsLoader.ts`: returns null on 404 / network
 * failure / parse failure so the consuming surface can render an empty
 * state (the pipeline simply hasn't run yet). Never throws.
 */
function joinAnalysisUrl(baseUrl: string, filename: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/analysis/${filename}`;
}

export async function loadDecisionsFile(
  baseUrl: string,
): Promise<DecisionsFile | null> {
  const url = joinAnalysisUrl(baseUrl, 'decisions.json');
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as DecisionsFile;
    if (!body || !Array.isArray(body.decisions)) return null;
    return body;
  } catch {
    return null;
  }
}
