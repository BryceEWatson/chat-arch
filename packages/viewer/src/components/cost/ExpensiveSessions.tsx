import { useMemo } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { SourceAttribution } from '../SourceAttribution.js';
import { onActivate } from '../../util/a11y.js';
import { SOURCE_LABEL } from '../../types.js';

/**
 * Section (d) of COST mode — top-20 most expensive sessions as a table
 * (Q9 AFFIRM: "Table for top-20 expensive sessions").
 *
 * Row effective cost = totalCostUsd when non-null, else costEstimatedUsd.
 * A `· exact` / `· estimate` attribution label sits next to the dollar
 * amount so the user can tell at a glance which is which.
 *
 * KPI-entry from TOP TOOL applies an optional `toolFilter` — rows shown
 * are top-20 sessions whose `topTools` includes that tool. Direct-nav
 * passes no toolFilter and shows the unfiltered top-20.
 */

export interface ExpensiveSessionsProps {
  sessions: readonly UnifiedSessionEntry[];
  /** When set, restrict rows to sessions whose topTools includes this name. */
  toolFilter?: string;
  /** Click handler — drills into the DetailMode for that session. */
  onSelect: (id: string) => void;
  highlight?: boolean;
}

interface Row {
  session: UnifiedSessionEntry;
  effectiveUsd: number;
  isEstimate: boolean;
}

function effectiveCost(s: UnifiedSessionEntry): Row | null {
  if (s.totalCostUsd !== null) {
    return { session: s, effectiveUsd: s.totalCostUsd, isEstimate: false };
  }
  if (typeof s.costEstimatedUsd === 'number') {
    return { session: s, effectiveUsd: s.costEstimatedUsd, isEstimate: true };
  }
  return null;
}

function topToolsSummary(topTools: Readonly<Record<string, number>> | undefined): string {
  if (!topTools) return '—';
  const entries = Object.entries(topTools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}×${v}`);
  if (entries.length === 0) return '—';
  return entries.join(' ');
}

export function ExpensiveSessions({
  sessions,
  toolFilter,
  onSelect,
  highlight = false,
}: ExpensiveSessionsProps) {
  const rows = useMemo(() => {
    const filtered = toolFilter
      ? sessions.filter((s) => !!s.topTools && toolFilter in s.topTools)
      : sessions;
    const costed = filtered.map(effectiveCost).filter((r): r is Row => r !== null);
    costed.sort((a, b) => b.effectiveUsd - a.effectiveUsd);
    return costed.slice(0, 20);
  }, [sessions, toolFilter]);

  return (
    <section
      className={`lcars-cost-section${highlight ? ' lcars-cost-section--highlight' : ''}`}
      data-section="top-20"
      aria-label="top 20 expensive sessions"
    >
      <header className="lcars-cost-section__header">
        <h3 className="lcars-cost-section__title">
          TOP 20 EXPENSIVE SESSIONS
          {toolFilter && (
            <span className="lcars-cost-section__filter-hint"> · FILTERED TO {toolFilter}</span>
          )}
        </h3>
      </header>
      {rows.length === 0 ? (
        <div className="lcars-cost-section__empty">
          {toolFilter
            ? `No sessions use ${toolFilter} in the current filter.`
            : 'No sessions with computable cost.'}
        </div>
      ) : (
        <table className="lcars-cost-table lcars-cost-table--dense">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">COST</th>
              <th scope="col">SOURCE</th>
              <th scope="col">TITLE</th>
              <th scope="col">MODEL</th>
              <th scope="col">TOOLS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.session.source}:${r.session.id}`}
                role="button"
                tabIndex={0}
                className="lcars-cost-table__row--clickable"
                aria-label={`open ${r.session.title || 'Untitled session'}`}
                onClick={() => onSelect(r.session.id)}
                onKeyDown={(e) => onActivate(e, () => onSelect(r.session.id))}
              >
                <td className="lcars-cost-table__rank">{i + 1}</td>
                <td>
                  ${r.effectiveUsd.toFixed(2)}
                  <SourceAttribution kind={r.isEstimate ? 'estimate' : 'exact'} />
                </td>
                <td>{SOURCE_LABEL[r.session.source]}</td>
                <td className="lcars-cost-table__title" title={r.session.title}>
                  {r.session.title || 'Untitled session'}
                </td>
                <td>{r.session.model ?? '—'}</td>
                <td>{topToolsSummary(r.session.topTools)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
