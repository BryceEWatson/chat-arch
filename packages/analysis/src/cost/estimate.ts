/**
 * Cost estimator — pure function, pure math, no LLM.
 *
 * Phase 6 Decision 2+3+4+Q2: the exporter computes `costEstimatedUsd` and
 * `costIsEstimate` for every session. Rules:
 *
 *   - `totalCostUsd != null` → `costEstimatedUsd = totalCostUsd`,
 *     `costIsEstimate = false`. Exact always wins.
 *   - `totalCostUsd == null` AND `tokenTotals != null`:
 *       - pick a model: single entry in `modelsUsed` wins; when
 *         `modelsUsed.length > 1`, cost-weighted selection — model
 *         maximizing `outputPerM * output_tokens` (tie-break on most-recent
 *         per `session.model`). When `modelsUsed` is missing but `model`
 *         is present, use `model`. When neither is present, fall back to
 *         DEFAULT_MODEL_ID (Q2: `claude-opus-4-6`) and mark
 *         `costBreakdown.note = 'assumed_model'`.
 *       - If picked modelId has no rate-table entry:
 *           `costEstimatedUsd = null`, `costIsEstimate = false`.
 *           Caller is responsible for warn-logging (see `collectUnknownModels`).
 *       - Else compute
 *           input * inputPerM
 *         + output * outputPerM
 *         + cacheCreation * cacheWritePerM
 *         + cacheRead * cacheReadPerM
 *         (all per-million) → USD. `costIsEstimate = true`.
 *   - Otherwise (no tokenTotals, no exact cost):
 *       `costEstimatedUsd = null`, `costIsEstimate = false`.
 */

import type { UnifiedSessionEntry } from '@chat-arch/schema';
import ratesJson from './rates.json' with { type: 'json' };

export interface ModelRate {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM: number;
  cacheReadPerM: number;
}

export interface RateTable {
  _meta: {
    lastUpdated: string;
    notes: string;
    defaultModel: string;
  };
  rates: Record<string, ModelRate>;
}

export const RATE_TABLE: RateTable = ratesJson as RateTable;
export const DEFAULT_MODEL_ID: string = RATE_TABLE._meta.defaultModel;

export interface CostBreakdown {
  modelIdUsed: string;
  inputUsd: number;
  outputUsd: number;
  cacheWriteUsd: number;
  cacheReadUsd: number;
  /** Optional free-text note: 'cost-weighted model selection', 'assumed_model'. */
  note?: string;
}

export interface EstimateResult {
  costEstimatedUsd: number | null;
  costIsEstimate: boolean;
  breakdown?: CostBreakdown;
  /** When set, the caller should warn-log this modelId. */
  unknownModelId?: string;
}

/**
 * Pick the model to apply rates from.
 *
 * Rules per `[R-D4]` and `[R-Q2]`:
 *   - `modelsUsed.length === 1`: use that one.
 *   - `modelsUsed.length > 1`: cost-weighted — model maximizing
 *     `outputPerM * output_tokens`. Tie-break on most-recent `session.model`.
 *     Note: we don't have per-turn output-token breakdowns in the manifest,
 *     so the weighting proxy uses TOTAL output-tokens × `outputPerM`, which
 *     is equivalent to "pick the most expensive model in use" for the
 *     multi-model case (a Haiku-heavy session with one Opus turn should still
 *     price on Opus — matches the plan's stated rationale).
 *   - `modelsUsed` missing, `model` present: use `model`.
 *   - Both missing: use DEFAULT_MODEL_ID with `note = 'assumed_model'`.
 */
export function pickModelForRate(entry: Pick<UnifiedSessionEntry, 'model' | 'modelsUsed'>): {
  modelId: string;
  note?: string;
} {
  const modelsUsed = entry.modelsUsed ?? [];
  if (modelsUsed.length === 1) {
    return { modelId: modelsUsed[0]! };
  }
  if (modelsUsed.length > 1) {
    // Cost-weighted selection. Since we don't have per-turn token splits,
    // the weighting reduces to "maximize outputPerM among known models",
    // with unknown-model entries ignored. Tie-break on most-recent
    // (`session.model`). If session.model is among modelsUsed AND ties on
    // outputPerM, it wins the tie.
    let best: { modelId: string; outputPerM: number } | null = null;
    for (const m of modelsUsed) {
      const rate = RATE_TABLE.rates[m];
      if (rate === undefined) continue;
      if (best === null || rate.outputPerM > best.outputPerM) {
        best = { modelId: m, outputPerM: rate.outputPerM };
      } else if (rate.outputPerM === best.outputPerM && entry.model === m) {
        best = { modelId: m, outputPerM: rate.outputPerM };
      }
    }
    if (best !== null) {
      return { modelId: best.modelId, note: 'cost-weighted model selection' };
    }
    // No models in `modelsUsed` are in the rate table. Fall through — but
    // still report one so `unknownModelId` can be set by the caller.
    return { modelId: modelsUsed[0]! };
  }
  if (entry.model !== null && entry.model !== undefined) {
    return { modelId: entry.model };
  }
  return { modelId: DEFAULT_MODEL_ID, note: 'assumed_model' };
}

/**
 * Core estimator. Pure — no I/O, no side effects, no warn-log (caller handles).
 */
export function estimateCost(
  entry: Pick<UnifiedSessionEntry, 'totalCostUsd' | 'tokenTotals' | 'model' | 'modelsUsed'>,
): EstimateResult {
  // Exact cost always wins.
  if (entry.totalCostUsd !== null && entry.totalCostUsd !== undefined) {
    return {
      costEstimatedUsd: entry.totalCostUsd,
      costIsEstimate: false,
    };
  }

  if (entry.tokenTotals === undefined) {
    return { costEstimatedUsd: null, costIsEstimate: false };
  }

  const { modelId, note } = pickModelForRate(entry);
  const rate = RATE_TABLE.rates[modelId];
  if (rate === undefined) {
    return {
      costEstimatedUsd: null,
      costIsEstimate: false,
      unknownModelId: modelId,
    };
  }

  const { input, output, cacheCreation, cacheRead } = entry.tokenTotals;
  const inputUsd = (input * rate.inputPerM) / 1_000_000;
  const outputUsd = (output * rate.outputPerM) / 1_000_000;
  const cacheWriteUsd = (cacheCreation * rate.cacheWritePerM) / 1_000_000;
  const cacheReadUsd = (cacheRead * rate.cacheReadPerM) / 1_000_000;
  const total = inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd;

  const breakdown: CostBreakdown = {
    modelIdUsed: modelId,
    inputUsd,
    outputUsd,
    cacheWriteUsd,
    cacheReadUsd,
    ...(note !== undefined ? { note } : {}),
  };

  return {
    costEstimatedUsd: total,
    costIsEstimate: true,
    breakdown,
  };
}

/**
 * Post-estimate aggregator: scan a manifest and return a modelId → count map
 * of unknown-model hits. The exporter warn-logs each key once per run.
 * Pure: no side effects.
 */
export function collectUnknownModels(entries: readonly UnifiedSessionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const r = estimateCost(e);
    if (r.unknownModelId !== undefined) {
      counts.set(r.unknownModelId, (counts.get(r.unknownModelId) ?? 0) + 1);
    }
  }
  return counts;
}
