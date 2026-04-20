import { createStore, get, set, del, entries, clear, type UseStore } from 'idb-keyval';

/**
 * IndexedDB persistence for benchmark-harness results.
 *
 * Dedicated database `chat-arch-bench-results` — deliberately separate
 * from the production `chat-arch-semantic-labels` DB. Sharing would be
 * a correctness bug:
 *
 *   1. `semanticLabelsStore` uses a singleton `KEY = 'active'` against
 *      one store (the production bundle's "current result"). Writing
 *      multiple per-config entries into that store would require a
 *      schema-upgrade dance idb-keyval doesn't expose — and if we
 *      reused the `active` key we'd clobber the production result.
 *
 *   2. `isSemanticLabelsBundle` rejects anything without `version: 3`,
 *      which benchmark rows won't have — they carry their own shape.
 *      A malformed read would return null, but a write to the wrong
 *      store leaves the production DB polluted with shapes the
 *      production loader distrusts.
 *
 * Keyed by `${modelId}:${pooling}:${clusterConfig}:${postproc}` so a
 * rerun of an individual row overwrites just that entry. The harness
 * lists all entries at mount time so the UI can show "row X completed
 * previously on <date>" without re-running.
 *
 * Schema version on the entry (`version: 1`) lets us migrate later
 * without wiping the database.
 */

const DB_NAME = 'chat-arch-bench-results';
const STORE_NAME = 'bench-results';

export interface BenchResultRow {
  version: 1;
  /** Full matrix key: `${modelId}:${pooling}:${clusterConfig}:${postproc}`. */
  configKey: string;
  /** Decoded components for UI grouping. */
  modelId: string;
  pooling: 'cls' | 'mean';
  clusterConfig: string;
  postproc: string;
  /** ms-since-epoch when this row completed. */
  completedAt: number;
  /** Metric columns. Serializable JSON — no TypedArrays here. */
  metrics: Readonly<Record<string, number | string | null>>;
  /** Sample block: up to 3 clusters × up to 10 member titles each. */
  sample: ReadonlyArray<{
    clusterLabel: string;
    size: number;
    memberTitles: readonly string[];
  }>;
}

let cachedStore: UseStore | null = null;
function storeHandle(): UseStore {
  if (!cachedStore) cachedStore = createStore(DB_NAME, STORE_NAME);
  return cachedStore;
}

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function isBenchResultRow(v: unknown): v is BenchResultRow {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1) return false;
  if (typeof o['configKey'] !== 'string') return false;
  if (typeof o['modelId'] !== 'string') return false;
  if (o['pooling'] !== 'cls' && o['pooling'] !== 'mean') return false;
  if (typeof o['completedAt'] !== 'number') return false;
  if (typeof o['metrics'] !== 'object' || o['metrics'] === null) return false;
  if (!Array.isArray(o['sample'])) return false;
  return true;
}

export async function saveBenchResult(row: BenchResultRow): Promise<void> {
  if (!indexedDbAvailable()) return;
  await set(row.configKey, row, storeHandle());
}

export async function loadBenchResult(configKey: string): Promise<BenchResultRow | null> {
  if (!indexedDbAvailable()) return null;
  try {
    const v = await get<unknown>(configKey, storeHandle());
    if (!isBenchResultRow(v)) return null;
    return v;
  } catch {
    return null;
  }
}

export async function deleteBenchResult(configKey: string): Promise<void> {
  if (!indexedDbAvailable()) return;
  try {
    await del(configKey, storeHandle());
  } catch {
    // best-effort
  }
}

export async function listBenchResults(): Promise<BenchResultRow[]> {
  if (!indexedDbAvailable()) return [];
  try {
    const all = await entries<string, unknown>(storeHandle());
    const out: BenchResultRow[] = [];
    for (const [, value] of all) {
      if (isBenchResultRow(value)) out.push(value);
    }
    return out.sort((a, b) => a.completedAt - b.completedAt);
  } catch {
    return [];
  }
}

export async function clearBenchResults(): Promise<void> {
  if (!indexedDbAvailable()) return;
  try {
    await clear(storeHandle());
  } catch {
    // best-effort
  }
}

/** Test-only: forget the cached store handle so a fresh DB can be opened. */
export function _resetBenchResultsStoreForTest(): void {
  cachedStore = null;
}
