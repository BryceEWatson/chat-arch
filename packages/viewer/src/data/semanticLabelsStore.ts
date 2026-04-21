import { createStore, get, set, del, type UseStore } from 'idb-keyval';
import type { SemanticLabelsBundle } from './semanticClassify.js';

/**
 * IndexedDB persistence for the Phase-3 semantic-labels sidecar.
 *
 * Stored alongside — but separately from — the uploaded archive so that
 * the two can be invalidated independently:
 *   - A fresh upload invalidates labels (model needs to re-run).
 *   - A threshold change invalidates labels but NOT the upload.
 *   - A model-weight upgrade (MiniLM → BGE-small → next) invalidates
 *     labels across all stored uploads — `bundle.version` is the
 *     migration signal.
 *
 * **Why a separate database** (and not just a separate store inside the
 * same `chat-arch` DB the upload uses): idb-keyval's `createStore(db,
 * store)` opens the named DB at version 1 and defines exactly the store
 * passed in. If the DB already exists at v1 with a *different* store
 * (the original `uploaded-cloud-data`), a subsequent `createStore`
 * call for a new store name silently succeeds at the openDB level but
 * every transaction against the new store throws
 * `"One of the specified object stores was not found"` because v1's
 * schema never declared it. Bumping the version requires a custom
 * `openDB`-with-upgrade dance that idb-keyval doesn't expose, so the
 * pragmatic fix is one DB per store. Costs us a row in the IDB
 * devtools panel; in exchange, each store gets atomic schema ownership.
 *
 * The DB name keeps the `chat-arch-` prefix so it groups visually with
 * the upload DB in the devtools panel.
 */

const DB_NAME = 'chat-arch-semantic-labels';
const STORE_NAME = 'semantic-labels';
const KEY = 'active';

let cachedStore: UseStore | null = null;
function storeHandle(): UseStore {
  if (!cachedStore) cachedStore = createStore(DB_NAME, STORE_NAME);
  return cachedStore;
}

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/**
 * Runtime guard: a corrupt or schema-drifted bundle must not poison the
 * viewer mount. We validate enough of the surface that downstream
 * rendering code can trust the shape without per-field re-checks.
 */
function isSemanticLabelsBundle(v: unknown): v is SemanticLabelsBundle {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  // Only v4 bundles are valid now. Earlier versions are invalidated on
  // purpose:
  //   v1 — first-human-message-only, single vector per session. Scores
  //        aren't comparable to v2's max-sim-across-chunks model.
  //   v2 — MiniLM-L6-v2 + mean pooling. Different embedder manifold
  //        from v3's BGE-small-en-v1.5 + CLS pooling; mixing the
  //        similarity numbers would mislead the UI. Silent drop →
  //        re-run. v2's model weights are a different HF repo from
  //        v3's, so returning users WILL pay a fresh download (~36 MB
  //        q4f16) on the upgrade, not just re-embedding.
  //   v3 — lacks `analyzedSessionIds`. The STALE banner derived its
  //        signal from `labels.size < totalSessions`, which false-
  //        positived whenever the classifier legitimately skipped
  //        no-content sessions. v4 adds the set so "corpus grew" can
  //        be distinguished from "run complete, some inputs had
  //        nothing to embed." Re-running on v4 produces the same
  //        labels as v3 at the same embedder config, so the
  //        one-time re-run cost is just recomputation, not a
  //        fresh model download.
  if (o['version'] !== 4) return false;
  if (typeof o['modelId'] !== 'string') return false;
  if (typeof o['generatedAt'] !== 'number') return false;
  if (o['device'] !== 'webgpu' && o['device'] !== 'wasm') return false;
  if (o['mode'] !== 'classify' && o['mode'] !== 'discover') return false;
  if (!(o['labels'] instanceof Map)) return false;
  if (!(o['analyzedSessionIds'] instanceof Set)) return false;
  const options = o['options'];
  if (!options || typeof options !== 'object') return false;
  const opt = options as Record<string, unknown>;
  if (typeof opt['threshold'] !== 'number') return false;
  if (typeof opt['margin'] !== 'number') return false;
  return true;
}

export async function loadSemanticLabels(): Promise<SemanticLabelsBundle | null> {
  if (!indexedDbAvailable()) return null;
  try {
    const v = await get<unknown>(KEY, storeHandle());
    if (!isSemanticLabelsBundle(v)) return null;
    return v;
  } catch {
    return null;
  }
}

export async function saveSemanticLabels(bundle: SemanticLabelsBundle): Promise<void> {
  if (!indexedDbAvailable()) {
    // Embedded contexts without IDB (some sandboxed WebViews, very
    // old browsers) — no-op rather than throw, since the in-session
    // experience still works without persistence. The caller's
    // success log will still fire, which is technically a lie about
    // persistence; document this trade-off here so a future debugger
    // can find it. Swap to `throw` if the silent no-op causes confusion.
    return;
  }
  // No try/catch: let actual save errors propagate so the caller can
  // surface them in the activity log (previously this swallowed errors
  // into a console.warn the user never saw, leaving "topics gone after
  // refresh" indistinguishable from "save silently failed").
  await set(KEY, bundle, storeHandle());
}

export async function clearSemanticLabels(): Promise<void> {
  if (!indexedDbAvailable()) return;
  try {
    await del(KEY, storeHandle());
  } catch {
    // best-effort wipe
  }
}

/** Test-only: forget the cached store handle so a fresh DB can be opened. */
export function _resetSemanticLabelsStoreForTest(): void {
  cachedStore = null;
}
