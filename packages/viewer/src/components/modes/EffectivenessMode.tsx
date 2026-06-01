import { useMemo } from 'react';
import type { CompositeOutcomesFile } from '@chat-arch/schema';
import { THRESHOLDS, buildWeeklyComposite } from '@chat-arch/analysis';
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

/** Week stride in ms — used to bound the commit-tick annotation range. */
const WEEK_MS = 7 * 86_400_000;

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
  // All weekly-trajectory derivation lives in the `buildWeeklyComposite`
  // analysis selector (Phase 3 of the "Centralize data processing"
  // refactor) — bucketing, gap-fill, EWMA, Wilson CI, and the verdict.
  // The component is a thin renderer over its output. The selector's
  // point shape is structurally `OutcomeWeek`, so the series feed the
  // sparkline directly.
  const composite = useMemo(
    () => buildWeeklyComposite(outcomes, sessionUpdatedAt),
    [outcomes, sessionUpdatedAt],
  );
  const meanSeries: readonly OutcomeWeek[] = composite.mean;
  const goodSeries: readonly OutcomeWeek[] = composite.good;
  const informativeWeeks = composite.informativeWeeks;

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
  // `verdictWindow` informative weeks. Wilson-tested (computed by the
  // `buildWeeklyComposite` selector): the sign of (latest CI low -
  // earliest CI high) drives direction-with-confidence, not a raw delta.
  const verdict = composite.verdict;

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
// Commit-tick helpers (Wave 7 P2 #10)
//
// The weekly trajectory + Wilson-tested verdict now live in the
// `buildWeeklyComposite` analysis selector. Only the commit-tick
// annotation (which threads `ConfigHistoryFile` — a viewer sidecar —
// against the rendered week range) stays here as UI-coupled glue.
// ─────────────────────────────────────────────────────────────────────

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
