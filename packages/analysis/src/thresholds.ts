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
     * with base × decay^dismissalCount, the multiplier sequence is
     * ×2 (k=0 baseline), ×4 (after 1st dismissal), ×8 (after 2nd),
     * shelve at k=3 = `maxDismissals` (matches plan §Phase Rev3-D
     * "×2/×4/×8 cap K=3"). Closes the iter-1 unbounded-nag failure
     * mode.
     *
     * Parallel mechanism — kept separate: knowledge-debt clusters use
     * `actionBanner.knowledgeDebtRepromotionGrowthMultiplier` (also
     * default 2) for the same saturation policy on a different entity
     * domain (clusters vs Narratives). The two are intentionally
     * NOT unified so per-domain calibration can tune each independently
     * once empirical re-promotion data lands per entity type. A future
     * audit should re-check whether they should converge.
     */
    dismissDecay: 2,
    /**
     * Cap on user dismissals before a Narrative is shelved
     * permanently. After this many dismissals the item is visible
     * only via an explicit "show shelved" affordance. K=3 per plan
     * §Phase Rev3-D — matches the ×2/×4/×8 multiplier sequence
     * documented above (after the K-th dismissal we'd see ×16, which
     * the cap pre-empts by shelving instead).
     */
    maxDismissals: 3,
    /**
     * Closure B family-wise correction: per-Narrative prior increases
     * by this value on each dismissal. Each re-emergence is a re-test
     * of the same hypothesis; raising the prior makes subsequent
     * re-promotion attempts face a stiffer Bayesian threshold.
     */
    repromotionPenalty: 1,
    //
    // Historical note (PR #78 review-loop): `maxRepromotionAttempts:
    // 3` lived here as a planned-but-never-wired sibling of
    // `maxDismissals`. It was never consumed by any kernel or UI
    // surface — the audit row + cap-K gate test both consult
    // `maxDismissals` because each dismissal IS a re-promotion
    // rejection in the current model. Removed to keep the THRESHOLDS
    // surface honest; re-add if/when a real distinction emerges
    // (e.g. counting only post-promotion dismissals separately).
    //
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
    /**
     * Rev3-F F4 falsifier verifier threshold. A finding is
     * `verified` when the ratio of cited turns that come back
     * `supports` is at least this value. Below it, the finding is
     * `not-verified` and dropped from any user-visible surface.
     *
     * 0.6 (3/5 at the count-minimum) is the pre-launch default:
     * tolerant enough that a single ambiguous turn doesn't tank a
     * mostly-supported claim, strict enough that "half supports,
     * half neutral" isn't enough. Re-calibrate after the F8 rolling
     * window accumulates n=40 verdicts.
     *
     * The unavailable bucket (citation didn't resolve) counts as a
     * FAILURE in the denominator — citation hygiene is part of the
     * gate.
     */
    falsifierMinSupportRatio: 0.6,
  },
  /**
   * Feed-redesign Phase α — `computeSurprises` kernel knobs.
   *
   * Pre-launch placeholders, ALL of them — the surprises surface is
   * brand-new (V1 = first land) and we have zero engagement data yet.
   * Calibrate on the same 4-week empirical rolling window as
   * `CHATARCH_THRASH_DETECT`: pull surprise emission rate per kind +
   * user-side "useful / not useful" feedback once the FEED Phase β
   * surface starts collecting it, then re-derive each value from the
   * observed distribution. Bumping a threshold here should be paired
   * with a fixture update + an entry under THRESHOLDS.surprises in the
   * `CHANGELOG.md` calibration log.
   *
   * Knobs are mirrored as `SurpriseThresholdsSnapshot` on the
   * `surprises.json` sidecar so the viewer can disclaim the values it
   * was emitted under.
   */
  surprises: {
    /** Minimum trailing-run length to emit a `streak` surprise. */
    streakMin: 5,
    /**
     * ITS BH-FDR qValue ceiling — a contrast counts as
     * `config-helped` when `qValue ≤ itsQValueMax` AND
     * `deltaGoodShare ≥ itsDeltaMin`.
     */
    itsQValueMax: 0.1,
    itsDeltaMin: 0.15,
    /**
     * Reflexive minimum mean-delta (good-share delta). Also requires
     * the CI to be strictly positive AND the E-value CI bound to
     * clear `reflexiveEValueMin` — descriptively significant +
     * statistically significant + sensitivity-robust, three gates.
     */
    reflexiveDeltaMin: 0.1,
    /**
     * Reflexive E-value CI-bound floor. VanderWeele & Ding (2017)
     * E-value on the Wilson CI bound nearest the null: how strong a
     * confounder (RR scale, both arms) would have to be to drag the
     * observed association to RR=1. 1.5 ≈ "a confounder twice the
     * strength of any pre-treatment covariate already adjusted for
     * would explain it away" — strong enough to surface, weak enough
     * to be one of the looser gates. Pre-launch placeholder; raise to
     * 2.0 after the first ~20 reflexive contrasts land if false-
     * positive rate looks high.
     */
    reflexiveEValueMin: 1.5,
    /**
     * `decision-paid-off`: minimum number of additional good
     * composite outcomes IN THE SAME PROJECT that must follow the
     * decision's session. Raised from 2 → 5 after iter-1 adversarial:
     * 2/2 followups gives Wilson lower bound ≈ 0.16 (Beta(1,1) prior),
     * which is below any plausible base rate. 5 followups + Wilson-
     * over-base-rate gate gives meaningful evidence the decision
     * actually moved the curve rather than coinciding with a good
     * week.
     */
    decisionGoodFollowupsMin: 5,
    /** Top-K knowledge-debt clusters surfaced as `debt-spinning`. */
    debtSpinningTopK: 3,
    /** Minimum cluster size for `debt-spinning`. */
    debtSpinningMinClusterSize: 3,
    /**
     * Wave 2 #1 — delta surprises. The builder archives each rescan's
     * `surprises.json` to `analysis/archive/surprises-YYYY-MM-DD.json`,
     * then prunes files older than this many days. The next scan reads
     * the most recent archive (NOT today's) as `priorSurprises` so the
     * kernel can emit DELTA observations (`streak-extended`,
     * `streak-broken`, `trajectory-flip-up`, `trajectory-flip-down`,
     * `pattern-recurrence-resumed`) on top of the snapshot kinds. When
     * no prior archive exists the delta kinds skip cleanly (fail-soft).
     * 30 days ≈ one rescan-per-day month of history; raise if calibrated
     * cadence is lower.
     */
    archiveRetentionDays: 30,
  },
  /**
   * Rev3 applied-rule outcome watcher (plan §"Three closures" —
   * Closure C). After a Pattern is `encode-as-pattern`'d and
   * (optionally) appended to CLAUDE.md, the next-sessions watcher
   * activates. Closes on whichever fires first: (a) N sessions
   * observed in the target project, (b) wall-clock elapsed,
   * (c) explicit user-side close. Project inactivity ≥
   * staleProjectDays before N is reached invalidates the watch
   * entirely; a fresh watcher starts on project re-entry.
   *
   * (Closures A and B don't get their own top-level key: A graduates
   * Narratives across `narrativeRung.tier*`; B saturates via
   * `narrativeRung.dismissDecay` + `maxDismissals` +
   * `repromotionPenalty`.)
   */
  /**
   * Per-project persona generation (feature: persona-mining V1).
   *
   * Driven by the `mine-persona` skill / `/api/mine-persona` endpoint
   * as SCAN chain step 5. Projects below `minSessionsForGeneration`
   * get a skip-row in `personas.json` with reason `insufficient-corpus`
   * — no thin personas emitted. Projects whose synthesis would exceed
   * `maxLlmUsdPerProject` get a `budget-exceeded` skip-row.
   *
   * Pre-launch placeholders. `minSessionsForGeneration: 30` reflects
   * the spec's "below 30 sessions, patterns aren't durable enough to
   * be useful" judgment — calibrate after the first batch of personas
   * lands. `maxSessionsForCorpus: 200` caps the Stage-2 LLM input;
   * the bryce.md prototype was authored from 160 sessions which is
   * the empirical existence proof.
   */
  persona: {
    /** Minimum project session count to emit a persona at all. */
    minSessionsForGeneration: 30,
    /**
     * Cap on how many sessions Stage 2 (LLM) sees. Stage 1 stratifies
     * the project's full session list into 4 quartiles by recency and
     * draws this many sessions split evenly across them — so a project
     * with > maxSessionsForCorpus sessions still surfaces founding-era
     * signal, not just recent prompts. The 4-bucket-by-recency strategy
     * matches the methodology used to author `research/persona-evals/
     * bryce.md` (Stage 2 also re-buckets by recency for its
     * time-bucketed sub-agents; the two stages share the same scheme).
     */
    maxSessionsForCorpus: 200,
    /** Hard budget cap per project for the synthesis stage; skip above. */
    maxLlmUsdPerProject: 0.5,
    /**
     * Stage-2 LLM budget proxy. The skill skips a project with
     * `status: budget-exceeded` when its Stage-1 candidate count
     * exceeds this value. The 1500 figure ≈ a 200-session corpus
     * with average per-bucket density and is the candidate-count
     * proxy for `maxLlmUsdPerProject` until the V2 token-counting
     * harness lands.
     *
     * **Calibration plan**: log actual Stage-2 USD per project after
     * the first ~10 personas land; recalibrate so the 95th-percentile
     * USD-per-candidate ratio puts the gate at maxLlmUsdPerProject.
     * Tracked in CHANGELOG calibration notes when the calibration
     * pass runs.
     */
    candidateBudgetProxy: 1500,
    /**
     * Per-bucket cap on candidates per project. Stage 1 selects up
     * to this many candidates for each of the 6 heuristic buckets
     * (`role-expertise` / `preferences` / etc.). Bounds Stage 2 LLM
     * input size: 6 × maxCandidatesPerBucket ≈ candidateBudgetProxy
     * when buckets are roughly balanced.
     */
    maxCandidatesPerBucket: 40,
  },
  /**
   * Per-project narrative mining (feature: narrative-mining V1).
   *
   * Driven by the `mine-narratives` skill / `/api/mine-narratives`
   * endpoint as SCAN chain step 6 (after `/mine-persona`). Projects
   * below `minSessionsForLlm` get a skip-row in `narratives.json`'s
   * `skipped[]` with reason `insufficient-corpus`; the heuristic
   * kernel still emits its (≤2-per-project) deterministic narratives.
   *
   * Pre-launch placeholders — calibrate against hand-labels after the
   * first 50 LLM narratives land. Calibration plan tracked in
   * CHANGELOG `[1.7.0]` calibration notes.
   *
   * `candidateBudgetProxy` is DELIBERATELY ABSENT in V1: with
   * `maxSessionsForCorpus=200` × 1 candidate/session capping each
   * project at ≤200 candidates, a proxy at 1200 (the persona analog
   * scaled to ~25% richer rows) is unreachable as designed. V1.1 may
   * re-introduce a per-recency-bucket candidate-count gate once
   * empirical per-project candidate counts justify it. V1's only
   * budget mechanism is `maxLlmUsdPerProject`.
   *
   * Field-name note: persona's `maxCandidatesPerBucket` caps SEMANTIC
   * buckets (6 × 40); narrative's analog caps RECENCY buckets (4 ×
   * 300). Renamed `maxCandidatesPerRecencyBucket` so the axis-change
   * is greppable.
   */
  narrative: {
    /** Minimum project session count to dispatch Stage 2 (LLM) at all. */
    minSessionsForLlm: 20,
    /**
     * Cap on how many sessions Stage 1 surfaces to Stage 2 per project.
     * Stratified by 4 recency quartiles — mirrors `personaCandidates`'s
     * `sampleSessionsStratifiedByRecency` so founding-era signal is
     * preserved when a project's session count exceeds the cap.
     */
    maxSessionsForCorpus: 200,
    /** Hard per-project USD budget for Stage 2; skip above. */
    maxLlmUsdPerProject: 0.5,
    /** Minimum narratives Stage 2b emits per project. */
    minPerProject: 3,
    /** Maximum narratives Stage 2b emits per project. */
    maxPerProject: 8,
    /**
     * Minimum supporting sessionIds per emitted narrative. Single-
     * session "narratives" are anecdotes, not themes (iter-1 stat-
     * rigor finding from persona-mining applies identically). Enforced
     * at BOTH Stage 2a emission time AND Stage 2c post-LLM gate.
     */
    evidenceMinPerNarrative: 2,
    /**
     * Per-recency-bucket cap on candidates per project. Stage 1 emits
     * up to this many candidates per quartile (4 × 300 = 1200 worst
     * case per project), bounding Stage 2 sub-agent input size.
     */
    maxCandidatesPerRecencyBucket: 300,
  },
  appliedRuleWatcher: {
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
