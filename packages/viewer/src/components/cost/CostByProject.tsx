import { useMemo } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { SourceAttribution } from '../SourceAttribution.js';

/**
 * Section (c) of COST mode (Decision 19) — cost by project, top 8 + "rest".
 *
 * Uses `session.project` (the field the exporter populated via Team A's
 * `inferProject.ts` resolver — D6 title-keyword allowlist). Sessions with
 * no resolved project roll into an `(untagged)` bucket so the totals
 * match COST · stacked-bar exactly (no silent drop).
 */

export interface CostByProjectProps {
  sessions: readonly UnifiedSessionEntry[];
  highlight?: boolean;
}

interface ProjectRow {
  id: string;
  displayName: string;
  sessionCount: number;
  exactUsd: number;
  estimateUsd: number;
}

const UNKNOWN_KEY = '__untagged__';

function bucketByProject(sessions: readonly UnifiedSessionEntry[]): ProjectRow[] {
  const map = new Map<string, ProjectRow>();
  for (const s of sessions) {
    const key = s.project ?? UNKNOWN_KEY;
    const row = map.get(key) ?? {
      id: key,
      displayName: key === UNKNOWN_KEY ? '(untagged)' : key,
      sessionCount: 0,
      exactUsd: 0,
      estimateUsd: 0,
    };
    row.sessionCount += 1;
    if (s.totalCostUsd !== null) row.exactUsd += s.totalCostUsd;
    else if (typeof s.costEstimatedUsd === 'number') row.estimateUsd += s.costEstimatedUsd;
    map.set(key, row);
  }
  return [...map.values()].sort(
    (a, b) => b.exactUsd + b.estimateUsd - (a.exactUsd + a.estimateUsd),
  );
}

export function CostByProject({ sessions, highlight = false }: CostByProjectProps) {
  const rows = useMemo(() => bucketByProject(sessions), [sessions]);
  const top = rows.slice(0, 8);
  const rest = rows.slice(8);
  const restTotal = rest.reduce(
    (a, r) => ({
      sessionCount: a.sessionCount + r.sessionCount,
      exactUsd: a.exactUsd + r.exactUsd,
      estimateUsd: a.estimateUsd + r.estimateUsd,
    }),
    { sessionCount: 0, exactUsd: 0, estimateUsd: 0 },
  );
  const totalUsd = rows.reduce((a, r) => a + r.exactUsd + r.estimateUsd, 0);
  const hasEstimate = rows.some((r) => r.estimateUsd > 0);

  return (
    <section
      className={`lcars-cost-section${highlight ? ' lcars-cost-section--highlight' : ''}`}
      data-section="by-project"
      aria-label="cost by project"
    >
      <header className="lcars-cost-section__header">
        <h3 className="lcars-cost-section__title">
          BY PROJECT
          {hasEstimate && <SourceAttribution kind="estimate" />}
        </h3>
      </header>
      {rows.length === 0 ? (
        <div className="lcars-cost-section__empty">No project data.</div>
      ) : (
        <table className="lcars-cost-table" role="table">
          <thead>
            <tr>
              <th scope="col">PROJECT</th>
              <th scope="col">SHARE</th>
              <th scope="col" className="num">
                SESSIONS
              </th>
              <th scope="col" className="num">
                EXACT
              </th>
              <th scope="col" className="num">
                ESTIMATE
              </th>
            </tr>
          </thead>
          <tbody>
            {top.map((r) => {
              const subtotal = r.exactUsd + r.estimateUsd;
              const pct = totalUsd > 0 ? (subtotal / totalUsd) * 100 : 0;
              return (
                <tr key={r.id}>
                  <td className="lcars-cost-table__project">{r.displayName}</td>
                  <td>
                    <div
                      className="lcars-cost-table__bar"
                      role="img"
                      aria-label={`share ${pct.toFixed(1)}%`}
                    >
                      <div
                        className="lcars-cost-table__bar-fill lcars-cost-table__bar-fill--ice"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                      <span className="lcars-cost-table__bar-label">{pct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className="num">{r.sessionCount}</td>
                  <td className="num">${r.exactUsd.toFixed(2)}</td>
                  <td className="num">${r.estimateUsd.toFixed(2)}</td>
                </tr>
              );
            })}
            {rest.length > 0 &&
              (() => {
                const restPct =
                  totalUsd > 0
                    ? ((restTotal.exactUsd + restTotal.estimateUsd) / totalUsd) * 100
                    : 0;
                return (
                  <tr className="lcars-cost-table__rest">
                    <td className="lcars-cost-table__project">+{rest.length} OTHER</td>
                    <td>
                      <div
                        className="lcars-cost-table__bar"
                        role="img"
                        aria-label={`share ${restPct.toFixed(1)}%`}
                      >
                        <div
                          className="lcars-cost-table__bar-fill lcars-cost-table__bar-fill--ice"
                          style={{ width: `${Math.min(100, restPct)}%`, opacity: 0.6 }}
                        />
                        <span className="lcars-cost-table__bar-label">{restPct.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="num">{restTotal.sessionCount}</td>
                    <td className="num">${restTotal.exactUsd.toFixed(2)}</td>
                    <td className="num">${restTotal.estimateUsd.toFixed(2)}</td>
                  </tr>
                );
              })()}
          </tbody>
        </table>
      )}
    </section>
  );
}
