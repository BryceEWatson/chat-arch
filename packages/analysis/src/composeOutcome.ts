/**
 * Per-session composite outcome kernel — Phase 1 Wave 2 (Stream B).
 *
 * Pure function. Aggregates the verifier output for one session (an
 * AuditResult[]) into a single `CompositeOutcome` record per
 * `packages/schema/src/composite-outcome.ts`. NO file I/O — the
 * `composeOutcomesBuilder` in `packages/exporter/src/analysis/` is the
 * Node shell that writes the sidecar.
 *
 * Math, restated from the plan (Phase 1 §Architectural realignment):
 *
 *   linear_logit = bias + Σ_i w_i * x_i        where x_i ∈ {0, 1, null}
 *   score        = sigmoid(linear_logit)        in [0, 1]
 *   binary       = 'good'   if score > THRESHOLDS.composite.binaryThresholdGood
 *                | 'bad'    if score < 1 - threshold
 *                | 'unknown' otherwise OR all-null
 *
 * Null primary signals contribute 0 to the logit (no evidence either
 * way), which is the convex-relaxation default agreed in plan iter-3.
 *
 * Browser-safe: NO `node:*` imports. `weightsHash` is FNV-1a-32 over
 * canonical-JSON of the weights — hand-rolled to keep the kernel pure;
 * the Node builder may choose to overwrite with a SHA-256 if it wants
 * cryptographic strength (the hash is only used as a partial-write
 * detector — collision resistance is not load-bearing).
 */

import type {
  AuditResult,
  CompositeBinary,
  CompositeOutcome,
  CompositeWeights,
  SessionSource,
} from '@chat-arch/schema';
import { sigmoid } from './stats.js';
import { THRESHOLDS } from './thresholds.js';

/**
 * Snapshot of the metrics that surface around a config-change boundary —
 * used by the Phase 2 ITS analysis. Treated as opaque by this kernel;
 * we accept the parameter so the v1 signature already matches the v2
 * call site and downstream code doesn't need a second rewrite.
 *
 * Wave 2 doesn't yet wire any field of this snapshot into the composite
 * (Wave 3 will, when the upgradeOutcomes builder feeds it through), so
 * passing `null` is the typical Phase 1 path.
 */
export interface UpgradeOutcomeMetricsSnapshot {
  /** Window mean — kept open-ended for the v2 wire-through. */
  readonly preMean?: number;
  readonly postMean?: number;
}

export interface ComposeOutcomeOptions {
  /** Override the canonical weights from THRESHOLDS.composite.weights. */
  weights?: CompositeWeights;
  /** Bias term on the linear logit. Defaults to 0 (50% prior). */
  bias?: number;
}

/**
 * Primary signals extracted from the audit results for one session.
 * Exposed for the builder to inspect / for tests; the public entry is
 * `composeOutcome` below.
 */
export interface CompositePrimitives {
  testPass: boolean | null;
  buildPass: boolean | null;
  prLand: 'merged' | 'closed-unmerged' | 'open' | 'none' | null;
  noRework: boolean | null;
  affirmation: boolean | null;
}

/**
 * Per-signal contribution to the linear logit. Exposed for sensitivity
 * analysis in the viewer (Phase 1 PR-3) — the order matches
 * `THRESHOLDS.composite.signPositive` + `signNegative`.
 */
export interface LogitContributions {
  testPass: number;
  testFail: number;
  buildPass: number;
  prLandMerged: number;
  prLandClosedUnmerged: number;
  reworkSameSession: number;
  reworkContinuation: number;
  affirmation: number;
}

const DEFAULT_WEIGHTS: CompositeWeights = THRESHOLDS.composite.weights as CompositeWeights;
const BINARY_THRESHOLD = THRESHOLDS.composite.binaryThresholdGood;

/**
 * Project AuditResult[] for one session down to the five primary
 * signals. Multiple audit results of the same family resolve as:
 *   - any fail   → boolean = false / land = closed-unmerged
 *   - all pass   → boolean = true  / land = merged
 *   - mixed      → boolean = false (conservative; a single fail dominates)
 *   - all inconclusive / absent → null
 *
 * Discussion: the "any fail wins" rule mirrors the audit verifier's
 * own bias against false positives. A session where `gh pr create`
 * passed but `gh pr merge` failed is *not* a landed PR.
 */
export function extractPrimitives(
  auditResults: readonly AuditResult[],
): CompositePrimitives {
  let testPass: boolean | null = null;
  let buildPass: boolean | null = null;
  let prOpened: boolean | null = null;
  let prMerged: boolean | null = null;
  let prClosedUnmerged: boolean | null = null;
  let reworkSame: boolean | null = null;
  const reworkCont: boolean | null = null;
  let affirmation: boolean | null = null;

  const reduce = (
    prev: boolean | null,
    outcome: 'pass' | 'fail' | 'inconclusive',
  ): boolean | null => {
    if (outcome === 'inconclusive') return prev;
    const o = outcome === 'pass';
    if (prev === null) return o;
    // "any fail wins": once we've recorded a fail, stay failed.
    return prev && o;
  };

  for (const r of auditResults) {
    switch (r.claimType) {
      case 'tests-pass-claim':
        testPass = reduce(testPass, r.outcome);
        break;
      case 'build-pass-claim':
        buildPass = reduce(buildPass, r.outcome);
        break;
      case 'gh-pr-opened':
        prOpened = reduce(prOpened, r.outcome);
        break;
      case 'gh-pr-merged':
        prMerged = reduce(prMerged, r.outcome);
        break;
      case 'gh-pr-closed-unmerged':
        prClosedUnmerged = reduce(prClosedUnmerged, r.outcome);
        break;
      case 'git-revert':
      case 'git-reset-hard':
      case 'git-force-push':
        // Rework signal: any successful revert/reset/force-push is
        // evidence of rework-in-the-same-session. We invert the sign
        // when computing logit contributions; here we capture the raw
        // observation. A failed `git revert` Bash invocation still
        // means the user TRIED to rework, so we record `true`.
        if (r.outcome !== 'inconclusive') {
          if (reworkSame === null) reworkSame = true;
          else reworkSame = reworkSame || true;
        }
        break;
      case 'affirmation':
        affirmation = reduce(affirmation, r.outcome);
        break;
      // fix-claim, addition-claim, verification-claim, completion-claim
      // are existing v1 families — they don't feed the composite
      // primary signals (would double-count the test/build dims).
      default:
        break;
    }
  }

  // Cross-session rework continuation is computed by the builder (it
  // needs prior-session text — see Phase 1 commit 1.3). Default to null.
  // The builder pipes its decision through `composeOutcome`'s third
  // arg in Wave 3 — Wave 2 carries the field shape only.
  void reworkCont;

  // Roll up the three PR signals into `prLand`. Priority:
  //   merged > closed-unmerged > open > none
  // null only when there's no signal at all from the gh-pr-* families.
  let prLand: CompositePrimitives['prLand'] = null;
  const anyPrSignal = prOpened !== null || prMerged !== null || prClosedUnmerged !== null;
  if (anyPrSignal) {
    if (prMerged === true) prLand = 'merged';
    else if (prClosedUnmerged === true) prLand = 'closed-unmerged';
    else if (prOpened === true) prLand = 'open';
    else prLand = 'none';
  }

  // No-rework derivation: if any rework signal observed, noRework = false.
  // If no rework signal at all, leave null (we don't know — most sessions
  // genuinely never trigger one of these claims).
  const noRework: boolean | null = reworkSame === null ? null : !reworkSame;

  return { testPass, buildPass, prLand, noRework, affirmation };
}

/**
 * Compute the linear logit + per-signal contributions for one set of
 * primitives. Exposed for tests + the viewer's sensitivity surface.
 */
export function logitFromPrimitives(
  p: CompositePrimitives,
  weights: CompositeWeights = DEFAULT_WEIGHTS,
  bias = 0,
): { logit: number; contributions: LogitContributions } {
  // testPass / testFail split: a true testPass contributes +weights.testPass;
  // a false testPass (i.e. an observed fail) contributes +weights.testFail
  // (which is negative). null → 0.
  const cTestPass = p.testPass === true ? weights.testPass : 0;
  const cTestFail = p.testPass === false ? weights.testFail : 0;
  const cBuildPass = p.buildPass === true ? weights.buildPass : 0;
  // No symmetric "buildFail" in the weights v1 — a failed build observation
  // is absorbed by testFail being the dominant negative; we MAY add it
  // post-calibration. Until then, null.

  const cPrMerged = p.prLand === 'merged' ? weights.prLandMerged : 0;
  const cPrClosedUnmerged = p.prLand === 'closed-unmerged' ? weights.prLandClosedUnmerged : 0;

  // Rework signals.
  // noRework === true contributes 0 (the default state — no penalty for
  //   not having reworked).
  // noRework === false contributes weights.reworkSameSession (negative).
  // null → 0.
  const cReworkSame = p.noRework === false ? weights.reworkSameSession : 0;
  // Cross-session continuation is carried separately on the input shape
  // (Wave 3 will route it through). For Wave 2 the field is reserved at
  // 0 — see the note in extractPrimitives.
  const cReworkCont = 0;

  const cAffirmation = p.affirmation === true ? weights.affirmation : 0;

  const contributions: LogitContributions = {
    testPass: cTestPass,
    testFail: cTestFail,
    buildPass: cBuildPass,
    prLandMerged: cPrMerged,
    prLandClosedUnmerged: cPrClosedUnmerged,
    reworkSameSession: cReworkSame,
    reworkContinuation: cReworkCont,
    affirmation: cAffirmation,
  };

  const logit =
    bias +
    cTestPass +
    cTestFail +
    cBuildPass +
    cPrMerged +
    cPrClosedUnmerged +
    cReworkSame +
    cReworkCont +
    cAffirmation;

  return { logit, contributions };
}

/**
 * FNV-1a 32-bit hash → 8-char hex. Browser-safe (no `node:crypto`).
 * Used only as a partial-write detector for the composite-outcomes
 * sidecar (`row.weightsHash !== file.weightsHash` → reject row), not
 * for cryptographic guarantees. The builder may upgrade to SHA-256.
 *
 * Returns 16-char hex by running FNV twice with different offsets and
 * concatenating — gives us the schema-required 16 hex chars without
 * pulling in a real crypto primitive.
 */
export function weightsHashFnv(weights: CompositeWeights): string {
  // Canonical JSON: keys sorted alphabetically, no whitespace. Avoids
  // any hash-instability from object-iteration order.
  const sortedKeys = Object.keys(weights).sort();
  const weightsAsRecord = weights as unknown as Record<string, number>;
  const canon =
    '{' +
    sortedKeys
      .map((k) => JSON.stringify(k) + ':' + JSON.stringify(weightsAsRecord[k]))
      .join(',') +
    '}';

  // FNV-1a 32-bit with two different offset bases.
  const fnv32 = (str: string, offsetBasis: number): number => {
    let h = offsetBasis >>> 0;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      // h *= 16777619, but JS bit ops require Math.imul for 32-bit safety
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  };

  const a = fnv32(canon, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv32(canon, 0x01000193).toString(16).padStart(8, '0');
  return (a + b).slice(0, 16);
}

/**
 * Decide the binary tag for a sigmoid-output score.
 *
 * - score > THRESHOLDS.composite.binaryThresholdGood     → 'good'
 * - score < 1 - THRESHOLDS.composite.binaryThresholdGood → 'bad'
 * - otherwise                                            → 'unknown'
 *
 * If all primary signals are null (no evidence), this is overridden by
 * the caller to 'unknown' regardless of score.
 */
export function binaryFromScore(score: number): CompositeBinary {
  if (score > BINARY_THRESHOLD) return 'good';
  if (score < 1 - BINARY_THRESHOLD) return 'bad';
  return 'unknown';
}

/**
 * Compose one session's CompositeOutcome from its AuditResult[].
 *
 * `auditResults` MUST all share the same sessionId + source (the
 * builder guarantees this by grouping before calling).
 *
 * `upgradeSnapshot` is reserved for Phase 2 (#13 / ITS analysis) — Wave
 * 2 accepts it as `null`. Forward-compat preserved per plan iter-3.
 */
export function composeOutcome(
  sessionId: string,
  source: SessionSource,
  auditResults: readonly AuditResult[],
  upgradeSnapshot: UpgradeOutcomeMetricsSnapshot | null,
  options: ComposeOutcomeOptions = {},
): CompositeOutcome {
  // upgradeSnapshot is reserved for Wave 3 — see schema note. Accepting
  // here so the Wave 3 builder doesn't need a signature change.
  void upgradeSnapshot;

  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const bias = options.bias ?? 0;

  const primitives = extractPrimitives(auditResults);
  const { logit } = logitFromPrimitives(primitives, weights, bias);
  const score = sigmoid(logit);

  // All-null guard: if every primary signal is null we can't trust the
  // sigmoid-of-zero default of 0.5 to mean "good or bad", it just means
  // "no evidence". Force binary = 'unknown'.
  const allNull =
    primitives.testPass === null &&
    primitives.buildPass === null &&
    primitives.prLand === null &&
    primitives.noRework === null &&
    primitives.affirmation === null;

  const binary: CompositeBinary = allNull ? 'unknown' : binaryFromScore(score);

  return {
    sessionId,
    source,
    testPass: primitives.testPass,
    buildPass: primitives.buildPass,
    prLand: primitives.prLand,
    noRework: primitives.noRework,
    affirmation: primitives.affirmation,
    score,
    linearLogit: logit,
    binary,
    weightsHash: weightsHashFnv(weights),
  };
}
