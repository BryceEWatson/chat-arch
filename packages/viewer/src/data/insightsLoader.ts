import type {
  ConfigHistoryFile,
  InsightsBundle,
  ItsFile,
  KnowledgeDebtFile,
  ReflexiveFile,
} from '@chat-arch/analysis';

/**
 * InsightsMode sidecar loaders. The wrapper *types* now live in
 * `@chat-arch/analysis` (`sidecarFiles.ts`) — Phase 3 of the "Centralize
 * data processing" refactor moved the envelope shapes next to the
 * payloads they wrap. The fetchers below STAY here: they do browser
 * `fetch` I/O, which must not enter the React-free / Node-free analysis
 * kernel. Re-export the types so existing consumers that import them from
 * this loader keep working.
 *
 * The sidecars mirror the file shapes emitted by the Wave 3 builders in
 * `packages/exporter/src/analysis/`:
 *
 *   - `analysis/config-history.json` — `configHistory.ts`
 *   - `analysis/its-analysis.json` — `itsBuilder.ts`
 *   - `analysis/knowledge-debt.json` — `knowledgeDebtBuilder.ts`
 *   - `analysis/reflexive.json` — `reflexiveBuilder.ts`
 *
 * Each loader returns `null` for missing / unreadable / unparseable
 * files. Treat absent files the same as "kernel hasn't run yet" — the
 * mode renders the empty state for that sub-section.
 */

export type {
  ConfigHistoryFile,
  InsightsBundle,
  ItsFile,
  KnowledgeDebtFile,
  ReflexiveFile,
} from '@chat-arch/analysis';

function joinAnalysisUrl(baseUrl: string, filename: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/analysis/${filename}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
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

function validateConfigHistory(
  body: ConfigHistoryFile | null,
): ConfigHistoryFile | null {
  if (body === null) return null;
  if (body.version !== 1) return null;
  if (!Array.isArray(body.commits)) return null;
  return body;
}

function validateIts(body: ItsFile | null): ItsFile | null {
  if (body === null) return null;
  if (body.version !== 1) return null;
  if (!Array.isArray(body.results)) return null;
  if (typeof body.windowDays !== 'number') return null;
  return body;
}

function validateKnowledgeDebt(
  body: KnowledgeDebtFile | null,
): KnowledgeDebtFile | null {
  if (body === null) return null;
  if (body.version !== 1) return null;
  if (!Array.isArray(body.clusters)) return null;
  return body;
}

function validateReflexive(body: ReflexiveFile | null): ReflexiveFile | null {
  if (body === null) return null;
  if (body.version !== 1) return null;
  if (body.result === null || typeof body.result !== 'object') return null;
  return body;
}

/** Fetch all four insights sidecars in parallel and bundle them. */
export async function loadInsightsBundle(baseUrl: string): Promise<InsightsBundle> {
  const [configHistory, its, knowledgeDebt, reflexive] = await Promise.all([
    fetchJson<ConfigHistoryFile>(joinAnalysisUrl(baseUrl, 'config-history.json')),
    fetchJson<ItsFile>(joinAnalysisUrl(baseUrl, 'its-analysis.json')),
    fetchJson<KnowledgeDebtFile>(joinAnalysisUrl(baseUrl, 'knowledge-debt.json')),
    fetchJson<ReflexiveFile>(joinAnalysisUrl(baseUrl, 'reflexive.json')),
  ]);
  return {
    configHistory: validateConfigHistory(configHistory),
    its: validateIts(its),
    knowledgeDebt: validateKnowledgeDebt(knowledgeDebt),
    reflexive: validateReflexive(reflexive),
  };
}
