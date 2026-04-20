import { createStore, get, set, del, type UseStore } from 'idb-keyval';
import type { UploadedCloudData } from '../types.js';

/**
 * Browser-tier persistence for the user-uploaded cloud-export ZIP.
 *
 * The viewer runs in two deployment shapes — static-only (GitHub Pages, CDN,
 * `file://`) and the local Astro server. The uploaded archive is the same
 * shape in both: a Map of conversations parsed entirely client-side. This
 * module persists it to IndexedDB so a page refresh doesn't drop the user's
 * upload on the floor — independent of which deployment is serving the
 * static assets.
 *
 * Why IndexedDB and not localStorage:
 *   - Real cloud exports run into MBs; localStorage caps at ~5MB and is sync.
 *   - `structuredClone` (which IDB uses) preserves `Map` natively, so the
 *     `conversationsById` field stores as-is — no JSON.stringify dance.
 *
 * DB layout (single key, single store): the IndexedDB devtools panel shows
 * `chat-arch` → `uploaded-cloud-data` → key `archive`. Naming matches the
 * `chat-arch:` localStorage prefix convention so it is visually grouped.
 */

const DB_NAME = 'chat-arch';
const STORE_NAME = 'uploaded-cloud-data';
const KEY = 'archive';

let cachedStore: UseStore | null = null;
function storeHandle(): UseStore {
  if (!cachedStore) cachedStore = createStore(DB_NAME, STORE_NAME);
  return cachedStore;
}

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/** Shallow runtime guard so a corrupt entry can't poison the viewer mount.
 *  Validates the fields downstream code actually iterates — if `sessions` is
 *  missing or `schemaVersion` isn't numeric, `effectiveManifest` /
 *  `mergeUploads` will throw on first render. Treating partial rows as a
 *  miss recovers gracefully (user re-uploads). */
function isUploadedCloudData(v: unknown): v is UploadedCloudData {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const manifest = o['manifest'];
  if (!manifest || typeof manifest !== 'object') return false;
  const m = manifest as Record<string, unknown>;
  if (typeof m['schemaVersion'] !== 'number') return false;
  if (!Array.isArray(m['sessions'])) return false;
  if (!m['counts'] || typeof m['counts'] !== 'object') return false;
  if (!(o['conversationsById'] instanceof Map)) return false;
  if (typeof o['sourceLabel'] !== 'string') return false;
  return true;
}

/**
 * Read the persisted archive, or `null` if none, IDB is unavailable, or the
 * stored value fails the shallow shape check (treated as a soft miss).
 */
export async function loadUploadedData(): Promise<UploadedCloudData | null> {
  if (!indexedDbAvailable()) return null;
  try {
    const v = await get<unknown>(KEY, storeHandle());
    if (!isUploadedCloudData(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Persist the archive. Failures (quota exceeded, private-mode wipes,
 * IDB disabled) are non-fatal: surfaced via `console.warn` so a developer
 * can diagnose, but the in-memory state continues to work for the session.
 */
export async function saveUploadedData(data: UploadedCloudData): Promise<void> {
  if (!indexedDbAvailable()) return;
  try {
    await set(KEY, data, storeHandle());
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('chat-arch: failed to persist uploaded archive', err);
    }
  }
}

/** Remove the persisted archive. Safe to call when none exists. */
export async function clearUploadedData(): Promise<void> {
  if (!indexedDbAvailable()) return;
  try {
    await del(KEY, storeHandle());
  } catch {
    // best-effort wipe
  }
}

/** Test-only: forget the cached store handle so a fresh DB can be opened. */
export function _resetStoreForTest(): void {
  cachedStore = null;
}
