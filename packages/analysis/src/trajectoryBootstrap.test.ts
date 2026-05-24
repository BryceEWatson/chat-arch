import { describe, it, expect } from 'vitest';
import {
  bootstrapSlope,
  politisWhiteBlockLength,
  theilSen,
} from './trajectoryBootstrap.js';

/** Small mulberry32 PRNG — duplicated here for test-side reproducibility. */
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

/** Box-Muller standard normal sample using a seeded uniform PRNG. */
function makeGaussian(rng: () => number): () => number {
  return (): number => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** AR(1) series: x_t = phi * x_{t-1} + noise. Length N. */
function ar1Series(N: number, phi: number, rng: () => number): number[] {
  const z = makeGaussian(rng);
  const out: number[] = new Array(N);
  out[0] = z();
  for (let t = 1; t < N; t++) out[t] = phi * (out[t - 1] as number) + z();
  return out;
}

describe('theilSen', () => {
  it('exactly recovers slope on a line', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [1, 3, 5, 7, 9]; // slope 2, intercept 1
    expect(theilSen(xs, ys)).toBe(2);
  });
  it('is robust to one outlier', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [0, 1, 2, 3, 100]; // outlier at end
    // OLS slope ≈ 18.6 with the outlier; Theil-Sen median should be near 1.
    const s = theilSen(xs, ys);
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(5);
  });
});

describe('bootstrapSlope — short-series guard', () => {
  it('returns series-too-short when N < minSeriesLengthForBootstrap', () => {
    const result = bootstrapSlope([1, 2, 3, 4]);
    expect(result.status).toBe('series-too-short');
    expect(result.slope).toBeNull();
    expect(result.ci).toBeNull();
    expect(result.blockLength).toBeNull();
  });

  it('returns ok with finite CI on a long-enough series', () => {
    const xs: number[] = [];
    const rng = mulberry32(0xfeedface);
    const z = makeGaussian(rng);
    for (let i = 0; i < 30; i++) xs.push(0.5 * i + z());
    const result = bootstrapSlope(xs, { seed: 7, resamples: 200 });
    expect(result.status).toBe('ok');
    expect(result.slope).not.toBeNull();
    expect(result.ci).not.toBeNull();
    expect(result.blockLength).not.toBeNull();
    // True slope is 0.5 — CI should bracket it.
    expect(result.ci!.low).toBeLessThan(0.5);
    expect(result.ci!.high).toBeGreaterThan(0.5);
  });
});

describe('bootstrapSlope — AR(1) coverage', () => {
  /**
   * Coverage check: for each rho, draw `trials` AR(1) series of length N,
   * bootstrap each, and count how often the 95% CI contains the true
   * slope (zero). Relaxed targets per spec:
   *
   *   rho=0   →  >= 90% (independent case; stationary bootstrap should
   *               be near-nominal)
   *   rho=0.6 →  >= 80% (high autocorrelation; short-series penalty)
   *
   * Numerics: 80 trials, N=30, resamples=200. Bigger N + trials would
   * tighten the empirical coverage but blow up the test runtime.
   */
  function coverage(rho: number, trials: number, N: number, baseSeed: number): number {
    let hits = 0;
    for (let t = 0; t < trials; t++) {
      const rng = mulberry32(baseSeed + t * 7919);
      const series = ar1Series(N, rho, rng);
      const out = bootstrapSlope(series, { seed: baseSeed + t * 31, resamples: 200 });
      if (out.status !== 'ok' || out.ci === null) continue;
      if (out.ci.low <= 0 && 0 <= out.ci.high) hits += 1;
    }
    return hits / trials;
  }

  it('rho=0 (IID) hits >= 90% coverage at nominal 95%', () => {
    const cov = coverage(0, 80, 30, 0xc0de1234);
    expect(cov).toBeGreaterThanOrEqual(0.9);
  });

  it('rho=0.6 (strong AC) hits >= 80% coverage at nominal 95%', () => {
    const cov = coverage(0.6, 80, 30, 0xfacefeed);
    expect(cov).toBeGreaterThanOrEqual(0.8);
  });
});

describe('politisWhiteBlockLength', () => {
  it('returns a finite positive integer on stationary input', () => {
    const rng = mulberry32(1);
    const z = makeGaussian(rng);
    const xs: number[] = [];
    for (let i = 0; i < 50; i++) xs.push(z());
    const b = politisWhiteBlockLength(xs);
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(1);
  });

  it('returns NaN on a perfectly constant series', () => {
    const xs = new Array(20).fill(3.5);
    expect(Number.isNaN(politisWhiteBlockLength(xs))).toBe(true);
  });
});
