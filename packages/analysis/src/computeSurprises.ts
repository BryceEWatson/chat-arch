/**
 * Surprises kernel — feed-redesign Phase A (plumbing).
 *
 * Snapshot-based: takes already-computed kernel outputs (composite
 * outcomes, project trajectories, ITS contrasts, applied-pattern
 * watcher verdicts, reflexive result, decisions, knowledge-debt
 * clusters) and emits a ranked list of "surprise" observations the
 * user might not have noticed about their recent work with Claude.
 *
 * Positive observations (`tone: 'positive'`):
 *   - streak                  — N consecutive composite-good sessions
 *   - trajectory-accelerating — project slope CI strictly positive
 *   - config-helped           — ITS contrast with significantly +delta
 *   - pattern-closed          — applied-pattern watcher `holding`
 *                               (cooldown cleared with no recurrence)
 *   - reflexive-positive      — reflexive meanDelta > threshold AND
 *                               CI strictly positive AND E-value CI
 *                               bound ≥ `reflexiveEValueMin` (associational,
 *                               not causal — sensitivity-gated)
 *   - decision-paid-off       — decision joined to a good outcome AND
 *                               followed by ≥ K additional good outcomes
 *                               IN THE SAME PROJECT AND Wilson-low good
 *                               rate exceeds the corpus base rate
 *
 * Concerns (`tone: 'concerning'`):
 *   - trajectory-stalled      — project slope CI strictly negative
 *                               (decline) — picks `stalling` first,
 *                               then `stalled-finished`
 *   - pattern-recurring       — applied-pattern watcher `recurring`
 *   - debt-spinning           — top knowledge-debt clusters by size
 *                               (V1: highest count flagged; week-over-
 *                                week growth is a follow-on)
 *
 * **V1 emission scope**: 7 of 9 snapshot kinds emit from the builder
 * pipeline. `pattern-closed` and `pattern-recurring` accept watcher
 * input in the kernel API (the test suite exercises them) but the
 * `surprisesBuilder` Node shell passes an empty `patternWatchers`
 * array — the applied-pattern watcher ledger lives in the SQLite
 * substrate and no SDK accessor for it exists yet. The two pattern-*
 * branches stay dormant until that accessor lands; see the
 * `TODO(applyWatcher-sdk):` marker in
 * `packages/exporter/src/analysis/surprisesBuilder.ts`.
 *
 * **Wave 2 #1 — delta kinds.** Five additional kinds compare the
 * current snapshot against a prior `SurprisesOutput` (loaded from
 * `analysis/archive/surprises-YYYY-MM-DD.json` by the builder):
 *   - `streak-extended` (positive) — same continuation, longer run
 *   - `streak-broken`   (concerning) — prior had a streak, current doesn't
 *   - `trajectory-flip-up`   (positive)   — stalled / absent → accelerating
 *   - `trajectory-flip-down` (concerning) — accelerating / absent → stalled
 *   - `pattern-recurrence-resumed` (concerning) — pattern-closed → -recurring
 *
 * Delta kinds are fail-soft: when `priorSurprises === null` (no
 * archive exists, e.g. first-ever scan) all five skip cleanly and the
 * kernel behaves identically to V1.
 *
 * Pure. Browser-safe (no `node:*` imports). Deterministic — the
 * caller passes `generatedAt` (the kernel does NOT call `Date.now()`),
 * and tie-breaks on stable ids so identical inputs produce identical
 * outputs including ordering.
 *
 * Ranking: score in [0, 1]; output is sorted descending by score, with
 * `id` as the tie-breaker. The score formula is documented per-kind
 * inside `compute*` helpers below — pre-launch placeholders, calibrate
 * once the UI surface accumulates engagement data.
 */

import type { CompositeOutcome } from '@chat-arch/schema';
import { THRESHOLDS } from './thresholds.js';
import type { ItsResult } from './itsAnalysis.js';
import type { ReflexiveResult } from './computeReflexive.js';
import type { WatcherVerdict } from './applyWatcher.js';
import { wilsonCI } from './stats.js';

// ─── Input row shapes ──────────────────────────────────────────────
//
// We accept narrow "Like" interfaces here so the kernel doesn't pull
// in the full exporter-shell builder output types. Anything assignable
// to these (the on-disk sidecar shapes from
// projectTrajectoryBuilder / decisionsBuilder / detectKnowledgeDebt /
// the applied-pattern watcher loop) is accepted.

/** Composite-outcome row paired with the session's terminal timestamp. */
export interface SurpriseCompositeRow {
  readonly sessionId: string;
  /** Unix ms — session terminal timestamp (manifest.updatedAt). */
  readonly updatedAt: number;
  readonly composite: CompositeOutcome;
  /**
   * Project the session belongs to (manifest `projectId`). Optional —
   * sessions without a discovered project are still scored and counted
   * for streaks / base-rate computation, but they're skipped by the
   * same-project gates (e.g. `decision-paid-off`).
   */
  readonly projectId?: string;
}

/** Project-trajectory row — mirrors the on-disk sidecar entry. */
export interface SurpriseTrajectoryRow {
  readonly projectId: string;
  readonly projectName: string;
  readonly classification: 'stalling' | 'stalled-finished' | 'accelerating' | 'flat';
  readonly slope: number | null;
  readonly ci: { readonly low: number; readonly high: number } | null;
  readonly totalSessions: number;
  readonly recentSessions: number;
  readonly bootstrapStatus: 'ok' | 'series-too-short';
}

/** Per-pattern watcher verdict pairing — emitted by the curator loop. */
export interface SurpriseWatcherEntry {
  readonly patternId: string;
  readonly projectId: string;
  readonly verdict: WatcherVerdict;
}

/**
 * Knowledge-debt cluster row — mirrors `KnowledgeDebtCluster` plus a
 * passthrough `confidence` so we can de-rank low-confidence clusters.
 */
export interface SurpriseKnowledgeDebtRow {
  readonly id: string;
  readonly canonicalQuestion: string;
  readonly sessionIds: readonly string[];
  readonly confidence: 'high' | 'low';
}

/**
 * Decision row — narrow projection of `Decision` carrying just what
 * the kernel needs (session, outcome score, binary class, optional
 * id for evidence).
 */
export interface SurpriseDecisionRow {
  readonly decisionId: string;
  readonly sessionId: string;
  readonly compositeScore: number;
  readonly binaryClass: 'good' | 'bad' | 'neutral';
  /** Short label rendered into the summary; falls back to "a decision". */
  readonly label?: string;
  /**
   * Project the decision-session belongs to. Required for the
   * `decision-paid-off` same-project followup gate; rows without a
   * projectId are skipped entirely by that branch (the decision can
   * still appear as `unscoped` evidence but we won't claim it "paid
   * off" without scoping).
   */
  readonly projectId?: string;
}

// ─── Output schema ─────────────────────────────────────────────────

export type SurpriseKind =
  | 'streak'
  | 'trajectory-accelerating'
  | 'config-helped'
  | 'pattern-closed'
  | 'reflexive-positive'
  | 'decision-paid-off'
  | 'trajectory-stalled'
  | 'pattern-recurring'
  | 'debt-spinning'
  // Wave 2 #1 — delta kinds (require a `priorSurprises` input). When
  // the prior snapshot is null the kernel skips all five cleanly.
  | 'streak-extended'
  | 'streak-broken'
  | 'trajectory-flip-up'
  | 'trajectory-flip-down'
  | 'pattern-recurrence-resumed';

export type SurpriseTone = 'positive' | 'concerning';

export interface SurpriseEvidence {
  readonly sessionIds?: readonly string[];
  readonly projectId?: string;
  readonly narrativeId?: string;
  readonly configSha?: string;
  readonly decisionId?: string;
}

export interface Surprise {
  /** Stable id derived from kind + evidence (deterministic ordering). */
  readonly id: string;
  readonly kind: SurpriseKind;
  readonly tone: SurpriseTone;
  /** ≤ 120 chars. */
  readonly summary: string;
  readonly evidence: SurpriseEvidence;
  /** 0..1 — higher means more surface-worthy. */
  readonly score: number;
  /** Mirrors the file-level `generatedAt`; carried per-row for downstream
   *  filters that ingest individual surprises. */
  readonly generatedAt: number;
}

/** Subset of THRESHOLDS we expose with the file so the UI can disclaim. */
export interface SurpriseThresholdsSnapshot {
  readonly streakMin: number;
  readonly itsQValueMax: number;
  readonly itsDeltaMin: number;
  readonly reflexiveDeltaMin: number;
  readonly reflexiveEValueMin: number;
  readonly decisionGoodFollowupsMin: number;
  readonly debtSpinningTopK: number;
  readonly debtSpinningMinClusterSize: number;
}

export interface SurprisesOutput {
  readonly version: 1;
  readonly generatedAt: number;
  readonly surprises: readonly Surprise[];
  readonly thresholds: SurpriseThresholdsSnapshot;
}

export interface ComputeSurprisesInput {
  /** Unix ms — must be passed in (kernel does NOT call Date.now()). */
  readonly generatedAt: number;
  /** Composite-outcome rows for every scored session. */
  readonly composites: readonly SurpriseCompositeRow[];
  /** Per-project trajectory rows (one per project). */
  readonly trajectories: readonly SurpriseTrajectoryRow[];
  /** ITS contrast rows (one per config commit analyzed). */
  readonly itsResults: readonly ItsResult[];
  /**
   * Applied-pattern watcher verdicts — one per (pattern, project) the
   * curator loop tracked. The kernel surfaces `holding` as `pattern-
   * closed` and `recurring` as `pattern-recurring`; other verdicts
   * (`open`, `inconclusive`) are ignored.
   */
  readonly patternWatchers: readonly SurpriseWatcherEntry[];
  /** Reflexive result — single row (the whole-corpus contrast). */
  readonly reflexive: ReflexiveResult | null;
  /** Decision rows (post outcome-join). */
  readonly decisions: readonly SurpriseDecisionRow[];
  /** Knowledge-debt clusters. */
  readonly knowledgeDebt: readonly SurpriseKnowledgeDebtRow[];
  /**
   * Wave 2 #1 — most recent prior `SurprisesOutput` (typically loaded
   * from `analysis/archive/surprises-YYYY-MM-DD.json` by the builder).
   * When `null`, the delta kinds (`streak-extended` / `streak-broken` /
   * `trajectory-flip-up` / `trajectory-flip-down` /
   * `pattern-recurrence-resumed`) skip cleanly and the kernel behaves
   * identically to the V1 snapshot-only pipeline.
   */
  readonly priorSurprises?: SurprisesOutput | null;
}

export interface ComputeSurprisesOptions {
  /**
   * Override the minimum streak length. Defaults to
   * `THRESHOLDS.surprises.streakMin`. Tests use this to drive boundary
   * cases without forking the threshold table.
   */
  readonly streakMin?: number;
  /**
   * ITS BH-FDR qValue ceiling — a contrast counts as "config-helped"
   * when `qValue ≤ itsQValueMax` AND `deltaGoodShare ≥ itsDeltaMin`.
   * Defaults to `THRESHOLDS.surprises.itsQValueMax` /
   * `.itsDeltaMin`.
   */
  readonly itsQValueMax?: number;
  readonly itsDeltaMin?: number;
  /**
   * Reflexive minimum mean-delta (good-share delta) to surface. Also
   * requires the CI to be strictly positive (low > 0) AND
   * `eValueCIBound ≥ reflexiveEValueMin`. Defaults to
   * `THRESHOLDS.surprises.reflexiveDeltaMin` /
   * `.reflexiveEValueMin`.
   */
  readonly reflexiveDeltaMin?: number;
  /**
   * Reflexive E-value CI-bound floor. Defaults to
   * `THRESHOLDS.surprises.reflexiveEValueMin`. Smaller values make
   * the gate looser; the surprise is associational, not causal, so
   * the E-value floor protects against surfacing a contrast a single
   * weak unobserved confounder could explain away.
   */
  readonly reflexiveEValueMin?: number;
  /**
   * `decision-paid-off`: minimum number of additional good composite
   * outcomes IN THE SAME PROJECT that must follow the decision's
   * session. Defaults to `THRESHOLDS.surprises.decisionGoodFollowupsMin`.
   * The kernel also requires the followup good-rate's Wilson lower
   * bound (α=0.05) to exceed the corpus base good-share — see
   * `computeDecisionPaidOff` for the math.
   */
  readonly decisionGoodFollowupsMin?: number;
  /**
   * Top-K knowledge-debt clusters surfaced as `debt-spinning`.
   * Defaults to `THRESHOLDS.surprises.debtSpinningTopK`.
   */
  readonly debtSpinningTopK?: number;
  /**
   * Minimum cluster size for `debt-spinning`. Defaults to
   * `THRESHOLDS.surprises.debtSpinningMinClusterSize`.
   */
  readonly debtSpinningMinClusterSize?: number;
}

// ─── Kernel entry point ────────────────────────────────────────────

export function computeSurprises(
  input: ComputeSurprisesInput,
  options: ComputeSurprisesOptions = {},
): SurprisesOutput {
  // All defaults route through THRESHOLDS.surprises so the no-hardcoded-
  // numbers rule applies uniformly. Test overrides flow through `options`
  // unchanged.
  const defaults = THRESHOLDS.surprises;
  const opts = {
    streakMin: options.streakMin ?? defaults.streakMin,
    itsQValueMax: options.itsQValueMax ?? defaults.itsQValueMax,
    itsDeltaMin: options.itsDeltaMin ?? defaults.itsDeltaMin,
    reflexiveDeltaMin: options.reflexiveDeltaMin ?? defaults.reflexiveDeltaMin,
    reflexiveEValueMin:
      options.reflexiveEValueMin ?? defaults.reflexiveEValueMin,
    decisionGoodFollowupsMin:
      options.decisionGoodFollowupsMin ?? defaults.decisionGoodFollowupsMin,
    debtSpinningTopK: options.debtSpinningTopK ?? defaults.debtSpinningTopK,
    debtSpinningMinClusterSize:
      options.debtSpinningMinClusterSize ?? defaults.debtSpinningMinClusterSize,
  };

  const surprises: Surprise[] = [];

  // Snapshot kinds (V1) — emit regardless of `priorSurprises`.
  const streakRows = computeStreak(input, opts);
  pushAll(surprises, streakRows);
  pushAll(surprises, computeTrajectoryAccelerating(input));
  pushAll(surprises, computeConfigHelped(input, opts));
  pushAll(surprises, computePatternClosed(input));
  pushAll(surprises, computeReflexivePositive(input, opts));
  pushAll(surprises, computeDecisionPaidOff(input, opts));
  pushAll(surprises, computeTrajectoryStalled(input));
  pushAll(surprises, computePatternRecurring(input));
  pushAll(surprises, computeDebtSpinning(input, opts));

  // Wave 2 #1 — delta kinds. Each helper guards on `priorSurprises ===
  // null` and returns [] cleanly, so passing the current streak rows
  // (which the streak-extended kernel needs) is safe even on a
  // first-ever scan.
  //
  // Wave-2 review iter-1 fix (B3): defend against threshold drift
  // between scans. If the operator bumped THRESHOLDS.surprises.streakMin
  // (e.g. 3 → 5) between this scan and the archived prior, the prior
  // file's `streak` rows were emitted under a looser gate — comparing
  // them against the current run's tighter gate produces spurious
  // streak-broken / streak-extended emissions because the corpus is
  // unchanged but the threshold isn't. The schema exposes prior.thresholds
  // so we can detect drift and fail soft: skip the affected delta kind
  // entirely (degrade to V1-snapshot behavior for that kind) when the
  // gate doesn't match. The streak delta family is the only one with
  // a single-threshold dependency today; trajectory + pattern deltas
  // don't yet expose a threshold-snapshot to compare against.
  const prior = input.priorSurprises ?? null;
  const streakGateMatches =
    prior === null || prior.thresholds.streakMin === opts.streakMin;
  if (streakGateMatches) {
    pushAll(surprises, computeStreakExtended(prior, streakRows));
    pushAll(surprises, computeStreakBroken(prior, streakRows));
  }
  pushAll(surprises, computeTrajectoryFlipUp(input, prior));
  pushAll(surprises, computeTrajectoryFlipDown(input, prior));
  pushAll(surprises, computePatternRecurrenceResumed(input, prior));

  // Stamp generatedAt on every row + stable-sort. Tie-break on id so
  // equal-score rows still come out in a deterministic order.
  const stamped = surprises.map((s) => ({ ...s, generatedAt: input.generatedAt }));
  stamped.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return {
    version: 1,
    generatedAt: input.generatedAt,
    surprises: stamped,
    thresholds: {
      streakMin: opts.streakMin,
      itsQValueMax: opts.itsQValueMax,
      itsDeltaMin: opts.itsDeltaMin,
      reflexiveDeltaMin: opts.reflexiveDeltaMin,
      reflexiveEValueMin: opts.reflexiveEValueMin,
      decisionGoodFollowupsMin: opts.decisionGoodFollowupsMin,
      debtSpinningTopK: opts.debtSpinningTopK,
      debtSpinningMinClusterSize: opts.debtSpinningMinClusterSize,
    },
  };
}

// ─── Per-kind compute helpers ──────────────────────────────────────

/**
 * `streak`: find the LONGEST suffix run of composite-good sessions
 * (ordered by `updatedAt`). Emits one surprise when the run length
 * meets or exceeds `streakMin`. Boundary case: the run is computed as
 * the trailing run only — we want to surface "currently on a hot
 * streak", not "you once had 10 in a row last year".
 *
 * Score: saturating in run length. `min(1, runLength / (streakMin * 2))`
 * — at exactly the threshold, score = 0.5; double the threshold caps
 * the score at 1.
 */
function computeStreak(
  input: ComputeSurprisesInput,
  opts: { streakMin: number },
): Surprise[] {
  const sorted = input.composites
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt || a.sessionId.localeCompare(b.sessionId));

  const runIds: string[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const row = sorted[i] as SurpriseCompositeRow;
    if (row.composite.binary === 'good') {
      runIds.unshift(row.sessionId);
    } else {
      break;
    }
  }
  if (runIds.length < opts.streakMin) return [];

  const score = Math.min(1, runIds.length / (opts.streakMin * 2));
  return [
    {
      id: `streak:${runIds[runIds.length - 1] as string}`,
      kind: 'streak',
      tone: 'positive',
      summary: clip(
        `${runIds.length} sessions in a row landed as composite-good.`,
      ),
      evidence: { sessionIds: runIds },
      score,
      generatedAt: 0,
    },
  ];
}

/**
 * `trajectory-accelerating`: project rows with `classification ===
 * 'accelerating'` (the trajectory builder already imposes CI strictly
 * positive). One surprise per project. Score scales with slope.
 *
 * Score: `min(1, slope * 5)` — a slope of 0.2 per session caps the
 * score at 1; smaller slopes scale down. Pre-launch placeholder.
 */
function computeTrajectoryAccelerating(
  input: ComputeSurprisesInput,
): Surprise[] {
  const out: Surprise[] = [];
  for (const t of input.trajectories) {
    if (t.classification !== 'accelerating') continue;
    const slope = t.slope ?? 0;
    const score = Math.max(0, Math.min(1, slope * 5));
    out.push({
      id: `trajectory-accelerating:${t.projectId}`,
      kind: 'trajectory-accelerating',
      tone: 'positive',
      summary: clip(
        `${t.projectName} is on an accelerating slope (${slope.toFixed(2)}/session).`,
      ),
      evidence: { projectId: t.projectId },
      score,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `config-helped`: ITS contrasts with `qValue ≤ itsQValueMax` AND
 * `deltaGoodShare ≥ itsDeltaMin`. One surprise per qualifying commit.
 *
 * Score: `min(1, deltaGoodShare * 2)` — a 50pp delta caps at 1. We
 * don't fold q-value into the score (it's a gating mechanism only;
 * folding both would double-count statistical significance).
 */
function computeConfigHelped(
  input: ComputeSurprisesInput,
  opts: { itsQValueMax: number; itsDeltaMin: number },
): Surprise[] {
  const out: Surprise[] = [];
  for (const r of input.itsResults) {
    if (!Number.isFinite(r.qValue) || r.qValue > opts.itsQValueMax) continue;
    if (!Number.isFinite(r.deltaGoodShare) || r.deltaGoodShare < opts.itsDeltaMin) continue;
    const score = Math.max(0, Math.min(1, r.deltaGoodShare * 2));
    out.push({
      id: `config-helped:${r.sha}`,
      kind: 'config-helped',
      tone: 'positive',
      summary: clip(
        `Config change ${shortSha(r.sha)} (${r.subject}) lifted good-share by ` +
          `${(r.deltaGoodShare * 100).toFixed(0)}pp.`,
      ),
      evidence: { configSha: r.sha },
      score,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `pattern-closed`: applied-pattern watcher returned `holding`. The
 * watcher kernel already enforces "N sessions cleared + no recurrence
 * + project still active" so we just need to surface those rows.
 *
 * Score: `1 - failureRateUpperBound95` — at N=5 the Wilson UB is
 * ~0.52 so score ~0.48; at N=20 it tightens to ~0.84. More sessions
 * cleared → tighter confidence → higher surprise score.
 */
function computePatternClosed(input: ComputeSurprisesInput): Surprise[] {
  const out: Surprise[] = [];
  for (const w of input.patternWatchers) {
    if (w.verdict.kind !== 'holding') continue;
    const score = Math.max(0, Math.min(1, 1 - w.verdict.failureRateUpperBound95));
    out.push({
      id: `pattern-closed:${w.patternId}`,
      kind: 'pattern-closed',
      tone: 'positive',
      summary: clip(
        `Pattern ${w.patternId} held — ${w.verdict.sessionsObserved} clean ` +
          `sessions, no recurrence.`,
      ),
      evidence: { projectId: w.projectId, narrativeId: w.patternId },
      score,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `reflexive-positive`: three-gate associational surprise.
 *
 *   1. `meanDelta ≥ reflexiveDeltaMin` — practical significance.
 *   2. `ci.low > 0` — Wilson CI strictly positive (not just a
 *      directional point estimate; we want some inferential
 *      confidence the contrast isn't noise).
 *   3. `eValueStatus === 'computed' && eValueCIBound ≥
 *      reflexiveEValueMin` — VanderWeele & Ding (2017) E-value on the
 *      CI bound nearest the null. If the E-value is small, a
 *      modestly-strong unobserved confounder could drag the
 *      observation to RR=1. We refuse to surface contrasts that are
 *      one weak confounder away from disappearing.
 *
 * Iter-1 adversarial finding: prior version emitted on (1)+(2) and
 * called the contrast a "lift" — both the gating and the copy
 * suggested a causal interpretation the matched-pair primitive
 * doesn't support. Tightened to gate on E-value AND softened the
 * verb to "is associated with" to match the methodology disclosure
 * the viewer already shows.
 *
 * One surprise at most (reflexive is whole-corpus).
 *
 * Score: `min(1, meanDelta * 2)` — same convention as config-helped.
 */
function computeReflexivePositive(
  input: ComputeSurprisesInput,
  opts: { reflexiveDeltaMin: number; reflexiveEValueMin: number },
): Surprise[] {
  const r = input.reflexive;
  if (r === null) return [];
  if (!Number.isFinite(r.meanDelta) || r.meanDelta < opts.reflexiveDeltaMin) return [];
  if (r.ci.low <= 0) return [];
  // E-value sensitivity gate. `'ci-straddles-null'` / `'p-control-zero'`
  // mean the kernel couldn't compute a meaningful E-value at all —
  // those cases fail the gate by definition.
  if (
    r.eValueStatus !== 'computed' ||
    r.eValueCIBound === null ||
    !Number.isFinite(r.eValueCIBound) ||
    r.eValueCIBound < opts.reflexiveEValueMin
  ) {
    return [];
  }
  const score = Math.max(0, Math.min(1, r.meanDelta * 2));
  return [
    {
      id: 'reflexive-positive:whole-corpus',
      kind: 'reflexive-positive',
      tone: 'positive',
      // Associational language (not "lifted") — the matched-pair
      // primitive is descriptive, the E-value is sensitivity-bounded.
      summary: clip(
        `Touching chat-arch is associated with +${(r.meanDelta * 100).toFixed(0)}pp ` +
          `good-share (CI low ${(r.ci.low * 100).toFixed(0)}pp, E-value ${r.eValueCIBound.toFixed(2)}).`,
      ),
      evidence: {
        sessionIds: r.pairs.map((p) => p.treatedSessionId),
      },
      score,
      generatedAt: 0,
    },
  ];
}

/**
 * `decision-paid-off`: a decision whose outcome was `good` AND was
 * followed by at least `decisionGoodFollowupsMin` additional good
 * composite outcomes IN THE SAME PROJECT, AND whose followup good-
 * rate's Wilson lower bound (α=0.05) exceeds the corpus-wide good
 * base rate.
 *
 * Iter-1 adversarial findings:
 *
 *   - **Cross-project leak.** Prior version counted followups across
 *     the WHOLE corpus, so any decision made early in a productive
 *     week scored "paid off" by virtue of the user shipping in
 *     unrelated projects. Now restricted to same-project followups
 *     (rows where both decision-session and followup-session carry
 *     the same `projectId`).
 *   - **Threshold too loose.** Prior floor was 2 followups; Wilson
 *     lower bound on 2/2 with Beta(1,1) prior is ≈0.16, well below
 *     any plausible base rate. Raised to 5 (see
 *     `THRESHOLDS.surprises.decisionGoodFollowupsMin`).
 *   - **No lift test.** "K good followups happened" doesn't establish
 *     the decision moved the curve — the user might just have a
 *     consistent good week. Added a Wilson-low > base-rate gate so we
 *     only emit when the followup good-rate is provably higher than
 *     the user's typical share.
 *
 * Decisions whose `projectId` is unset are skipped (we cannot scope
 * followups for them); composite rows whose `projectId` is unset are
 * NOT counted as followups (same reason) but ARE counted in the
 * corpus base-rate denominator (every scored session contributes to
 * the user's overall good-share).
 *
 * Score: saturating in followup count. `min(1, (followups + 1) / 10)`.
 */
function computeDecisionPaidOff(
  input: ComputeSurprisesInput,
  opts: { decisionGoodFollowupsMin: number },
): Surprise[] {
  if (input.decisions.length === 0) return [];

  // Corpus-wide base rate of good outcomes. Denominator is every
  // scored composite row (binary !== 'unknown' is the conservative
  // line — 'unknown' rows had no measurable outcome).
  let baseGood = 0;
  let baseDenom = 0;
  for (const row of input.composites) {
    if (row.composite.binary === 'unknown') continue;
    baseDenom += 1;
    if (row.composite.binary === 'good') baseGood += 1;
  }
  // No scored composites at all → no base rate exists → cannot
  // make the lift claim. Fall back to 0 so the Wilson gate trivially
  // passes; the count floor still applies.
  const baseRateGoodShare = baseDenom > 0 ? baseGood / baseDenom : 0;

  // Build a sorted (updatedAt, sessionId) lookup once. O(N log N) once,
  // then O(N) per decision (worst case scans the tail).
  const sessionByUpdatedAt = input.composites
    .slice()
    .sort((a, b) => a.updatedAt - b.updatedAt || a.sessionId.localeCompare(b.sessionId));

  const out: Surprise[] = [];
  for (const d of input.decisions) {
    if (d.binaryClass !== 'good') continue;
    // Same-project scoping requires a projectId on the decision.
    if (d.projectId === undefined) continue;
    // Anchor on this decision's session in the sorted list.
    const anchor = sessionByUpdatedAt.findIndex((s) => s.sessionId === d.sessionId);
    if (anchor === -1) continue;
    let followupsGood = 0;
    let followupsTotal = 0;
    for (let i = anchor + 1; i < sessionByUpdatedAt.length; i += 1) {
      const row = sessionByUpdatedAt[i] as SurpriseCompositeRow;
      // Same-project gate; skip cross-project ships entirely.
      if (row.projectId === undefined || row.projectId !== d.projectId) continue;
      if (row.composite.binary === 'unknown') continue;
      followupsTotal += 1;
      if (row.composite.binary === 'good') followupsGood += 1;
    }
    if (followupsGood < opts.decisionGoodFollowupsMin) continue;
    // Wilson lower bound on the followup good-rate. Only emit when it
    // strictly exceeds the corpus base rate — i.e. the decision is
    // followed by a *higher* good-share than the user's typical week,
    // with enough samples that the lower bound clears the bar.
    const wilson = wilsonCI(followupsGood / followupsTotal, followupsTotal);
    if (wilson.low <= baseRateGoodShare) continue;
    const score = Math.max(0, Math.min(1, (followupsGood + 1) / 10));
    const label = d.label ?? 'a decision';
    out.push({
      id: `decision-paid-off:${d.decisionId}`,
      kind: 'decision-paid-off',
      tone: 'positive',
      // Summary surfaces the lift: same-project K/N + Wilson-low + base
      // rate. The user can see at a glance that we're not just counting
      // good sessions in a row.
      summary: clip(
        `${label} paid off — same-project followups: ${followupsGood}/${followupsTotal} good ` +
          `(Wilson low ${wilson.low.toFixed(2)}, base rate ${baseRateGoodShare.toFixed(2)}).`,
      ),
      evidence: { decisionId: d.decisionId, sessionIds: [d.sessionId] },
      score,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `trajectory-stalled`: project classified `stalling` or
 * `stalled-finished`. Score weights `stalling` higher because it's an
 * active decline (the user can still intervene); `stalled-finished` is
 * a quieter retrospective signal.
 */
function computeTrajectoryStalled(
  input: ComputeSurprisesInput,
): Surprise[] {
  const out: Surprise[] = [];
  for (const t of input.trajectories) {
    if (t.classification !== 'stalling' && t.classification !== 'stalled-finished') {
      continue;
    }
    const slope = t.slope ?? 0;
    const baseScore = Math.max(0, Math.min(1, Math.abs(slope) * 5));
    // Bias active stalling above finished — same severity gets +0.2.
    const score = Math.min(1, baseScore + (t.classification === 'stalling' ? 0.2 : 0));
    const summary =
      t.classification === 'stalling'
        ? `${t.projectName} is actively stalling (slope ${slope.toFixed(2)}/session).`
        : `${t.projectName} stalled out — slope ${slope.toFixed(2)}/session, no recent activity.`;
    out.push({
      id: `trajectory-stalled:${t.projectId}`,
      kind: 'trajectory-stalled',
      tone: 'concerning',
      summary: clip(summary),
      evidence: { projectId: t.projectId },
      score,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `pattern-recurring`: watcher returned `recurring`. Score fixed at
 * 0.9 — this is a strong signal regardless of how many sessions
 * passed first; the user told the assistant "follow this rule" and
 * the rule failed.
 */
function computePatternRecurring(input: ComputeSurprisesInput): Surprise[] {
  const out: Surprise[] = [];
  for (const w of input.patternWatchers) {
    if (w.verdict.kind !== 'recurring') continue;
    out.push({
      id: `pattern-recurring:${w.patternId}`,
      kind: 'pattern-recurring',
      tone: 'concerning',
      summary: clip(
        `Pattern ${w.patternId} recurred — narrative ${w.verdict.recurrenceNarrativeId} ` +
          `re-fired after application.`,
      ),
      evidence: {
        projectId: w.projectId,
        narrativeId: w.verdict.recurrenceNarrativeId,
      },
      score: 0.9,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `debt-spinning`: V1 surfaces the top-K knowledge-debt clusters by
 * sessionIds.length whose size meets `debtSpinningMinClusterSize`.
 * Week-over-week growth is a follow-on — V1 just flags "this
 * question keeps coming back".
 *
 * Score: saturating in size. `min(1, size / 20)` — a 20-member
 * cluster caps the score at 1. Low-confidence clusters get a 0.7×
 * multiplier (they were resolved via TF-IDF, not embeddings).
 */
function computeDebtSpinning(
  input: ComputeSurprisesInput,
  opts: { debtSpinningTopK: number; debtSpinningMinClusterSize: number },
): Surprise[] {
  const eligible = input.knowledgeDebt
    .filter((c) => c.sessionIds.length >= opts.debtSpinningMinClusterSize)
    .slice()
    .sort(
      (a, b) =>
        b.sessionIds.length - a.sessionIds.length || a.id.localeCompare(b.id),
    );
  const topK = eligible.slice(0, opts.debtSpinningTopK);

  return topK.map<Surprise>((c) => {
    const size = c.sessionIds.length;
    const base = Math.min(1, size / 20);
    const score = c.confidence === 'low' ? base * 0.7 : base;
    return {
      id: `debt-spinning:${c.id}`,
      kind: 'debt-spinning',
      tone: 'concerning',
      summary: clip(
        `"${c.canonicalQuestion}" — ${size} sessions keep asking this.`,
      ),
      evidence: { sessionIds: c.sessionIds },
      score,
      generatedAt: 0,
    };
  });
}

// ─── Delta-kind compute helpers (Wave 2 #1) ────────────────────────
//
// Each helper takes the prior `SurprisesOutput` (loaded by the builder
// from the most recent archive) plus whatever current-scan inputs it
// needs. All five return [] cleanly when `prior === null` — the kernel
// stays identical to V1 on a first-ever scan.

/**
 * `streak-extended` (positive) — the current streak shares its
 * terminal `lastSessionId` with the prior streak's terminal session AND
 * has grown in length. Same `lastSessionId` is the continuation
 * predicate: a new "currently on a streak" with a different terminal
 * session is a fresh streak, not an extension.
 *
 * Score: `clamp(diff / 5, 0, 1)` — a +5-session jump caps at 1.
 */
function computeStreakExtended(
  prior: SurprisesOutput | null,
  currentStreakRows: readonly Surprise[],
): Surprise[] {
  if (prior === null) return [];
  const priorStreak = prior.surprises.find((s) => s.kind === 'streak');
  if (priorStreak === undefined) return [];
  const currentStreak = currentStreakRows.find((s) => s.kind === 'streak');
  if (currentStreak === undefined) return [];

  const priorIds = priorStreak.evidence.sessionIds ?? [];
  const currentIds = currentStreak.evidence.sessionIds ?? [];
  if (priorIds.length === 0 || currentIds.length === 0) return [];

  const priorLast = priorIds[priorIds.length - 1] as string;
  const currentLast = currentIds[currentIds.length - 1] as string;
  if (priorLast !== currentLast) return [];

  const diff = currentIds.length - priorIds.length;
  if (diff <= 0) return [];

  const score = Math.max(0, Math.min(1, diff / 5));
  return [
    {
      id: `streak-extended:${currentLast}`,
      kind: 'streak-extended',
      tone: 'positive',
      summary: clip(
        `Streak grew by ${diff} session${diff === 1 ? '' : 's'} since last scan (now ${currentIds.length}).`,
      ),
      evidence: { sessionIds: currentIds },
      score,
      generatedAt: 0,
    },
  ];
}

/**
 * `streak-broken` (concerning) — the prior snapshot had a `streak` row
 * and the current snapshot does NOT. The score scales with the size of
 * the lost streak.
 *
 * Score: `clamp(priorStreakCount / 10, 0, 1)`.
 */
function computeStreakBroken(
  prior: SurprisesOutput | null,
  currentStreakRows: readonly Surprise[],
): Surprise[] {
  if (prior === null) return [];
  const priorStreak = prior.surprises.find((s) => s.kind === 'streak');
  if (priorStreak === undefined) return [];
  const currentStreak = currentStreakRows.find((s) => s.kind === 'streak');
  if (currentStreak !== undefined) return [];

  const priorIds = priorStreak.evidence.sessionIds ?? [];
  if (priorIds.length === 0) return [];

  const priorLast = priorIds[priorIds.length - 1] as string;
  const score = Math.max(0, Math.min(1, priorIds.length / 10));
  return [
    {
      id: `streak-broken:${priorLast}`,
      kind: 'streak-broken',
      tone: 'concerning',
      summary: clip(
        `Streak ended — prior run of ${priorIds.length} good sessions did not continue.`,
      ),
      evidence: { sessionIds: priorIds },
      score,
      generatedAt: 0,
    },
  ];
}

/**
 * `trajectory-flip-up` (positive) — a project that was `trajectory-
 * stalled` (or absent from prior) in the prior snapshot is now
 * `trajectory-accelerating`. Score scales with the current slope.
 *
 * Score: `clamp(currentSlope * 10, 0, 1)`.
 */
function computeTrajectoryFlipUp(
  input: ComputeSurprisesInput,
  prior: SurprisesOutput | null,
): Surprise[] {
  if (prior === null) return [];

  const priorByProject = new Map<string, SurpriseKind>();
  for (const s of prior.surprises) {
    if (s.kind !== 'trajectory-accelerating' && s.kind !== 'trajectory-stalled') {
      continue;
    }
    const pid = s.evidence.projectId;
    if (pid === undefined) continue;
    priorByProject.set(pid, s.kind);
  }

  const out: Surprise[] = [];
  for (const t of input.trajectories) {
    if (t.classification !== 'accelerating') continue;
    const priorKind = priorByProject.get(t.projectId);
    // Wave-2 review iter-1 fix (B1): tightened from "stalled OR absent
    // qualifies" to "ONLY stalled qualifies." Reason: a project absent
    // from prior could be (a) genuinely new, or (b) classified `flat` /
    // `series-too-short` in prior so the trajectory kernel emitted
    // nothing. Case (b) is NOT a directional change — the slope just
    // tightened — so claiming a flip is a false positive. The narrower
    // gate loses the freshly-discovered-accelerating-project case (V1
    // tradeoff: better to silently miss than to noisily lie).
    if (priorKind !== 'trajectory-stalled') continue;
    const slope = t.slope ?? 0;
    const score = Math.max(0, Math.min(1, slope * 10));
    out.push({
      id: `trajectory-flip-up:${t.projectId}`,
      kind: 'trajectory-flip-up',
      tone: 'positive',
      summary: clip(
        `${t.projectName} flipped to accelerating (slope ${slope.toFixed(2)}/session) since last scan.`,
      ),
      evidence: { projectId: t.projectId },
      score,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `trajectory-flip-down` (concerning) — mirror of flip-up: a project
 * that was `trajectory-accelerating` (or absent) is now stalled.
 *
 * Score: `clamp(|currentSlope| * 10, 0, 1)`.
 */
function computeTrajectoryFlipDown(
  input: ComputeSurprisesInput,
  prior: SurprisesOutput | null,
): Surprise[] {
  if (prior === null) return [];

  const priorByProject = new Map<string, SurpriseKind>();
  for (const s of prior.surprises) {
    if (s.kind !== 'trajectory-accelerating' && s.kind !== 'trajectory-stalled') {
      continue;
    }
    const pid = s.evidence.projectId;
    if (pid === undefined) continue;
    priorByProject.set(pid, s.kind);
  }

  const out: Surprise[] = [];
  for (const t of input.trajectories) {
    if (t.classification !== 'stalling' && t.classification !== 'stalled-finished') {
      continue;
    }
    const priorKind = priorByProject.get(t.projectId);
    // Wave-2 review iter-1 fix (B1): tightened — only emit when prior
    // explicitly had `trajectory-accelerating`. Absent-in-prior may be
    // a project that was `flat` (not a downward direction). See flip-up
    // for the symmetric rationale.
    if (priorKind !== 'trajectory-accelerating') continue;
    const slope = t.slope ?? 0;
    const score = Math.max(0, Math.min(1, Math.abs(slope) * 10));
    out.push({
      id: `trajectory-flip-down:${t.projectId}`,
      kind: 'trajectory-flip-down',
      tone: 'concerning',
      summary: clip(
        `${t.projectName} flipped to ${t.classification} (slope ${slope.toFixed(2)}/session) since last scan.`,
      ),
      evidence: { projectId: t.projectId },
      score,
      generatedAt: 0,
    });
  }
  return out;
}

/**
 * `pattern-recurrence-resumed` (concerning) — a pattern that was
 * `pattern-closed` in the prior snapshot is now `pattern-recurring` in
 * the current one (same patternId). High-attention signal: the user
 * encoded a rule, it held, and now it's failing again.
 *
 * Score: fixed at 0.85.
 */
function computePatternRecurrenceResumed(
  input: ComputeSurprisesInput,
  prior: SurprisesOutput | null,
): Surprise[] {
  if (prior === null) return [];

  // Wave-2 review iter-1 fix (B2): track prior pattern-closed SCORE per
  // patternId (not just ID presence). The closed-score directly encodes
  // hold strength via `1 - failureRateUpperBound95` — a 5-session hold
  // that recurs is materially weaker evidence than a 50-session hold
  // that recurs. Previously fixed score 0.85 forced every recurrence
  // into the STRONG tier (>= 0.75) regardless of underlying strength,
  // undermining the confidence ladder feedback_confidence_per_step asks
  // for. Now we propagate the prior score (floor 0.5 so a closed-then-
  // recurred surprise stays at least MODERATE — it's still a real
  // signal even if the prior hold was weak).
  const priorClosedScoreByPattern = new Map<string, number>();
  for (const s of prior.surprises) {
    if (s.kind !== 'pattern-closed') continue;
    const nid = s.evidence.narrativeId;
    if (typeof nid === 'string' && nid.length > 0) {
      priorClosedScoreByPattern.set(nid, s.score);
    }
  }
  if (priorClosedScoreByPattern.size === 0) return [];

  const out: Surprise[] = [];
  for (const w of input.patternWatchers) {
    if (w.verdict.kind !== 'recurring') continue;
    const priorScore = priorClosedScoreByPattern.get(w.patternId);
    if (priorScore === undefined) continue;
    out.push({
      id: `pattern-recurrence-resumed:${w.patternId}`,
      kind: 'pattern-recurrence-resumed',
      tone: 'concerning',
      summary: clip(
        `Pattern ${w.patternId} re-fired after previously holding — narrative ${w.verdict.recurrenceNarrativeId}.`,
      ),
      evidence: {
        projectId: w.projectId,
        narrativeId: w.verdict.recurrenceNarrativeId,
      },
      // Floor at 0.5 so a recurrence is at least MODERATE; ceiling at
      // 0.95 so an unusually strong prior hold doesn't pin every
      // recurrence at perfect-1.0 (rooms for genuine 1.0 elsewhere).
      score: Math.max(0.5, Math.min(0.95, priorScore)),
      generatedAt: 0,
    });
  }
  return out;
}

// ─── helpers ───────────────────────────────────────────────────────

/**
 * UI confidence tier — coarsens a raw [0,1] surprise score into one of
 * three buckets the FEED renders as a labeled ribbon next to the kind
 * badge. The mapping is intentionally independent of the per-kind
 * statistical gates in THRESHOLDS.surprises (those are kernel-emission
 * floors; this is a downstream presentation layer that ranks the
 * surfaces that DID emit). The boundaries are pre-launch placeholders
 * — once we have engagement data we can calibrate WEAK against
 * "ignored" rate and STRONG against "clicked through" rate.
 *
 *   - `STRONG`   — score ≥ 0.75. Highly surface-worthy; load-bearing.
 *   - `MODERATE` — score ≥ 0.5.  Worth a look; mid-band.
 *   - `WEAK`     — score <  0.5.  Speculative; surface-but-discount.
 *
 * Memory: feedback_confidence_per_step — when the UI ladders rows by
 * score, the score band must be labeled, not just numerically encoded;
 * otherwise later rungs inherit the certainty of earlier ones.
 */
export type SurpriseConfidenceTier = 'STRONG' | 'MODERATE' | 'WEAK';

export const SURPRISE_TIER_STRONG_MIN = 0.75;
export const SURPRISE_TIER_MODERATE_MIN = 0.5;

export function surpriseConfidenceTier(score: number): SurpriseConfidenceTier {
  if (!Number.isFinite(score)) return 'WEAK';
  if (score >= SURPRISE_TIER_STRONG_MIN) return 'STRONG';
  if (score >= SURPRISE_TIER_MODERATE_MIN) return 'MODERATE';
  return 'WEAK';
}

function pushAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

/** Truncate to 120 chars — schema contract for `summary`. */
function clip(s: string): string {
  const max = 120;
  if (s.length <= max) return s;
  // Reserve 1 char for the ellipsis. `…` is one codepoint.
  return `${s.slice(0, max - 1)}…`;
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

// Re-export the THRESHOLDS reference so this kernel stays discoverable
// via the analysis package barrel. (Imported above so the bundler
// tree-shakes appropriately.)
export { THRESHOLDS };
