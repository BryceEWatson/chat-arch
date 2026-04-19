import { readJsonlLines } from './jsonl.js';
import { logger } from './logger.js';

/**
 * Flat roll-up of a Cowork `audit.jsonl` stream. Produced by streaming the
 * file line-by-line (constant memory). See plan D2/D3 for semantics.
 */
export interface AuditAggregate {
  /** Number of `type === 'user'` lines. */
  userTurns: number;
  /** Number of `type === 'assistant'` lines. */
  assistantTurns: number;
  /** Number of `type === 'result'` lines observed. */
  resultLineCount: number;
  /** Number of lines that failed to parse as JSON. */
  malformedLineCount: number;
  /** Sum of `duration_ms` across all `result` lines (Phase 4 economics). */
  durationMs: number | undefined;
  /** Sum of `duration_api_ms` across all `result` lines (Phase 4 economics). */
  durationApiMs: number | undefined;
  /** Sum of `num_turns` across all `result` lines (debug only). */
  numTurns: number | undefined;
  /** Sum of `total_cost_usd` across all `result` lines. */
  totalCostUsd: number | undefined;
  /** Shallow-merged `modelUsage` dict from all `result` lines. */
  modelUsage: Record<string, unknown> | undefined;
  /**
   * Model string picked from the *last* result line's last `modelUsage` key.
   * Useful as "primary model" display fallback for Cowork sessions.
   */
  lastResultModel: string | undefined;
}

function zeroAggregate(): AuditAggregate {
  return {
    userTurns: 0,
    assistantTurns: 0,
    resultLineCount: 0,
    malformedLineCount: 0,
    durationMs: undefined,
    durationApiMs: undefined,
    numTurns: undefined,
    totalCostUsd: undefined,
    modelUsage: undefined,
    lastResultModel: undefined,
  };
}

/**
 * Walk a Cowork audit.jsonl and produce an AuditAggregate.
 *
 * Invariants:
 * - Never throws. Malformed lines are counted and logged at `warnOnce(key=file)`.
 * - `modelUsage` is a shallow merge; later `result` lines overwrite earlier
 *   keys. `lastResultModel` reflects the final `result` line's last
 *   modelUsage key (D2).
 * - When there are zero `result` lines, the five numeric aggregates and
 *   `modelUsage` / `lastResultModel` remain `undefined` (the caller decides
 *   the fallback — see plan D3).
 */
export async function aggregateAudit(filePath: string): Promise<AuditAggregate> {
  const agg = zeroAggregate();

  // Track sums lazily — only switch from undefined once we see a result line.
  let sawResult = false;
  let sumDuration = 0;
  let sumDurationApi = 0;
  let sumNumTurns = 0;
  let sumCost = 0;
  const mergedModelUsage: Record<string, unknown> = {};

  for await (const y of readJsonlLines<Record<string, unknown>>(filePath)) {
    if (y.kind === 'error') {
      agg.malformedLineCount += 1;
      logger.warnOnce(
        `audit-malformed:${filePath}`,
        `audit.jsonl ${filePath} has malformed line(s); skipping. First error line ${y.lineNumber}: ${y.error.message}`,
      );
      continue;
    }

    const line = y.line;
    const type = line['type'];
    if (type === 'user') {
      agg.userTurns += 1;
    } else if (type === 'assistant') {
      agg.assistantTurns += 1;
    } else if (type === 'result') {
      sawResult = true;
      agg.resultLineCount += 1;

      const d = line['duration_ms'];
      if (typeof d === 'number' && Number.isFinite(d)) sumDuration += d;
      const dApi = line['duration_api_ms'];
      if (typeof dApi === 'number' && Number.isFinite(dApi)) sumDurationApi += dApi;
      const nt = line['num_turns'];
      if (typeof nt === 'number' && Number.isFinite(nt)) sumNumTurns += nt;
      const cost = line['total_cost_usd'];
      if (typeof cost === 'number' && Number.isFinite(cost)) sumCost += cost;

      const mu = line['modelUsage'];
      if (mu && typeof mu === 'object' && !Array.isArray(mu)) {
        for (const [k, v] of Object.entries(mu as Record<string, unknown>)) {
          mergedModelUsage[k] = v;
        }
        const keys = Object.keys(mu as Record<string, unknown>);
        if (keys.length > 0) {
          // "last result's last modelUsage key" — per D2.
          agg.lastResultModel = keys[keys.length - 1];
        }
      }
    }
  }

  if (sawResult) {
    agg.durationMs = sumDuration;
    agg.durationApiMs = sumDurationApi;
    agg.numTurns = sumNumTurns;
    agg.totalCostUsd = sumCost;
    agg.modelUsage = mergedModelUsage;
  }

  return agg;
}
