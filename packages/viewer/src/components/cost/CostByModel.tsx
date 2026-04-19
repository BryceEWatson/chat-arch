import { useMemo } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { SourceAttribution } from '../SourceAttribution.js';

/**
 * Section (b) of COST mode (Decision 19) — cost broken down by model.
 *
 * Uses the manifest fields `model`, `costEstimatedUsd`, `totalCostUsd`,
 * and `tokenTotals` (output token axis). No re-derivation of rates from
 * the rate table here — the exporter did that work.
 *
 * For display purposes we group by the session's primary `model` (last
 * assistant-turn model, per schema JSDoc). Multi-model sessions count
 * once under their primary; the secondary-model cost is captured in the
 * rollup because `costEstimatedUsd` already integrates across all turns.
 */

export interface CostByModelProps {
  sessions: readonly UnifiedSessionEntry[];
  highlight?: boolean;
}

interface ModelRow {
  modelId: string;
  sessionCount: number;
  exactUsd: number;
  estimateUsd: number;
  outputTokens: number;
}

function bucketByModel(sessions: readonly UnifiedSessionEntry[]): ModelRow[] {
  const map = new Map<string, ModelRow>();
  for (const s of sessions) {
    const modelId = s.model ?? '(unknown)';
    const row = map.get(modelId) ?? {
      modelId,
      sessionCount: 0,
      exactUsd: 0,
      estimateUsd: 0,
      outputTokens: 0,
    };
    row.sessionCount += 1;
    if (s.totalCostUsd !== null) row.exactUsd += s.totalCostUsd;
    else if (typeof s.costEstimatedUsd === 'number') row.estimateUsd += s.costEstimatedUsd;
    if (s.tokenTotals) row.outputTokens += s.tokenTotals.output;
    map.set(modelId, row);
  }
  return [...map.values()].sort(
    (a, b) => b.exactUsd + b.estimateUsd - (a.exactUsd + a.estimateUsd),
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function CostByModel({ sessions, highlight = false }: CostByModelProps) {
  const rows = useMemo(() => bucketByModel(sessions), [sessions]);
  const totalUsd = rows.reduce((a, r) => a + r.exactUsd + r.estimateUsd, 0);
  const hasEstimate = rows.some((r) => r.estimateUsd > 0);

  return (
    <section
      className={`lcars-cost-section${highlight ? ' lcars-cost-section--highlight' : ''}`}
      data-section="by-model"
      aria-label="cost by model"
    >
      <header className="lcars-cost-section__header">
        <h3 className="lcars-cost-section__title">
          BY MODEL
          {hasEstimate && <SourceAttribution kind="estimate" />}
        </h3>
      </header>
      {rows.length === 0 ? (
        <div className="lcars-cost-section__empty">No model data.</div>
      ) : (
        <table className="lcars-cost-table" role="table">
          <thead>
            <tr>
              <th scope="col">MODEL</th>
              <th scope="col">SHARE</th>
              <th scope="col" className="num">
                SESSIONS
              </th>
              <th scope="col" className="num">
                OUTPUT TOK
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
            {rows.map((r) => {
              const subtotal = r.exactUsd + r.estimateUsd;
              const pct = totalUsd > 0 ? (subtotal / totalUsd) * 100 : 0;
              return (
                <tr key={r.modelId}>
                  <td className="lcars-cost-table__model">{r.modelId}</td>
                  <td>
                    <div
                      className="lcars-cost-table__bar"
                      role="img"
                      aria-label={`share ${pct.toFixed(1)}%`}
                    >
                      <div
                        className="lcars-cost-table__bar-fill"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                      <span className="lcars-cost-table__bar-label">{pct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className="num">{r.sessionCount}</td>
                  <td className="num">{formatTokens(r.outputTokens)}</td>
                  <td className="num">${r.exactUsd.toFixed(2)}</td>
                  <td className="num">${r.estimateUsd.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
