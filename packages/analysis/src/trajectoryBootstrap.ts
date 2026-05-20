/**
 * Politis-Romano stationary block bootstrap for trajectory slope CIs
 * (roadmap #3).
 *
 * Why a block bootstrap: a project's composite-outcome series is
 * autocorrelated (consecutive sessions touch the same files/tests/PRs).
 * An IID bootstrap would systematically under-estimate the slope CI
 * width. Politis & Romano 1994 ("The Stationary Bootstrap", JASA)
 * resample blocks of geometrically-distributed length, which preserves
 * the marginal distribution and approximates the second-order structure
 * without forcing a fixed block size.
 *
 * Block-length selector: Politis & White 2004 ("Automatic Block-Length
 * Selection for the Dependent Bootstrap", Econometric Reviews) gives an
 * MSE-optimal `b̂` via a flat-top lag-window estimate of the spectrum at
 * zero. For the very short series we see in per-project trajectories
 * (~10 sessions per active project), the full Politis-White machinery
 * is unstable, so we ship a simplified variant — choose b in [1,
 * floor(N/2)) minimizing the MSE of the flat-top estimate, falling back
 * to floor(sqrt(N)) when that selector returns a degenerate value.
 *
 * Short-series guard (per stat-rigor review iter-3): if N <
 * `THRESHOLDS.trajectory.minSeriesLengthForBootstrap` (default 8) OR
 * Politis-White returns `b̂ ≥ floor(N/2)`, we emit `series-too-short` and
 * the caller suppresses the CI in the viewer.
 *
 * Slope statistic: Theil-Sen (median of pairwise slopes). Robust to
 * outliers and the natural choice for a small-N, possibly heavy-tailed
 * series.
 *
 * Browser-safe — Math.random is replaced with a seeded mulberry32-style
 * PRNG so resamples are reproducible.
 */

import { THRESHOLDS } from './thresholds.js';

export type BootstrapStatus = 'ok' | 'series-too-short';

export interface BootstrapSlopeOptions {
  /** Number of resamples. Default `THRESHOLDS.trajectory.theilSenBootstrapResamples` (1000). */
  readonly resamples?: number;
  /** PRNG seed. Default 0xC0FFEE. */
  readonly seed?: number;
  /** Override the block length (skips the Politis-White selector). */
  readonly blockLength?: number;
}

export interface BootstrapResult {
  readonly status: BootstrapStatus;
  /** Theil-Sen slope on the original series. */
  readonly slope: number | null;
  /** 95% CI (2.5 / 97.5 percentiles over the resample distribution). */
  readonly ci: { low: number; high: number } | null;
  /** Mean block length used. */
  readonly blockLength: number | null;
}

/**
 * Run the Politis-Romano stationary bootstrap on the slope of a
 * one-dimensional time series. The series is assumed to be evenly
 * spaced; callers are responsible for either aggregating to a regular
 * grid (week / session-index) or accepting that the slope is in
 * per-step units of their input ordering.
 */
export function bootstrapSlope(
  series: readonly number[],
  opts: BootstrapSlopeOptions = {},
): BootstrapResult {
  const N = series.length;
  const minN = THRESHOLDS.trajectory.minSeriesLengthForBootstrap;
  const resamples = opts.resamples ?? THRESHOLDS.trajectory.theilSenBootstrapResamples;

  if (N < minN) {
    return { status: 'series-too-short', slope: null, ci: null, blockLength: null };
  }

  const xs = series.slice();
  const indices = Array.from({ length: N }, (_, i) => i);

  // Block length: caller-override or Politis-White automatic selector.
  let blockLength = opts.blockLength ?? politisWhiteBlockLength(xs);
  const guardCeiling = Math.floor(N / 2);
  if (!Number.isFinite(blockLength) || blockLength < 1) {
    blockLength = Math.max(1, Math.floor(Math.sqrt(N)));
  }
  if (blockLength >= guardCeiling) {
    return { status: 'series-too-short', slope: null, ci: null, blockLength: null };
  }

  const slope = theilSen(indices, xs);
  if (!Number.isFinite(slope)) {
    return { status: 'series-too-short', slope: null, ci: null, blockLength: null };
  }

  const rng = mulberry32(opts.seed ?? 0xc0ffee);
  const slopes: number[] = new Array(resamples);
  const p = 1 / blockLength;
  for (let r = 0; r < resamples; r++) {
    const resampled = stationaryBootstrapResample(xs, p, rng);
    const xsIdx = indices.slice(0, resampled.length);
    slopes[r] = theilSen(xsIdx, resampled);
  }
  slopes.sort((a, b) => a - b);
  const low = percentile(slopes, 0.025);
  const high = percentile(slopes, 0.975);

  return {
    status: 'ok',
    slope,
    ci: { low, high },
    blockLength,
  };
}

/**
 * Theil-Sen slope: median of all pairwise slopes (y_j - y_i) / (x_j - x_i)
 * for i < j. O(N^2) — fine for N <= 200, which is the only range we use.
 */
export function theilSen(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return Number.NaN;
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = (xs[j] as number) - (xs[i] as number);
      if (dx === 0) continue;
      slopes.push(((ys[j] as number) - (ys[i] as number)) / dx);
    }
  }
  if (slopes.length === 0) return Number.NaN;
  slopes.sort((a, b) => a - b);
  return median(slopes);
}

/**
 * One stationary-bootstrap resample of length N. Geometric block lengths
 * with success probability p = 1/blockLength; start indices uniform.
 *
 * Series is wrapped around (Politis-Romano use the circular embedding),
 * which avoids edge effects at the cost of mild bias when the true
 * series is non-stationary.
 */
function stationaryBootstrapResample(
  xs: readonly number[],
  p: number,
  rng: () => number,
): number[] {
  const N = xs.length;
  const out: number[] = new Array(N);
  let cursor = Math.floor(rng() * N);
  for (let t = 0; t < N; t++) {
    out[t] = xs[cursor % N]!;
    if (rng() < p) {
      cursor = Math.floor(rng() * N);
    } else {
      cursor += 1;
    }
  }
  return out;
}

/**
 * Politis-White (2004) automatic block-length selector — simplified for
 * short series.
 *
 * Steps:
 *   1. Compute sample autocovariances R(k) at lags 0..M, where M is set
 *      to a small fraction of N (we use floor(2 * sqrt(log10(N))) per the
 *      paper's lag-window prescription).
 *   2. Flat-top lag-window: w(k) = 1 for k <= M/2, = 2*(1 - k/M) for k in (M/2, M].
 *   3. Compute G_hat = sum_{k=1..M} w(k) * 2 * k * R(k)  (the asymptotic
 *      bias factor) and D_hat = sum_{k=-M..M} w(|k|) * R(|k|)  (the
 *      asymptotic variance factor).
 *   4. b_hat = ((2 * G_hat^2) / D_hat)^(1/3) * N^(1/3).
 *
 * Returns NaN on degenerate input (constant series, all-zero
 * autocovariances). Caller should fall back to floor(sqrt(N)).
 */
export function politisWhiteBlockLength(xs: readonly number[]): number {
  const N = xs.length;
  if (N < 4) return Number.NaN;
  const mu = xs.reduce((s, v) => s + v, 0) / N;
  const centered = xs.map((v) => v - mu);
  const M = Math.max(2, Math.floor(2 * Math.sqrt(Math.log10(N))));
  const Mcap = Math.min(M, N - 1);

  const R: number[] = new Array(Mcap + 1).fill(0);
  for (let k = 0; k <= Mcap; k++) {
    let s = 0;
    for (let i = 0; i + k < N; i++) s += centered[i]! * centered[i + k]!;
    R[k] = s / N;
  }
  if (R[0]! === 0) return Number.NaN;

  let G = 0;
  let D = R[0]!; // k=0 term, weight 1
  for (let k = 1; k <= Mcap; k++) {
    const w = k <= Mcap / 2 ? 1 : 2 * (1 - k / Mcap);
    G += w * 2 * k * R[k]!;
    D += 2 * w * R[k]!;
  }
  if (!Number.isFinite(G) || !Number.isFinite(D) || D <= 0) return Number.NaN;
  const ratio = (2 * G * G) / D;
  if (ratio <= 0 || !Number.isFinite(ratio)) return Number.NaN;
  const b = Math.cbrt(ratio) * Math.cbrt(N);
  return Math.max(1, Math.round(b));
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid]!;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (q <= 0) return sorted[0]!;
  if (q >= 1) return sorted[sorted.length - 1]!;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

/**
 * Mulberry32 — a small, fast 32-bit PRNG (Tommy Ettinger, public
 * domain). Used so the bootstrap is reproducible from a seed across
 * Node + browser.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
