/**
 * Derive the self-hosted ORT-WASM asset URLs from a worker's
 * `self.location.origin`, or throw if the origin is unusable.
 *
 * This is a security-critical helper. The previous `try { … } catch
 * {}` that wrapped the path assignment let an unreadable origin fall
 * silently through to transformers.js's default, which points at
 * `cdn.jsdelivr.net`. That silent fallback is a surprise third-party
 * fetch at inference time — even with the app's CSP blocking the
 * actual load, the failure mode is confusing ("embedder timed out")
 * instead of clear ("self-hosted ORT assets missing").
 *
 * Keeping the guard here (no imports, zero dependencies) makes it
 * unit-testable without booting the full embed worker, which pulls
 * in @huggingface/transformers and needs a WebWorker-ish global.
 */

export interface OrtWasmPaths {
  /** Absolute URL of the ORT-WASM ES-module glue. */
  readonly mjs: string;
  /** Absolute URL of the ORT-WASM binary itself. */
  readonly wasm: string;
  /** Directory base (trailing slash); useful for preflight logging. */
  readonly base: string;
}

/**
 * Resolve the ORT-WASM paths or throw with a diagnostic-friendly
 * message. `origin` is the suspected value of `self.location.origin`
 * at worker boot time — anything that's not a non-empty string is a
 * misconfiguration we refuse to paper over.
 *
 * On success the returned URLs live under `<origin>/ort-wasm/` —
 * matching the asset layout in `apps/standalone/public/ort-wasm/`.
 */
export function resolveOrtWasmPaths(origin: unknown): OrtWasmPaths {
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new Error(
      'embedWorker: self.location.origin is unavailable; refusing to ' +
        'fall back to a third-party WASM CDN. This worker requires a ' +
        'browsing context that exposes `self.location`.',
    );
  }
  const base = `${origin}/ort-wasm/`;
  return {
    mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${base}ort-wasm-simd-threaded.jsep.wasm`,
    base,
  };
}
