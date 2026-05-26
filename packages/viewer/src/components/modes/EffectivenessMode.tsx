import { useMemo } from 'react';
import type { CompositeOutcomesFile } from '@chat-arch/schema';
import { THRESHOLDS, ewma, wilsonCI } from '@chat-arch/analysis';
import { SidecarEmptyState } from '../SidecarEmptyState.js';
import { MethodologyDisclosure } from '../MethodologyDisclosure.js';
import { CopyMarkdownButton } from '../CopyMarkdownButton.js';
import { OutcomeSparkline, type OutcomeWeek } from '../OutcomeSparkline.js';
import type { ConfigHistoryFile } from '../../data/insightsLoader.js';

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
  /**
   * Wave 7 P1 #4 — wire empty-state CTA to the data panel.
   */
  onOpenDataPanel?: () => void;
  /**
   * Wave 7 P2 #10 — commits to render as x-axis tick marks on the
   * sparklines. Read from `analysis/config-history.json`. Optional;
   * when absent the sparkline renders without tick marks.
   */
  configHistory?: ConfigHistoryFile | null;
}

export function EffectivenessMode({
  outcomes,
  sessionUpdatedAt,
  onOpenDataPanel,
  configHistory = null,
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

  // Lift the commit-ticks memo to the top of the render — react-hooks
  // rules forbid calling a hook after an early return. Filters to
  // commits inside the displayed week range; caps at 12 entries.
  const commitTicks = useMemo<readonly CommitTick[]>(() => {
    if (configHistory === null) return [];
    if (goodSeries.length === 0) return [];
    const first = goodSeries[0]!.start;
    const last = goodSeries[goodSeries.length - 1]!.start + WEEK_MS;
    const ticks: CommitTick[] = [];
    for (const c of configHistory.commits) {
      if (c.ts < first || c.ts >= last) continue;
      ticks.push({
        sha: c.sha,
        shaShort: c.sha.slice(0, 7),
        subject: c.subject,
        ts: c.ts,
      });
      if (ticks.length >= 12) break;
    }
    return ticks;
  }, [configHistory, goodSeries]);

  if (outcomes === null) {
    return (
      <SidecarEmptyState
        title="NO EFFECTIVENESS DATA"
        detail="EFFECTIVENESS reads analysis/composite-outcomes.json. Open DATA → SCAN LOCAL to populate it, then refresh."
        {...(onOpenDataPanel ? { onOpenDataPanel } : {})}
        testId="effectiveness-empty"
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

  // Wave 7 P2 #10 — trajectory verdict line over the last
  // `verdictWindow` informative weeks. Wilson-tested: we read the
  // sign of (latest CI low - earliest CI high) and surface
  // direction-with-confidence rather than just a raw delta.
  const verdict = computeVerdict(goodSeries);

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
        aria-labelledby="effectiveness-mean-h"
      >
        <header className="lcars-effectiveness__panel-header">
          <h3 id="effectiveness-mean-h" className="lcars-effectiveness__panel-title">
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
        aria-labelledby="effectiveness-good-h"
      >
        <header className="lcars-effectiveness__panel-header">
          <h3 id="effectiveness-good-h" className="lcars-effectiveness__panel-title">
            WEEKLY GOOD SHARE
          </h3>
          {latestGood !== undefined && (
            <span className="lcars-effectiveness__readout">
              latest {Math.round(latestGood.value * 100)}% · smoother{' '}
              {Math.round(latestGood.ewma * 100)}% · Wilson 95% CI
              ribbon
            </span>
          )}
          {latestGood !== undefined && (
            <CopyMarkdownButton
              title="EFFECTIVENESS — latest good-share readout"
              bodyLines={[
                `Latest week good-share: ${Math.round(latestGood.value * 100)}%`,
                `EWMA smoother: ${Math.round(latestGood.ewma * 100)}%`,
                `Wilson 95% CI: ${Math.round(latestGood.ciLow * 100)}% – ${Math.round(latestGood.ciHigh * 100)}%`,
                `Sample size that week: n=${latestGood.n}`,
                verdict !== null
                  ? `Trajectory over last ${verdict.windowWeeks} informative weeks: ` +
                    `${verdict.deltaPp >= 0 ? '+' : ''}${verdict.deltaPp.toFixed(1)} pp (${verdict.direction})`
                  : 'Trajectory window: insufficient informative weeks',
              ]}
              testId="copy-effectiveness-latest"
            />
          )}
        </header>
        {verdict !== null && (
          // Verdict is static page content (computed at render from
          // props), not an async status. role="status" + aria-live
          // would re-announce on every parent re-render — same noise
          // pattern iter-3 Bundle E quieted on the SCAN progressbar.
          // (iter-5 finding.)
          <p
            className={
              'lcars-effectiveness__verdict lcars-effectiveness__verdict--' +
              verdict.direction
            }
            data-testid="effectiveness-verdict"
          >
            Trajectory:{' '}
            <strong>
              {verdict.deltaPp >= 0 ? '+' : ''}
              {verdict.deltaPp.toFixed(1)} pp
            </strong>{' '}
            over last {verdict.windowWeeks} weeks{' '}
            <span aria-hidden="true">
              {verdict.direction === 'up'
                ? '↑'
                : verdict.direction === 'down'
                  ? '↓'
                  : '→'}
            </span>{' '}
            ({verdict.direction === 'flat' ? 'flat' : verdict.direction},
            Wilson-tested)
          </p>
        )}
        <OutcomeSparkline
          series={goodSeries}
          label="GOOD SHARE"
          valueLabel="GOOD %"
          showRibbon={true}
        />
        {commitTicks.length > 0 && (
          <ul
            className="lcars-effectiveness__commit-ticks"
            role="list"
            aria-label="config-history commit annotations"
            data-testid="effectiveness-commit-ticks"
          >
            {commitTicks.map((c) => (
              <li
                key={c.sha}
                className="lcars-effectiveness__commit-tick"
                title={`${c.subject} (${c.shaShort}) — ${formatTickDate(c.ts)}`}
                aria-label={`commit ${c.shaShort} on ${formatTickDate(c.ts)}: ${c.subject}`}
              >
                <span aria-hidden="true">▲</span>{' '}
                <code>{c.shaShort}</code> {c.subject}
              </li>
            ))}
          </ul>
        )}
      </section>
      <MethodologyDisclosure />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Verdict + commit-tick helpers (Wave 7 P2 #10)
// ─────────────────────────────────────────────────────────────────────

interface TrajectoryVerdict {
  /** Direction relative to the start of the verdict window. */
  direction: 'up' | 'down' | 'flat';
  /** Signed delta in percentage points (raw-rate, not EWMA). */
  deltaPp: number;
  /** Width of the verdict window, in informative weeks. */
  windowWeeks: number;
}

/**
 * Wilson-tested verdict: take up to the last
 * `THRESHOLDS.trajectory.rollingWindow` informative weeks of the good
 * share. Direction is `up` when the latest week's Wilson CI low
 * exceeds the earliest week's CI high (and the raw delta is positive),
 * `down` for the mirror case, and `flat` otherwise. Returns `null`
 * when too few informative weeks are available.
 */
function computeVerdict(series: readonly OutcomeWeek[]): TrajectoryVerdict | null {
  if (series.length < 2) return null;
  const informative = series.filter((w) => w.n >= THRESHOLDS.display.minNForRate);
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

interface CommitTick {
  sha: string;
  shaShort: string;
  subject: string;
  ts: number;
}

function formatTickDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
