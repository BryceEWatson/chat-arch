/**
 * localStorage memo for the last-known-good (device, dtype) embed combo.
 *
 * Why localStorage and not IndexedDB: this is a single tiny JSON object
 * read synchronously at the start of `runSemanticAnalysis` to pick the
 * initial spawn config. IndexedDB's async API would force the spawn to
 * await an IDB read every time, adding a frame or two of latency for
 * something that fits in a localStorage entry. The cost (synchronous,
 * ~5ms) is the right shape for the use case (read once per analysis,
 * write once per analysis).
 *
 * Why memoize: the WebGPU init ladder walks q4f16 → fp16 → fp32 → wasm
 * on first run. On hardware where q4f16 aborts (NVIDIA + D3D12 + ORT
 * 1.22-dev — see `embedWorker.ts` docblock), every analysis pays
 * ~1-2s spawning the doomed q4f16 attempt before respawning to the
 * working dtype. Memoizing skips straight to what worked last time;
 * if that combo later breaks (driver update, etc.) the cascade clears
 * the memo and falls through normally.
 *
 * Schema versioning: the key includes `-v1` so we can migrate later
 * without orphaning stale entries that don't match a new schema.
 */

// Uses the `chat-arch:` colon-prefix (not the file's `chat-arch.`
// dot-prefix used elsewhere) because NuclearReset's wipe targets exactly
// `localStorage` keys with `chat-arch:` — matching that prefix means a
// kitchen-sink reset clears this memo too, keeping the "what did I use
// last?" state consistent with everything else the user just nuked.
const KEY = 'chat-arch:embed-device-pref-v1';

export interface EmbedDevicePref {
  device: 'webgpu' | 'wasm';
  /**
   * The dtype that succeeded last time. `'q8'` is the WASM dtype; the
   * three WebGPU variants (`'q4f16'`, `'fp16'`, `'fp32'`) cover the
   * speed/compatibility tradeoff space documented in
   * `embedClient.ts`'s `forceWebgpuDtype` jsdoc. `undefined` means we
   * have no preference and the caller should let the worker auto-pick.
   */
  dtype?: 'q4f16' | 'fp16' | 'fp32' | 'q8';
}

function localStorageAvailable(): boolean {
  // Same guard as semanticLabelsStore — embedded contexts (some
  // WebViews, private modes that throw on writes) need a graceful no-op.
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

const VALID_DTYPES: ReadonlySet<string> = new Set(['q4f16', 'fp16', 'fp32', 'q8']);

function isEmbedDevicePref(v: unknown): v is EmbedDevicePref {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['device'] !== 'webgpu' && o['device'] !== 'wasm') return false;
  if (o['dtype'] !== undefined && !VALID_DTYPES.has(String(o['dtype']))) return false;
  return true;
}

export function loadEmbedDevicePref(): EmbedDevicePref | null {
  if (!localStorageAvailable()) return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isEmbedDevicePref(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveEmbedDevicePref(pref: EmbedDevicePref): void {
  if (!localStorageAvailable()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    // Quota exceeded / private mode / sandboxed context. Best-effort
    // write — failure means the next analysis just walks the ladder
    // again, no functional regression.
  }
}

export function clearEmbedDevicePref(): void {
  if (!localStorageAvailable()) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // best-effort wipe
  }
}
