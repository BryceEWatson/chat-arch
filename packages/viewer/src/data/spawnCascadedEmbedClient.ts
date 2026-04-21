/**
 * Shared WebGPU → WASM respawn cascade.
 *
 * Walks `q4f16 → fp16 → fp32 → wasm` in order of decreasing speed /
 * increasing compatibility, respawning the worker on each rung failure.
 * Transformers.js caches the first failed `createInferenceSession` in
 * a module-private rejected Promise, so in-worker retry is impossible —
 * the only recovery is respawning. Model weights live in the browser
 * Cache API, so subsequent spawns don't re-download anything already
 * pulled.
 *
 * Two entry-points use this helper:
 *
 *   1. `ChatArchViewer.runSemanticAnalysis` for the production flow.
 *      Passes `readDevicePref: true, saveDevicePref: true` so the
 *      localStorage memo is honored and updated — skipping doomed
 *      q4f16 attempts on hardware where the user already settled on
 *      fp32 or WASM in a prior run.
 *
 *   2. `BenchmarkRunner` (dev-only benchmark harness). Passes
 *      `readDevicePref: false, saveDevicePref: false` — the
 *      comparison numbers must reflect each model's capability on
 *      this hardware, NOT whatever rung the user's last production
 *      run landed on. Memo pollution in either direction
 *      invalidates cross-config comparisons (if we read the memo,
 *      every config starts at the same rung regardless of model
 *      support; if we write the memo, a benchmark sweep could
 *      degrade production by memoizing a rung that doesn't apply to
 *      the production model).
 *
 * Callers own worker lifecycle: `spawnClient` is theirs, so they
 * control createEmbedClient's onProgress / preferDevice / modelId /
 * pooling config. The helper only walks the dtype/device dimension.
 */

import type { EmbedClient } from './embedClient.js';
import { EmbedInitError } from './embedClient.js';
import {
  loadEmbedDevicePref,
  saveEmbedDevicePref,
  clearEmbedDevicePref,
  type EmbedDevicePref,
} from './embedDevicePrefStore.js';

/**
 * Log sink. Uses a narrow source literal `'worker'` — the only source
 * the cascade ever emits — so the viewer's wider `LogFn` type
 * (`source: LogSource` union) is assignable here without a cast.
 */
export type CascadeLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type CascadeLogFn = (level: CascadeLogLevel, source: 'worker', message: string) => void;

export interface CascadeStep {
  prefer?: 'webgpu' | 'wasm';
  dtype?: 'q4f16' | 'fp16' | 'fp32';
  description: string;
}

export interface SpawnClientFn {
  (
    prefer?: 'webgpu' | 'wasm',
    forceWebgpuDtype?: 'q4f16' | 'fp16' | 'fp32',
    reason?: string,
  ): EmbedClient;
}

export interface CascadeOptions {
  /**
   * Callback used to construct a fresh `EmbedClient` for each rung.
   * The caller owns everything about the client (download progress
   * plumbing, onProgress wiring, modelId/pooling choice via
   * createEmbedClient). The helper invokes this at most once per
   * rung and disposes any prior client before calling it again.
   */
  spawnClient: SpawnClientFn;
  /**
   * Activity-log sink. Optional; if omitted, the helper runs silent.
   * Production passes the viewer's log function; harness passes a
   * local log that feeds its on-page log pane.
   */
  onLog?: CascadeLogFn;
  /**
   * If set and non-null, used as the iteration-0 client instead of
   * calling `spawnClient`. Lets callers keep a cached client across
   * runs (production reuses the previous analysis's client when its
   * `ready()` resolves immediately). On failure, the helper
   * `dispose()`s it before respawning.
   */
  existingClient?: EmbedClient | null;
  /**
   * When true (default), the cascade reads the localStorage memo at
   * `chat-arch:embed-device-pref-v1` and uses it to pre-slice doomed
   * rungs off the front of the ladder. Set to `false` for the
   * benchmark harness so the memo from the user's prior production
   * run doesn't pollute per-model dtype/cascade-step measurements.
   */
  readDevicePref?: boolean;
  /**
   * When true (default), the cascade writes the successful
   * (device, dtype) tuple back to the memo on success. Set to
   * `false` for the harness so a benchmark row doesn't overwrite
   * the production memo (which may be for a different modelId).
   */
  saveDevicePref?: boolean;
}

export interface CascadeResult {
  /** The live `EmbedClient` whose `ready()` resolved successfully. */
  client: EmbedClient;
  /** Which device the pipeline landed on. */
  device: 'webgpu' | 'wasm';
  /** Which dtype the pipeline landed on. */
  dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8';
  /**
   * How many respawn attempts it took (0 = iteration 0 succeeded on
   * first try). Useful for the benchmark harness's `cascade_steps`
   * metric column.
   */
  cascadeSteps: number;
  /** The memo value used to pre-slice the ladder (null if readDevicePref=false or absent). */
  memoized: EmbedDevicePref | null;
}

function buildSteps(memo: EmbedDevicePref | null): CascadeStep[] {
  if (memo?.device === 'wasm') {
    return [{ prefer: 'wasm', description: 'WASM (memoized last-known-good)' }];
  }
  if (
    memo?.device === 'webgpu' &&
    memo.dtype !== undefined &&
    memo.dtype !== 'q8'
  ) {
    const order: ('q4f16' | 'fp16' | 'fp32')[] = ['q4f16', 'fp16', 'fp32'];
    const startIdx = order.indexOf(memo.dtype);
    const dtypeSteps = order.slice(startIdx).map((d, i) => ({
      prefer: 'webgpu' as const,
      dtype: d,
      description:
        i === 0 ? `WebGPU ${d} (memoized last-known-good)` : `WebGPU ${d} (cascade fallback)`,
    }));
    return [
      ...dtypeSteps,
      { prefer: 'wasm' as const, description: 'WASM (last resort)' },
    ];
  }
  return [
    { description: 'auto-pick (best available)' },
    {
      prefer: 'webgpu' as const,
      dtype: 'fp16' as const,
      description: 'WebGPU fp16 (post-q4f16 fallback)',
    },
    {
      prefer: 'webgpu' as const,
      dtype: 'fp32' as const,
      description: 'WebGPU fp32 (post-fp16 fallback)',
    },
    { prefer: 'wasm' as const, description: 'WASM (last resort)' },
  ];
}

export async function spawnCascadedEmbedClient(
  options: CascadeOptions,
): Promise<CascadeResult> {
  const readPref = options.readDevicePref !== false;
  const savePref = options.saveDevicePref !== false;
  const log: CascadeLogFn = options.onLog ?? (() => {});

  const memoized = readPref ? loadEmbedDevicePref() : null;
  const steps = buildSteps(memoized);

  let currentClient: EmbedClient | null = options.existingClient ?? null;
  if (currentClient === null) {
    const first = steps[0] as CascadeStep;
    const firstReason = memoized
      ? 'memoized last-known-good from previous run'
      : 'first attempt — the worker will pick the fastest supported dtype';
    currentClient = options.spawnClient(first.prefer, first.dtype, firstReason);
  }

  let resolved: { device: 'webgpu' | 'wasm'; dtype: 'q4f16' | 'fp16' | 'fp32' | 'q8' } | null =
    null;
  let cascadeSteps = 0;
  let lastErr: unknown = null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] as CascadeStep;
    if (i > 0) {
      currentClient?.dispose();
      currentClient = options.spawnClient(step.prefer, step.dtype, step.description);
      cascadeSteps += 1;
    }
    try {
      resolved = await currentClient!.ready();
      break;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof EmbedInitError)) throw err;
      const isLast = i === steps.length - 1;
      if (isLast) {
        if (savePref && memoized !== null) clearEmbedDevicePref();
        throw err;
      }
      log(
        'warn',
        'worker',
        `${step.description} failed (${err.message.slice(0, 120)}…). Trying next rung…`,
      );
    }
  }
  if (resolved === null || currentClient === null) {
    throw lastErr instanceof Error ? lastErr : new Error('embed cascade exhausted');
  }

  if (savePref) {
    if (
      memoized === null ||
      memoized.device !== resolved.device ||
      memoized.dtype !== resolved.dtype
    ) {
      saveEmbedDevicePref({ device: resolved.device, dtype: resolved.dtype });
      log(
        'debug',
        'worker',
        `Memorized ${resolved.device.toUpperCase()}/${resolved.dtype} as last-known-good for next analysis.`,
      );
    }
  }
  log('info', 'worker', `Pipeline ready on ${resolved.device.toUpperCase()} / ${resolved.dtype}.`);

  return {
    client: currentClient,
    device: resolved.device,
    dtype: resolved.dtype,
    cascadeSteps,
    memoized,
  };
}
