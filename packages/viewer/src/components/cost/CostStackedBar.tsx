import { useMemo } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { SourceAttribution } from '../SourceAttribution.js';

/**
 * Section (a) of COST mode (Decision 19 / `[R-D19]`).
 *
 * Per-month stacked bar: exact cost on the bottom, estimated cost on top.
 * Bars are absolute-USD scaled so a $500-spike month dwarfs a $5 month,
 * matching the user's natural "where did I spend most" question.
 *
 * Pure CSS — no charting library. Inline `style={{height: …}}` on each
 * stack so the browser picks layout up for free. Heights are computed
 * against the global max across all months so comparison is honest.
 *
 * Source attribution: the heading shows a `· estimate` suffix when ANY
 * visible month includes estimated cost (i.e. always, in Phase 6 for
 * the ~85% of sessions without an authoritative totalCostUsd).
 */

export interface CostStackedBarProps {
  /**
   * The current filtered+sorted session slice. Passing this (not raw
   * manifest) keeps the bar in sync with source/project/search filters.
   */
  sessions: readonly UnifiedSessionEntry[];
  /** Whether to apply the 2s highlight-ring (KPI-entry navigation). */
  highlight?: boolean;
}

interface MonthBucket {
  key: string; // YYYY-MM
  label: string;
  exactUsd: number;
  estimateUsd: number;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  // Short "APR '26" form reads well in LCARS. Not locale-specific — the
  // viewer is English-only per styles.css.
  const MONTHS = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  const monthIdx = Number(m) - 1;
  return `${MONTHS[monthIdx] ?? '???'} '${y!.slice(2)}`;
}

function bucketByMonth(sessions: readonly UnifiedSessionEntry[]): MonthBucket[] {
  const map = new Map<string, MonthBucket>();
  for (const s of sessions) {
    const key = monthKey(s.updatedAt);
    const bucket = map.get(key) ?? {
      key,
      label: monthLabel(key),
      exactUsd: 0,
      estimateUsd: 0,
    };
    // Exact iff totalCostUsd is non-null AND costIsEstimate is false.
    // (costIsEstimate undefined on v1 manifests — treat as estimate if
    // totalCostUsd is null, else exact.)
    if (s.totalCostUsd !== null) {
      bucket.exactUsd += s.totalCostUsd;
    } else if (typeof s.costEstimatedUsd === 'number') {
      bucket.estimateUsd += s.costEstimatedUsd;
    }
    map.set(key, bucket);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function CostStackedBar({ sessions, highlight = false }: CostStackedBarProps) {
  const buckets = useMemo(() => bucketByMonth(sessions), [sessions]);
  const totalExact = buckets.reduce((a, b) => a + b.exactUsd, 0);
  const totalEstimate = buckets.reduce((a, b) => a + b.estimateUsd, 0);
  const maxMonth = buckets.reduce((a, b) => Math.max(a, b.exactUsd + b.estimateUsd), 0);

  const hasEstimate = totalEstimate > 0;

  return (
    <section
      className={`lcars-cost-section${highlight ? ' lcars-cost-section--highlight' : ''}`}
      data-section="stacked-bar"
      aria-label="cost per month"
    >
      <header className="lcars-cost-section__header">
        <h3 className="lcars-cost-section__title">
          COST PER MONTH
          {hasEstimate && <SourceAttribution kind="estimate" />}
        </h3>
        <div className="lcars-cost-section__summary">
          EXACT <strong>${totalExact.toFixed(2)}</strong>
          {' · '}
          ESTIMATE <strong>${totalEstimate.toFixed(2)}</strong>
        </div>
      </header>
      {buckets.length === 0 ? (
        <div className="lcars-cost-section__empty">No cost data for current filters.</div>
      ) : (
        <>
          <ol className="lcars-cost-stacked-bar">
            {buckets.map((b) => {
              const total = b.exactUsd + b.estimateUsd;
              const pct = maxMonth > 0 ? (total / maxMonth) * 100 : 0;
              const exactPct = total > 0 ? (b.exactUsd / total) * 100 : 0;
              return (
                <li key={b.key} className="lcars-cost-stacked-bar__item">
                  <div
                    className="lcars-cost-stacked-bar__track"
                    role="img"
                    aria-label={`${b.label}: exact $${b.exactUsd.toFixed(2)}, estimate $${b.estimateUsd.toFixed(2)}`}
                  >
                    <div className="lcars-cost-stacked-bar__stack" style={{ height: `${pct}%` }}>
                      {/* Exact slice on the bottom, estimate on top. */}
                      <div
                        className="lcars-cost-stacked-bar__slice lcars-cost-stacked-bar__slice--estimate"
                        style={{ height: `${100 - exactPct}%` }}
                      />
                      <div
                        className="lcars-cost-stacked-bar__slice lcars-cost-stacked-bar__slice--exact"
                        style={{ height: `${exactPct}%` }}
                      />
                    </div>
                  </div>
                  <div className="lcars-cost-stacked-bar__label">{b.label}</div>
                  <div className="lcars-cost-stacked-bar__value">${total.toFixed(2)}</div>
                </li>
              );
            })}
          </ol>
          <div className="lcars-cost-legend">
            <span>
              <span className="lcars-cost-legend__sw lcars-cost-legend__sw--exact" />
              exact (CLI logs)
            </span>
            <span>
              <span className="lcars-cost-legend__sw lcars-cost-legend__sw--estimate" />
              estimate (cloud)
            </span>
          </div>
        </>
      )}
    </section>
  );
}
