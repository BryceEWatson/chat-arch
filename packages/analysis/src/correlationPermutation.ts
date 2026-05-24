// Phase Rev3-G G5 — non-parametric permutation test for outcome-
// correlation effect-size confirmation.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase
// Rev3-G G5:
//
//   "Falsifier runs permutation test resampling project sessions
//    to confirm Δ unlikely under H0."
//
// Welch's t (G1) makes a parametric assumption (approximately
// normal sample means via CLT). When the cited sample is small (5-
// 20) and the underlying outcome distribution is heavy-tailed or
// skewed — typical for composite-outcome scores derived from
// curator session-grade signals — the permutation test is the
// more honest answer. It makes no distributional assumption: under
// H0 (no group difference) the cited/uncited labels are
// exchangeable, so the observed Δ should sit in the bulk of the
// permutation distribution.
//
// This kernel returns the two-sided empirical p-value: the share
// of K random label-permutations whose |Δ_perm| ≥ |Δ_observed|.

import { mean } from './stats.js';

const DEFAULT_PERMUTATIONS = 1_000;
const DEFAULT_SEED = 0xc0ffee;

/**
 * Result of running a permutation test on two samples.
 */
export interface PermutationTestResult {
  /** `mean(cited) - mean(uncited)` — same convention as Welch's. */
  readonly delta: number;
  /**
   * Two-sided empirical p-value: `(# permutations with |Δ_perm| ≥
   * |Δ_observed|) / K`. Bounded to `[1/(K+1), 1]` so a zero count
   * doesn't claim "p=0" — the test has finite resolution.
   */
  readonly pValueTwoSided: number;
  /** Number of permutations actually run. */
  readonly permutations: number;
  /**
   * Number of permutations whose |Δ_perm| ≥ |Δ_observed|. Exposed
   * so the caller can render "12 of 1000 resamples reached this
   * effect size" alongside the p-value.
   */
  readonly atLeastAsExtremeCount: number;
  /**
   * `false` when the test couldn't be computed (either sample
   * empty, both samples constant, etc.). Carries a degenerate
   * result; the caller should not interpret `pValueTwoSided=1` as
   * "no signal" when `valid=false`.
   */
  readonly valid: boolean;
}

export interface PermutationTestOptions {
  /**
   * Number of random permutations. Default 1000 (gives p-value
   * resolution of 0.001). Larger K tightens the resolution at
   * O(K · n) cost.
   */
  readonly permutations?: number;
  /**
   * 32-bit unsigned PRNG seed for reproducible runs. Deterministic
   * by default so test fixtures don't flake on the empirical
   * p-value boundary.
   */
  readonly seed?: number;
}

/**
 * xorshift32 — fast, deterministic, sufficient for permutation
 * shuffling. NOT cryptographically secure (don't use for anything
 * security-sensitive).
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0xdeadbeef; // xorshift can't start at 0
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    // Map to [0, 1).
    return state / 0x1_0000_0000;
  };
}

/**
 * Fisher–Yates shuffle in place. Uses the supplied RNG.
 */
function shuffleInPlace(xs: number[], rng: () => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = xs[i]!;
    xs[i] = xs[j]!;
    xs[j] = tmp;
  }
}

/**
 * Two-sided permutation test on the mean difference between two
 * samples.
 *
 * Steps:
 *   1. Compute observed Δ = mean(cited) - mean(uncited).
 *   2. Pool both samples into a single array.
 *   3. For K permutations: shuffle the pool, split into prefixes
 *      of original sizes, recompute Δ_perm.
 *   4. Empirical p-value = count of |Δ_perm| ≥ |Δ_observed| / K,
 *      bounded to `[1/(K+1), 1]` so the reported p never claims
 *      finer resolution than the resample count allows.
 *
 * Defensive contract:
 *   - Either sample empty → `valid: false, delta: 0,
 *     pValueTwoSided: 1`.
 *   - Both samples constant AND means equal → `valid: false`.
 *   - Non-finite values in either sample → `valid: false`.
 *   - Either sample has <2 elements but both non-empty → still
 *     runs (the permutation distribution is well-defined for any
 *     non-empty split, even if degenerate).
 */
export function permutationTestDelta(
  cited: readonly number[],
  uncited: readonly number[],
  options: PermutationTestOptions = {},
): PermutationTestResult {
  const K = options.permutations ?? DEFAULT_PERMUTATIONS;
  const seed = options.seed ?? DEFAULT_SEED;

  // K=0 (or negative) — pValueTwoSided would otherwise compute as
  // 0/0 = NaN and propagate through `Math.max(NaN, 1/(K+1))` = NaN,
  // failing-open for downstream `p < 0.05` checks. Per the final
  // exit-review on rev3-start..main. Pinning here means downstream
  // consumers never see a "valid" result with a NaN p-value.
  if (K <= 0) {
    return {
      delta: 0,
      pValueTwoSided: 1,
      permutations: K,
      atLeastAsExtremeCount: 0,
      valid: false,
    };
  }

  if (cited.length === 0 || uncited.length === 0) {
    return {
      delta: 0,
      pValueTwoSided: 1,
      permutations: K,
      atLeastAsExtremeCount: 0,
      valid: false,
    };
  }
  // NaN / non-finite guard (mirrors welchsTTest's iter-1 fix).
  for (const x of cited) {
    if (!Number.isFinite(x)) {
      return {
        delta: 0,
        pValueTwoSided: 1,
        permutations: K,
        atLeastAsExtremeCount: 0,
        valid: false,
      };
    }
  }
  for (const x of uncited) {
    if (!Number.isFinite(x)) {
      return {
        delta: 0,
        pValueTwoSided: 1,
        permutations: K,
        atLeastAsExtremeCount: 0,
        valid: false,
      };
    }
  }

  const observedDelta = mean(cited) - mean(uncited);
  const absObserved = Math.abs(observedDelta);

  // Degenerate case: pool is constant. No permutation can produce a
  // non-zero Δ, so |Δ_perm| < |Δ_observed| only when observed is
  // also zero. Just check directly.
  const pool = [...cited, ...uncited];
  const first = pool[0]!;
  const constant = pool.every((v) => v === first);
  if (constant) {
    if (observedDelta === 0) {
      return {
        delta: 0,
        pValueTwoSided: 1,
        permutations: K,
        atLeastAsExtremeCount: 0,
        valid: false,
      };
    }
    // Constant pool can't produce observedDelta ≠ 0, so this only
    // happens with non-finite arithmetic (which we already
    // guarded). Defensive return.
    return {
      delta: observedDelta,
      pValueTwoSided: 1,
      permutations: K,
      atLeastAsExtremeCount: 0,
      valid: false,
    };
  }

  const rng = makeRng(seed);
  const nCited = cited.length;
  const nUncited = uncited.length;
  const poolCopy = [...pool];
  let atLeastAsExtremeCount = 0;
  for (let k = 0; k < K; k++) {
    shuffleInPlace(poolCopy, rng);
    // First nCited elements = permuted "cited"; rest = "uncited".
    let citedSum = 0;
    for (let i = 0; i < nCited; i++) citedSum += poolCopy[i]!;
    let uncitedSum = 0;
    for (let i = nCited; i < nCited + nUncited; i++) {
      uncitedSum += poolCopy[i]!;
    }
    const permDelta = citedSum / nCited - uncitedSum / nUncited;
    if (Math.abs(permDelta) >= absObserved) {
      atLeastAsExtremeCount += 1;
    }
  }
  // Bound p-value away from 0 so we never claim finer resolution
  // than the resample count permits.
  const pRaw = atLeastAsExtremeCount / K;
  const pValueTwoSided = Math.max(pRaw, 1 / (K + 1));

  return {
    delta: observedDelta,
    pValueTwoSided,
    permutations: K,
    atLeastAsExtremeCount,
    valid: true,
  };
}
