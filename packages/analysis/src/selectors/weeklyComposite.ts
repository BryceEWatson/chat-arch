/**
 * EFFECTIVENESS selector — the `data → view-model` derivation behind the
 * EFFECTIVENESS surface, extracted VERBATIM from `EffectivenessMode.tsx`
 * (Phase 3 of the "Centralize data processing" refactor).
 *
 * `buildWeeklyComposite` turns a `CompositeOutcomesFile` + a
 * sessionId→terminal-timestamp map into the two weekly trajectory series
 * the mode plots:
 *
 *   - `mean`  — per-week mean composite score (continuous, in [0, 1]),
 *     EWMA-smoothed. No Wilson CI for a mean of continuous scores, so the
 *     ribbon bounds equal the raw value (flat band).
 *   - `good`  — per-week binarized-good share, EWMA-smoothed, with a
 *     Wilson 95% CI ribbon (only once n ≥ `minNForRate`; below that the
 *     band collapses to the point).
 *
 * Both series are gap-filled: missing weeks between the first and last
 * observed week become empty (0/0) buckets so the line is continuous —
 * a week you didn't work is information, not noise.
 *
 * Pure / deterministic / React-free. Calls the existing `ewma` and
 * `wilsonCI` kernels — never reimplements a stat. The component renders
 * the returned series and verdict without any further derivation.
 *
 * The Phase-5 precompute (`weeklyCompositeBuilder.ts` →
 * `analysis/weekly-composite.json`) will run THIS SAME kernel so the
 * sidecar path and the in-page fallback can never fork (plan §#1 vs #2).
 */

import type { CompositeOutcomesFile } from '@chat-arch/schema';
import { ewma, wilsonCI } from '../stats.js';
import { THRESHOLDS } from '../thresholds.js';

const WEEK_MS = 7 * 86_400_000;

/**
 * Mirrors the unified entry's startedAt → week-start (UTC Sunday).
 * Floors to UTC midnight, then backs up to the nearest UTC Sunday.
 * Matches the bucketing in the viewer's `data/search.ts` so the bars on
 * the EFFECTIVENESS mode and the SESSIONS Sparkline land on the same
 * calendar weeks.
 */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // getUTCDay: 0 = Sunday. Subtract to land on Sunday.
  return utc - new Date(utc).getUTCDay() * 86_400_000;
}

/** One point on a weekly trajectory series. */
export interface WeeklyCompositePoint {
  /** Unix ms of the week start (UTC Sunday). */
  start: number;
  /** Raw weekly rate in [0, 1]. */
  value: number;
  /** EWMA-smoothed value at this week, in [0, 1]. */
  ewma: number;
  /** Wilson CI lower bound for the rate at this week, in [0, 1]. */
  ciLow: number;
  /** Wilson CI upper bound for the rate at this week, in [0, 1]. */
  ciHigh: number;
  /** Sample size that produced this week's rate. */
  n: number;
}

/** Wilson-tested trajectory verdict over the trailing informative weeks. */
export interface WeeklyCompositeVerdict {
  /** Direction relative to the start of the verdict window. */
  direction: 'up' | 'down' | 'flat';
  /** Signed delta in percentage points (raw-rate, not EWMA). */
  deltaPp: number;
  /** Width of the verdict window, in informative weeks. */
  windowWeeks: number;
}

export interface WeeklyComposite {
  /** Per-week mean composite score (flat CI band). */
  mean: WeeklyCompositePoint[];
  /** Per-week binarized-good share (Wilson CI ribbon). */
  good: WeeklyCompositePoint[];
  /** Count of weeks with n ≥ `minNForRate` — drives the display gate. */
  informativeWeeks: number;
  /** Wilson-tested verdict, or `null` when too few informative weeks. */
  verdict: WeeklyCompositeVerdict | null;
}

interface WeeklyBucket {
  start: number;
  scores: number[];
  good: number;
  total: number;
}

/**
 * Bucket outcomes into calendar weeks, gap-fill, and compute the mean +
 * good-share trajectory series. Returns empty series (and a `null`
 * verdict, `0` informative weeks) for `null` input or no anchorable rows.
 */
export function buildWeeklyComposite(
  outcomes: CompositeOutcomesFile | null,
  sessionUpdatedAt: ReadonlyMap<string, number>,
): WeeklyComposite {
  const buckets = bucketByWeek(outcomes, sessionUpdatedAt);
  const filled = gapFill(buckets);
  if (filled.length === 0) {
    return { mean: [], good: [], informativeWeeks: 0, verdict: null };
  }

  // Mean composite — continuous score, no Wilson CI (flat band).
  const meanRaw = filled.map((b) =>
    b.total === 0 ? 0 : b.scores.reduce((s, x) => s + x, 0) / b.total,
  );
  const meanSmoothed = ewma(meanRaw, THRESHOLDS.ewma.halfLifeWeeks);
  const mean: WeeklyCompositePoint[] = filled.map((b, i) => ({
    start: b.start,
    value: meanRaw[i]!,
    ewma: meanSmoothed[i]!,
    ciLow: meanRaw[i]!,
    ciHigh: meanRaw[i]!,
    n: b.total,
  }));

  // Good share — binarized rate, Wilson 95% CI once n ≥ minNForRate.
  const goodRaw = filled.map((b) => (b.total === 0 ? 0 : b.good / b.total));
  const goodSmoothed = ewma(goodRaw, THRESHOLDS.ewma.halfLifeWeeks);
  const good: WeeklyCompositePoint[] = filled.map((b, i) => {
    const ci =
      b.total >= THRESHOLDS.display.minNForRate
        ? wilsonCI(goodRaw[i]!, b.total)
        : { low: goodRaw[i]!, high: goodRaw[i]! };
    return {
      start: b.start,
      value: goodRaw[i]!,
      ewma: goodSmoothed[i]!,
      ciLow: ci.low,
      ciHigh: ci.high,
      n: b.total,
    };
  });

  const informativeWeeks = filled.filter(
    (b) => b.total >= THRESHOLDS.display.minNForRate,
  ).length;

  return { mean, good, informativeWeeks, verdict: computeVerdict(good) };
}

function bucketByWeek(
  outcomes: CompositeOutcomesFile | null,
  sessionUpdatedAt: ReadonlyMap<string, number>,
): WeeklyBucket[] {
  if (outcomes === null) return [];
  const m = new Map<number, WeeklyBucket>();
  for (const o of outcomes.outcomes) {
    // Skip rows whose hash was rejected by the loader — they're marked
    // `binary: 'unknown'` and have no rate semantics.
    if (o.binary === 'unknown') continue;
    const ts = sessionUpdatedAt.get(o.sessionId);
    if (ts === undefined) continue;
    const w = weekStart(ts);
    let bucket = m.get(w);
    if (bucket === undefined) {
      bucket = { start: w, scores: [], good: 0, total: 0 };
      m.set(w, bucket);
    }
    bucket.scores.push(o.score);
    bucket.total += 1;
    if (o.binary === 'good') bucket.good += 1;
  }
  return [...m.values()].sort((a, b) => a.start - b.start);
}

/**
 * Fill missing weeks with empty buckets so the line is continuous — a
 * gap of 0/0 is information (you didn't work that week), not noise.
 */
function gapFill(buckets: WeeklyBucket[]): WeeklyBucket[] {
  if (buckets.length === 0) return [];
  const out: WeeklyBucket[] = [];
  const first = buckets[0]!.start;
  const last = buckets[buckets.length - 1]!.start;
  const byStart = new Map(buckets.map((b) => [b.start, b] as const));
  for (let ts = first; ts <= last; ts += WEEK_MS) {
    const existing = byStart.get(ts);
    if (existing !== undefined) out.push(existing);
    else out.push({ start: ts, scores: [], good: 0, total: 0 });
  }
  return out;
}

/**
 * Wilson-tested verdict: take up to the last
 * `THRESHOLDS.trajectory.rollingWindow` informative weeks of the good
 * share. Direction is `up` when the latest week's Wilson CI low exceeds
 * the earliest week's CI high (and the raw delta is positive), `down`
 * for the mirror case, and `flat` otherwise. Returns `null` when too few
 * informative weeks are available.
 */
export function computeVerdict(
  series: readonly WeeklyCompositePoint[],
): WeeklyCompositeVerdict | null {
  if (series.length < 2) return null;
  const informative = series.filter(
    (w) => w.n >= THRESHOLDS.display.minNForRate,
  );
  if (informative.length < 2) return null;
  const window = Math.min(
    THRESHOLDS.trajectory.rollingWindow,
    informative.length,
  );
  const slice = informative.slice(-window);
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const deltaPp = (last.value - first.value) * 100;
  let direction: 'up' | 'down' | 'flat' = 'flat';
  if (last.ciLow > first.ciHigh && deltaPp > 0) direction = 'up';
  else if (last.ciHigh < first.ciLow && deltaPp < 0) direction = 'down';
  return { direction, deltaPp, windowWeeks: slice.length };
}
