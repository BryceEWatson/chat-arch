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
    // Workflow-archetype clusters (#5) need a higher floor than generic
    // topic clusters — too-small archetypes are noisy "person-shaped" tails
    // rather than real workflow patterns. Pre-launch placeholder; calibrate
    // when archetype hand-labels are first applied.
    archetypeMinSize: 20,
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
  /**
   * Wave 7 P2 #8 — when does an ITS ack go stale?
   *
   *   - `nGrowthFraction`: the post-window n must grow by at least this
   *     fraction (default 0.5 = 50%) since ack-time for the row to be
   *     promoted back to the unacked pile on n-growth alone.
   *
   * The other staleness criterion — CI drift outside the originally-
   * acked CI bounds — is a structural check, not a threshold: any
   * non-overlap counts. We codify the n-growth knob here so future
   * calibration can tighten / loosen it without recompiling.
   */
  actionBanner: {
    staleAckCiInvalidationThreshold: 1.0,
    staleAckPostNGrowthFraction: 0.5,
    /**
     * Wave 7 P2 #9 — knowledge-debt clusters dismissed by the user
     * re-promote when the cluster's session-list size grows by this
     * multiplier from the dismissed snapshot. Default: 2× growth.
     */
    knowledgeDebtRepromotionGrowthMultiplier: 2,
  },
  /**
   * PRACTICE four-lens audit knobs. Tuned conservatively. (D3 — moved
   * here from inline constants in viewer/src/data/practiceAudit.ts.)
   */
  practiceAudit: {
    /** Minimum cluster size for a value-leak duplicate-cluster finding. */
    valueLeakDuplicateMinSize: 3,
    /** Top-N cost outliers to surface as findings. */
    topCostOutliers: 5,
    /** Minimum user-turn count to flag a session as a turn-outlier. */
    turnOutlierMin: 50,
  },
  /**
   * Rev3 confidence ladder for Narratives. Bayesian smoothing per the
   * formula `confidence = supporting / (supporting + contradicting +
   * prior)`. Three rungs (tier1=candidate, tier2=established,
   * tier3=promotable) gate visibility, curator-feed eligibility, and
   * `encode-as-pattern` action eligibility respectively.
   *
   * Joint-gate feasibility: tier3 uses 0.66 (not 0.75) so the
   * confidence gate + contradicting-cap are jointly satisfiable at
   * the count-minimum `supporting=6, contradicting=1` (with
   * defaultPrior=2 → 6/(6+1+2)=0.667 ≥ 0.66 ✓ AND 1 ≤ ceil(6/6)=1 ✓).
   * Iter-1 stat-rigor finding #001 demonstrated 0.75 + count cap was
   * infeasible.
   *
   * Calibration plan: hand-label n ≥ 100 narratives per kernel, ≥30
   * held-out, MDE ±0.10 false-promotion-rate at 80% power α=0.05.
   * Refit defaultPrior + per-kernel priors as Bayesian updates of
   * the prior itself; document the resulting credible interval, not
   * a point estimate. Track calibration history alongside
   * `composite.weights`.
   *
   * Pre-launch placeholders below — re-calibrate when corpus has the
   * first 100 narratives in a candidate kernel.
   */
  narrativeRung: {
    /** Tier-1 (candidate) confidence floor. */
    tier1: 0.33,
    /** Tier-2 (established) confidence floor — curator-feed eligible. */
    tier2: 0.5,
    /** Tier-3 (promotable) confidence floor — action eligible. */
    tier3: 0.66,
    /** Tier-1 additional gate: minimum supporting evidence count. */
    tier1SupportingMin: 1,
    /** Tier-2 additional gate: minimum supporting evidence count. */
    tier2SupportingMin: 2,
    /** Tier-3 additional gate: minimum supporting evidence count. */
    tier3SupportingMin: 6,
    /**
     * Tier-3 additional gate: contradicting ≤ ceil(supporting /
     * contradictingCapDivisor). At divisor=6, supporting=6 allows
     * contradicting≤1, supporting=12 allows ≤2, etc.
     */
    contradictingCapDivisor: 6,
    /**
     * Default Bayesian prior when a kernel doesn't override it via
     * `priorByKernel`. From the ShopForge precedent — light prior so
     * a kernel with 1 supporting and 0 contradicting lands at
     * confidence 1/(1+0+2)=0.33, exactly the tier-1 floor.
     */
    defaultPrior: 2,
    /**
     * Calibration fail-safe: a kernel whose
     * `analyzers.calibration_completed_at` is NULL has its effective
     * prior pinned to this very-high value, making tier-3 unreachable
     * (1/(1+0+20)=0.048 ≪ tier3). Banner-state surfaces "kernel X
     * uncalibrated — tier-3 promotion disabled" so the missing
     * calibration is visible, not silent.
     */
    uncalibratedPrior: 20,
    /**
     * Per-kernel prior overrides. Empty at v1; populated after
     * per-kernel calibration. Lookup falls back to `defaultPrior`
     * when the kernel name isn't present.
     */
    priorByKernel: {} as Readonly<Record<string, number>>,
    /**
     * Per-kernel minimum-sessions floor for cold-start honesty.
     * Kernels report "uncalibrated" when corpus < their floor; their
     * findings cannot exceed tier-1 until the threshold is met.
     * Empty at v1; populated as kernel-specific calibration runs
     * inform the floor.
     */
    minSessionsByKernel: {} as Readonly<Record<string, number>>,
    /**
     * Closure B saturation: per-Narrative growth-multiplier multiplier
     * applied on each user dismissal. Default doubling per dismissal —
     * a 2× multiplier becomes 4× after first dismissal, 8× after the
     * second, 16× after the third. Closes the iter-1 unbounded-nag
     * failure mode.
     */
    dismissDecay: 2,
    /**
     * Cap on user dismissals before a Narrative is shelved
     * permanently. After this many dismissals the item is visible
     * only via an explicit "show shelved" affordance.
     */
    maxDismissals: 4,
    /**
     * Closure B family-wise correction: per-Narrative prior increases
     * by this value on each dismissal. Each re-emergence is a re-test
     * of the same hypothesis; raising the prior makes subsequent
     * re-promotion attempts face a stiffer Bayesian threshold.
     */
    repromotionPenalty: 1,
    /**
     * Cap on re-promotion attempts. Document the resulting family-
     * wise α inflation in the curator-surface methodology disclosure.
     */
    maxRepromotionAttempts: 3,
  },
  /**
   * Rev3 curator / falsifier metrics and gates. Used by the
   * `/curate` and `/falsify` skills (Rev3-F) and consumed by the
   * curator-surface methodology disclosure.
   */
  curator: {
    /**
     * Precision@k window — the top-k items the curator surfaces
     * whose engagement is tallied. k=10 per plan §Validation metrics.
     */
    precisionAtKWindow: 10,
    /**
     * Engagement horizon: a surfaced item counts as a "hit" only if
     * a user action (star / explicit-action / engagedAt event)
     * occurs within this many days of first surfacing. Items whose
     * window hasn't closed are excluded from both numerator and
     * denominator (per iter-1 stat-rigor finding #006).
     */
    precisionAtKHorizonDays: 7,
    /**
     * Precision@k success threshold. Re-calibrate after the first
     * calibration window once empirical engagement data lands.
     */
    precisionAtKTarget: 0.3,
    /**
     * Falsifier rejection-rate acceptance bracket — pre-launch
     * placeholder. 4-week empirical calibration window analogous to
     * `CHATARCH_THRASH_DETECT`; re-derive from observed data.
     * Rejection rate below `[0]` = falsifier under-rejecting (false
     * negatives leak); above `[1]` = over-rejecting (good findings
     * killed). `as const` tuple so consumers see a fixed shape.
     */
    falsifierRejectionBracket: [0.2, 0.5] as readonly [number, number],
    /**
     * Falsifier meta-accuracy floor. Triggered on rolling 4-week
     * window (n=40 verdicts re-judged by user or different model
     * role). Banner-state fires when Wilson lower bound drops below
     * this value. NOT a point estimate on n=10/week — that fires
     * ~26% of weeks on noise at true accuracy 0.9 (iter-1 finding
     * stat-rigor #003).
     */
    falsifierAccuracyFloor: 0.8,
    /** Rolling-window length for falsifier meta-accuracy in weeks. */
    falsifierAccuracyWindowWeeks: 4,
    /** Rolling-window N (verdicts spot-checked) for falsifier meta-accuracy. */
    falsifierAccuracyWindowN: 40,
    /**
     * Outcome-correlation significance gate. `|Δ|/SE` (Welch's t /
     * permutation difference) must exceed this value before the
     * correlation tag is visible in the SourceAttribution
     * side-column. Pre-launch placeholder ≈ 1.96 (two-sided α=0.05);
     * calibrate empirically after first ~50 correlations are
     * computed.
     */
    outcomeCorrelationSignificance: 1.96,
    /**
     * Outcome-correlation evidence-length floor. Tie-breaker is
     * gated on `evidence.length ≥ outcomeCorrelationEvidenceMinLength`
     * — below this the SE on the cited-side mean dominates and the
     * ranking becomes noise (iter-1 stat-rigor #004).
     */
    outcomeCorrelationEvidenceMinLength: 5,
  },
  /**
   * Rev3 Closure C — applied-rule outcome watcher. After a Pattern
   * is `encode-as-pattern`'d and (optionally) appended to CLAUDE.md,
   * the next-sessions watcher activates. Closes on whichever fires
   * first: (a) N sessions observed in the target project,
   * (b) wall-clock elapsed, (c) explicit user-side close. Project
   * inactivity ≥ staleProjectDays before N is reached invalidates
   * the watch entirely; a fresh watcher starts on project re-entry.
   */
  closureC: {
    /** Number of post-application sessions observed before closing. */
    watcherSessionsN: 5,
    /**
     * Wall-clock cap. Timeout emits a `WATCH_INCONCLUSIVE` Narrative
     * at low feed priority — not silence.
     */
    watcherWallClockDays: 60,
    /**
     * Project-inactivity threshold (days). If the target project
     * goes this long without a session BEFORE watcherSessionsN is
     * reached, the watcher is invalidated. A fresh watcher starts
     * on project re-entry.
     */
    staleProjectDays: 30,
  },
} as const;

export type Thresholds = typeof THRESHOLDS;
