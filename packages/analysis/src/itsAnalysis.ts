/**
 * Interrupted Time Series (ITS) kernel — Phase 1 expansion #2 (config-
 * correlation).
 *
 * For each known config-change timestamp (a commit touching CLAUDE.md /
 * a skill / settings.json), compute pre-window vs. post-window composite
 * means and binarized-good shares. Wilson CI is computed on the delta
 * of the binarized-good shares so the viewer can render a CI ribbon
 * around the contrast.
 *
 * **This is a descriptive contrast, not a causal estimate** — config
 * changes co-vary with everything else the developer happens to be
 * doing that week. The builder is responsible for surfacing that
 * methodology disclosure; the kernel just emits numbers.
 *
 * Pure. Generalizes the snapshot pattern in `upgradeOutcomes.ts`
 * (which snapshots mean turns / cost / error-rate) — here we snapshot
 * mean composite score + binarized-good share.
 *
 * Browser-safe — no Node-only imports.
 */

import type { CompositeOutcome } from '@chat-arch/schema';
import { mean, wilsonCI } from './stats.js';
import { THRESHOLDS } from './thresholds.js';

export interface ItsOutcomeInput {
  sessionId: string;
  /** Unix ms; the session's terminal timestamp (we attribute the score
   *  to when the session ended, not started — config changes earlier
   *  in a long session can plausibly affect later outcomes too). */
  updatedAt: number;
  composite: CompositeOutcome;
}

export interface ItsConfigCommit {
  sha: string;
  /** Unix ms. */
  ts: number;
  /** Path that the commit touched (CLAUDE.md, .claude/skills/X/SKILL.md, ...). */
  path: string;
  subject: string;
}

export interface ItsSnapshot {
  /** Number of sessions in this window. */
  n: number;
  /** Mean of `composite.score` over the window; NaN when n === 0. */
  meanScore: number;
  /** Share of `composite.binary === 'good'` over the window; NaN when n === 0. */
  goodShare: number;
  /** Wilson 95% CI on the good share. [0, 1] when n === 0. */
  goodShareCI: { low: number; high: number };
}

export interface ItsResult {
  sha: string;
  ts: number;
  path: string;
  subject: string;
  windowDays: number;
  pre: ItsSnapshot;
  post: ItsSnapshot;
  /** post.goodShare - pre.goodShare. */
  deltaGoodShare: number;
  /**
   * Wilson CI on the *difference* of two proportions, approximated via
   * the standard normal-approximation CI on (post.goodShare - pre.goodShare).
   * For very small n the approximation is loose; the viewer hides
   * deltas where either side's n < `THRESHOLDS.display.minNForRate`.
   */
  deltaCI: { low: number; high: number };
}

export interface RunItsAnalysisOptions {
  /** Window size in days; defaults to `THRESHOLDS.trajectory.rollingWindow` (10).
   *  Note: rolling-window threshold is in *sessions*; for ITS we re-purpose
   *  it as a *days* parameter at the kernel level — the builder may pass a
   *  different value if the corpus is dense / sparse. */
  windowDays?: number;
}

const MS_PER_DAY = 86_400_000;
const Z_95 = 1.96;

/**
 * 95% normal-approximation CI on the difference of two independent
 * proportions: (p̂₁ - p̂₂) ± z·√(p̂₁(1-p̂₁)/n₁ + p̂₂(1-p̂₂)/n₂).
 *
 * Falls back to [-1, 1] when either side has n === 0 (no information).
 * Caller (viewer) is responsible for hiding deltas where the CI is too
 * wide to be informative.
 */
function deltaProportionCI(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): { low: number; high: number } {
  if (n1 <= 0 || n2 <= 0) return { low: -1, high: 1 };
  const v1 = (p1 * (1 - p1)) / n1;
  const v2 = (p2 * (1 - p2)) / n2;
  const se = Math.sqrt(v1 + v2);
  const delta = p1 - p2;
  return { low: delta - Z_95 * se, high: delta + Z_95 * se };
}

function snapshot(outcomes: readonly ItsOutcomeInput[]): ItsSnapshot {
  const n = outcomes.length;
  if (n === 0) {
    return {
      n: 0,
      meanScore: Number.NaN,
      goodShare: Number.NaN,
      goodShareCI: { low: 0, high: 1 },
    };
  }
  const scores: number[] = [];
  let goodCount = 0;
  for (const o of outcomes) {
    scores.push(o.composite.score);
    if (o.composite.binary === 'good') goodCount += 1;
  }
  const goodShare = goodCount / n;
  return {
    n,
    meanScore: mean(scores),
    goodShare,
    goodShareCI: wilsonCI(goodShare, n),
  };
}

/**
 * Run an interrupted-time-series snapshot for each provided config
 * commit. Returns one row per commit; commits with both pre and post
 * windows empty are still included so the builder can decide whether
 * to suppress them in the viewer.
 *
 * Outcomes do not need to be pre-sorted; we filter by timestamp
 * window for each commit independently. O(N · M) where N = outcomes,
 * M = commits. For the corpus sizes we care about (M ≲ few hundred)
 * this is fine.
 */
export function runItsAnalysis(
  outcomes: ReadonlyArray<ItsOutcomeInput>,
  configCommits: ReadonlyArray<ItsConfigCommit>,
  options: RunItsAnalysisOptions = {},
): ItsResult[] {
  const windowDays = options.windowDays ?? THRESHOLDS.trajectory.rollingWindow;
  const windowMs = windowDays * MS_PER_DAY;

  const results: ItsResult[] = [];
  for (const commit of configCommits) {
    const preStart = commit.ts - windowMs;
    const postEnd = commit.ts + windowMs;
    const preOutcomes: ItsOutcomeInput[] = [];
    const postOutcomes: ItsOutcomeInput[] = [];
    for (const o of outcomes) {
      if (o.updatedAt >= preStart && o.updatedAt < commit.ts) {
        preOutcomes.push(o);
      } else if (o.updatedAt >= commit.ts && o.updatedAt < postEnd) {
        postOutcomes.push(o);
      }
    }
    const pre = snapshot(preOutcomes);
    const post = snapshot(postOutcomes);
    const deltaGoodShare =
      Number.isNaN(post.goodShare) || Number.isNaN(pre.goodShare)
        ? Number.NaN
        : post.goodShare - pre.goodShare;
    const deltaCI = deltaProportionCI(post.goodShare || 0, post.n, pre.goodShare || 0, pre.n);
    results.push({
      sha: commit.sha,
      ts: commit.ts,
      path: commit.path,
      subject: commit.subject,
      windowDays,
      pre,
      post,
      deltaGoodShare,
      deltaCI,
    });
  }
  return results;
}
