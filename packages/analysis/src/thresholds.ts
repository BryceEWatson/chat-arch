/**
 * Centralized tunable thresholds for the outcome-substrate roadmap.
 *
 * Every numeric guard in the new code (composite weights, matching
 * covariates, display floors, clustering parameters, etc.) lives here.
 * Adding a numeric constant elsewhere violates the "no hardcoded values"
 * quality gate and is flagged by `scripts/lint-thresholds-imports.mjs`.
 *
 * Import idiom (pinned per ship-readiness review): callers `import { THRESHOLDS }`
 * only; access by full dotted path; no re-exporting sub-objects, no rename
 * aliases. Keeps every value greppable by its dotted-path string.
 *
 * Browser-safe — no Node-only imports.
 */

export const THRESHOLDS = {
  composite: {
    // Author-judgment v1 weights. Refit per the calibration plan in
    // Phase 2: label 50 sessions, minimize binary cross-entropy on linear
    // logits subject to sign constraints + sum(|w|) <= 2.0.
    weights: {
      testPass: 0.3,
      testFail: -0.4,
      buildPass: 0.2,
      prLandMerged: 0.5,
      prLandClosedUnmerged: -0.3,
      reworkSameSession: -0.2,
      reworkContinuation: -0.25,
      affirmation: 0.1,
    },
    // Midpoint of the sigmoid-output range [0, 1].
    binaryThresholdGood: 0.5,
    // Sign constraints used by the calibration refit.
    signPositive: ['testPass', 'buildPass', 'prLandMerged', 'affirmation'] as const,
    signNegative: ['testFail', 'prLandClosedUnmerged', 'reworkSameSession', 'reworkContinuation'] as const,
    magnitudeCapAbsSum: 2.0,
  },
  matching: {
    /**
     * Pre-treatment covariates ONLY for the reflexive matched-pair.
     * `filesEdited` and `toolCallDepth` are EXCLUDED — they're post-treatment
     * for the "touched chat-arch viewer" analysis (collider bias).
     * `firstUserTurnLen` is chronologically pre-treatment but
     * treatment-anticipatory; included for matching utility, NOT for
     * exogeneity. Methodology disclosure flags this.
     */
    covariates: [
      'log(projectAgeDays+1)',
      'log(prior7dSessionCount+1)',
      'log(firstUserTurnLen+1)',
      'projectIdHash%K',
      'dayOfWeek',
      'hourOfDay',
    ] as const,
    kNN: 1,
    cohortSizeForK3: 50,
    projectIdBuckets: 32,
  },
  display: {
    // Wilson CI width <0.4 at p̂=0.5 happens at n>=8; below that the rate is hidden.
    minNForRate: 8,
    maxCIWidthDisplay: 0.4,
  },
  trustCell: {
    // Rule-of-thumb minimum for two-proportion z-test power in the trust 2x2.
    minN: 30,
  },
  clustering: {
    // Pre-launch placeholder; calibrate when corpus >800 sessions.
    silhouetteMin: 0.15,
    intraClusterCosineMin: 0.7,
    minClusterSize: 10,
  },
  trajectory: {
    rollingWindow: 10,
    theilSenBootstrapResamples: 1000,
    // Politis-White data-driven block-length selection — no fixed default.
    // Short-series guard: if Politis-White returns b̂ >= floor(N/2) OR
    // N < minSeriesLengthForBootstrap, emit bootstrapStatus: 'series-too-short'.
    minSeriesLengthForBootstrap: 8,
    stallingMinRecentSessionsLast30d: 1,
  },
  skillCurve: {
    // Mann-Kendall low-n compensation; combined with BH-FDR.
    mannKendallAlpha: 0.1,
    bhFdrAlpha: 0.1,
    minWeeksPresent: 6,
  },
  ewma: {
    // ~ quarterly horizon.
    halfLifeWeeks: 7,
  },
  reworkContinuation: {
    levenshteinMax: 0.3,
    // Filters boilerplate errors (e.g., ENOENT, generic stack-trace prefixes).
    minErrorEntropyBits: 3.0,
    sameProjectRequired: true,
    maxHoursBetweenSessions: 24,
  },
  thrash: {
    rollingWindow: 30,
    editThrashMinSameFile: 4,
    editThrashWindow: 10,
    readLoopMinSameFile: 6,
    readLoopWindow: 12,
    testLoopMinConsecutive: 3,
    toolFlailDistinctTools: 5,
    toolFlailWindow: 6,
    cooldownMinutes: 5,
    // Pre-registered launch criterion (from plan §Phase 4):
    // fires <=1 per 20 real-work sessions; >=60% followed by ack-or-pivot within 3 turns;
    // per-trigger FP rate <=20% on a 50-session manual sample; tuning concludes when met
    // OR after 4 weeks (whichever first).
  },
  reviewLoop: {
    maxIterations: 3,
    costCeilingInputTokens: 200_000,
    costCeilingOutputTokens: 100_000,
    findingsDedupeCosine: 0.85,
    minConfidenceIter1: 0,
    minConfidenceIter2Plus: 70,
    driftGuardCosineMin: 0.3,
    falsifierTaskBudgetTokens: 8_000,
    executionGroundedTimeoutMs: 180_000,
  },
  llmBudget: {
    perRunInputTokenCap: 5_000_000,
    perRunOutputTokenCap: 2_000_000,
  },
} as const;

export type Thresholds = typeof THRESHOLDS;
