import { useMemo } from 'react';
import type { CompositeOutcomesFile } from '@chat-arch/schema';
import { THRESHOLDS, ewma, wilsonCI } from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';
import { MethodologyDisclosure } from '../MethodologyDisclosure.js';
import { OutcomeSparkline, type OutcomeWeek } from '../OutcomeSparkline.js';

/**
 * Phase 1 expansion #4 — EFFECTIVENESS mode.
 *
 * Reads `analysis/composite-outcomes.json` and renders the user's
 * weekly trajectory:
 *
 *   1. Weekly mean composite score (continuous, in [0, 1]).
 *   2. Weekly binarized-good share with a Wilson 95% CI ribbon.
 *   3. EWMA smoother (half-life from `THRESHOLDS.ewma.halfLifeWeeks`).
 *
 * Copy is strictly trajectory-oriented — no causal framing. The viewer
 * shows what your weeks look like; it does NOT claim a config change
 * caused a trajectory shift. The Wave 5 lint enforces this; we comply
 * pre-emptively here.
 *
 * Sample-size guards: hides individual weeks when n < `minNForRate`
 * (defaults to 8). The full-mode empty state fires when fewer than
 * `minNForRate` weeks of any data exist.
 */

/** Mirrors the unified entry's startedAt → week-start (UTC Sunday). */
const WEEK_MS = 7 * 86_400_000;
function weekStart(ms: number): number {
  // Floor to UTC midnight, then back up to the nearest UTC Sunday.
  // Matches the bucketing in `data/search.ts` so the bars on this
  // mode and the SESSIONS Sparkline land on the same calendar weeks.
  const d = new Date(ms);
  const utc = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
  );
  // getUTCDay: 0 = Sunday. Subtract to land on Sunday.
  return utc - new Date(utc).getUTCDay() * 86_400_000;
}

interface WeeklyBucket {
  start: number;
  scores: number[];
  good: number;
  total: number;
}

export interface EffectivenessModeProps {
  /**
   * Composite outcomes file. `null` when the kernel hasn't run yet —
   * the mode renders the upstream empty state in that case.
   */
  outcomes: CompositeOutcomesFile | null;
  /**
   * Map from sessionId → terminal-timestamp (Unix ms). Used to anchor
   * each outcome to a calendar week. Falls back to skipping outcomes
   * whose sessionId is not in the map.
   */
  sessionUpdatedAt: ReadonlyMap<string, number>;
}

export function EffectivenessMode({
  outcomes,
  sessionUpdatedAt,
}: EffectivenessModeProps) {
  const buckets = useMemo<WeeklyBucket[]>(() => {
    if (outcomes === null) return [];
    const m = new Map<number, WeeklyBucket>();
    for (const o of outcomes.outcomes) {
      // Skip rows whose hash was rejected by the loader — they're
      // marked `binary: 'unknown'` and have no rate semantics.
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
  }, [outcomes, sessionUpdatedAt]);

  // Fill missing weeks with empty buckets so the line is continuous —
  // a gap of 0/0 is information (you didn't work that week), not noise.
  const filled = useMemo<WeeklyBucket[]>(() => {
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
  }, [buckets]);

  const meanSeries = useMemo<OutcomeWeek[]>(() => {
    if (filled.length === 0) return [];
    // Per-week mean composite score.
    const rawValues = filled.map((b) =>
      b.total === 0 ? 0 : b.scores.reduce((s, x) => s + x, 0) / b.total,
    );
    const smoothed = ewma(rawValues, THRESHOLDS.ewma.halfLifeWeeks);
    // No Wilson CI for a mean of continuous scores — the ribbon below
    // is for the binarized-good share. Carry a flat ribbon == raw value
    // so the chart primitive renders without a visible band.
    return filled.map((b, i) => ({
      start: b.start,
      value: rawValues[i]!,
      ewma: smoothed[i]!,
      ciLow: rawValues[i]!,
      ciHigh: rawValues[i]!,
      n: b.total,
    }));
  }, [filled]);

  const goodSeries = useMemo<OutcomeWeek[]>(() => {
    if (filled.length === 0) return [];
    const rawValues = filled.map((b) =>
      b.total === 0 ? 0 : b.good / b.total,
    );
    const smoothed = ewma(rawValues, THRESHOLDS.ewma.halfLifeWeeks);
    return filled.map((b, i) => {
      const ci =
        b.total >= THRESHOLDS.display.minNForRate
          ? wilsonCI(rawValues[i]!, b.total)
          : { low: rawValues[i]!, high: rawValues[i]! };
      return {
        start: b.start,
        value: rawValues[i]!,
        ewma: smoothed[i]!,
        ciLow: ci.low,
        ciHigh: ci.high,
        n: b.total,
      };
    });
  }, [filled]);

  const informativeWeeks = useMemo(
    () =>
      filled.filter((b) => b.total >= THRESHOLDS.display.minNForRate).length,
    [filled],
  );

  if (outcomes === null) {
    return (
      <EmptyState
        title="NO EFFECTIVENESS DATA"
        message="EFFECTIVENESS reads analysis/composite-outcomes.json. Run pnpm exporter run start to generate it, then refresh."
      />
    );
  }

  if (informativeWeeks < THRESHOLDS.display.minNForRate) {
    return (
      <div className="lcars-effectiveness">
        <header className="lcars-effectiveness__header">
          <h2 className="lcars-effectiveness__title">EFFECTIVENESS</h2>
          <p className="lcars-effectiveness__lead">
            Trajectory of your weekly composite-outcome score and
            binarized-good share over the corpus.
          </p>
        </header>
        <p className="lcars-effectiveness__empty">
          Not enough weekly data to plot a trajectory yet — need at
          least {THRESHOLDS.display.minNForRate} weeks with{' '}
          {THRESHOLDS.display.minNForRate} or more sessions each.
          Currently {informativeWeeks}. Keep working and revisit.
        </p>
        <MethodologyDisclosure />
      </div>
    );
  }

  const latestMean = meanSeries[meanSeries.length - 1];
  const latestGood = goodSeries[goodSeries.length - 1];

  return (
    <div className="lcars-effectiveness">
      <header className="lcars-effectiveness__header">
        <h2 className="lcars-effectiveness__title">EFFECTIVENESS</h2>
        <p className="lcars-effectiveness__lead">
          Trajectory of your weekly composite-outcome score and
          binarized-good share over the corpus. EWMA smoother uses a{' '}
          {THRESHOLDS.ewma.halfLifeWeeks}-week half-life. Hover a week
          for sample-size detail.
        </p>
      </header>
      <section
        className="lcars-effectiveness__panel"
        aria-label="weekly mean composite score"
      >
        <header className="lcars-effectiveness__panel-header">
          <h3 className="lcars-effectiveness__panel-title">
            WEEKLY MEAN COMPOSITE
          </h3>
          {latestMean !== undefined && (
            <span className="lcars-effectiveness__readout">
              latest {Math.round(latestMean.value * 100)}% · smoother{' '}
              {Math.round(latestMean.ewma * 100)}%
            </span>
          )}
        </header>
        <OutcomeSparkline
          series={meanSeries}
          label="MEAN COMPOSITE"
          valueLabel="MEAN"
          showRibbon={false}
        />
      </section>
      <section
        className="lcars-effectiveness__panel"
        aria-label="weekly binarized-good share"
      >
        <header className="lcars-effectiveness__panel-header">
          <h3 className="lcars-effectiveness__panel-title">
            WEEKLY GOOD SHARE
          </h3>
          {latestGood !== undefined && (
            <span className="lcars-effectiveness__readout">
              latest {Math.round(latestGood.value * 100)}% · smoother{' '}
              {Math.round(latestGood.ewma * 100)}% · Wilson 95% CI
              ribbon
            </span>
          )}
        </header>
        <OutcomeSparkline
          series={goodSeries}
          label="GOOD SHARE"
          valueLabel="GOOD %"
          showRibbon={true}
        />
      </section>
      <MethodologyDisclosure />
    </div>
  );
}
