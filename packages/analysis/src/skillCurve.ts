/**
 * Skill-transfer curve detection (#9 in the outcome-substrate roadmap).
 *
 * For each topic, we track weekly ask-counts. Three classifications
 * matter:
 *
 *   - **Learning**: ask-count trend is monotonically decreasing
 *     (Mann-Kendall significant after BH-FDR correction). User is
 *     internalizing the topic; AI assistance is being needed less often.
 *
 *   - **Stuck-dependent**: trend is flat or increasing AND the topic's
 *     per-active-session ask-rate is at-or-above corpus median. User is
 *     leaning on AI repeatedly without integrating the lesson.
 *
 *   - **Steady**: everything else (flat/increasing but low-rate, or
 *     trend non-significant). No call to action.
 *
 * Method:
 *
 *   1. Mann-Kendall S statistic — count concordant minus discordant
 *      pairs over the series. Variance is ties-corrected per Kendall
 *      1962. z = (S - sign(S)) / sqrt(Var(S))  (continuity correction);
 *      two-sided p from the standard normal CDF.
 *
 *   2. Benjamini-Hochberg FDR correction across the topic family —
 *      family = topics passing `THRESHOLDS.skillCurve.minWeeksPresent`
 *      at this refresh. NOT cumulative across refreshes; that limitation
 *      is documented in the methodology disclosure.
 *
 *   3. Classification per the table above.
 *
 * Browser-safe pure functions. No randomness — Mann-Kendall is
 * deterministic.
 */

import { THRESHOLDS } from './thresholds.js';

export interface SkillCurvePoint {
  /** ISO-week label, e.g. "2025-W23". Caller responsibility. */
  readonly week: string;
  /** Number of asks (turns / sessions) referencing this topic in that week. */
  readonly askCount: number;
  /** Active sessions in that week (denominator for the rate). */
  readonly activeSessions: number;
}

export interface SkillCurveSeries {
  /** Stable topic identifier (e.g. cluster id or topic label). */
  readonly topicId: string;
  /** Optional human-readable label for the viewer. */
  readonly label?: string;
  /** Weekly points, expected (but not required) to be chronologically ordered. */
  readonly points: readonly SkillCurvePoint[];
}

export type SkillCurveClassification =
  | 'Learning'
  | 'Stuck-dependent'
  | 'Steady'
  | 'Insufficient';

export interface SkillCurveResult {
  readonly topicId: string;
  readonly label: string | undefined;
  readonly classification: SkillCurveClassification;
  /** Mann-Kendall S (signed count of concordant minus discordant pairs). */
  readonly mannKendallS: number;
  /** z statistic with continuity correction; NaN when degenerate. */
  readonly z: number;
  /** Raw two-sided p-value. */
  readonly pValue: number;
  /** BH-adjusted p-value (NaN when filtered out of the family). */
  readonly pValueAdjusted: number;
  /** Per-active-session ask rate (sum askCount / sum activeSessions). */
  readonly askPerActiveSession: number;
  /** Number of weeks present in the series (after filtering empty padding). */
  readonly weeksPresent: number;
}

export interface AnalyzeSkillCurvesOptions {
  /**
   * Override the minimum weeks required to enter the test family.
   * Default `THRESHOLDS.skillCurve.minWeeksPresent`.
   */
  readonly minWeeksPresent?: number;
  /**
   * BH-FDR α threshold. Default `THRESHOLDS.skillCurve.bhFdrAlpha`.
   */
  readonly bhFdrAlpha?: number;
}

/**
 * Run Mann-Kendall + BH-FDR over a set of per-topic weekly series.
 * Returns one result per input series, including filtered-out topics
 * (with `classification: 'Insufficient'`) so the caller can render the
 * full topic list.
 */
export function analyzeSkillCurves(
  perTopicSeries: readonly SkillCurveSeries[],
  opts: AnalyzeSkillCurvesOptions = {},
): SkillCurveResult[] {
  const minWeeksPresent = opts.minWeeksPresent ?? THRESHOLDS.skillCurve.minWeeksPresent;
  const bhFdrAlpha = opts.bhFdrAlpha ?? THRESHOLDS.skillCurve.bhFdrAlpha;

  // Compute corpus median of askPerActiveSession over the FAMILY (topics
  // that pass minWeeksPresent). Used by the Stuck-dependent classifier.
  type Raw = {
    topicId: string;
    label: string | undefined;
    points: readonly SkillCurvePoint[];
    weeksPresent: number;
    askPerActiveSession: number;
    inFamily: boolean;
  };
  const rawList: Raw[] = perTopicSeries.map((s) => {
    const points = s.points;
    const totalAsk = points.reduce((a, p) => a + p.askCount, 0);
    const totalActive = points.reduce((a, p) => a + p.activeSessions, 0);
    return {
      topicId: s.topicId,
      label: s.label,
      points,
      weeksPresent: points.length,
      askPerActiveSession: totalActive > 0 ? totalAsk / totalActive : 0,
      inFamily: points.length >= minWeeksPresent,
    };
  });

  const familyRates = rawList
    .filter((r) => r.inFamily)
    .map((r) => r.askPerActiveSession)
    .sort((a, b) => a - b);
  const corpusMedian =
    familyRates.length === 0
      ? 0
      : familyRates.length % 2 === 1
        ? familyRates[(familyRates.length - 1) / 2]!
        : (familyRates[familyRates.length / 2 - 1]! + familyRates[familyRates.length / 2]!) / 2;

  // Run Mann-Kendall on every in-family series; insufficient series get sentinel values.
  type Mk = { S: number; z: number; p: number };
  const mkByTopic = new Map<string, Mk>();
  const familyPs: { topicId: string; p: number }[] = [];
  for (const r of rawList) {
    if (!r.inFamily) continue;
    const series = r.points.map((p) => p.askCount);
    const mk = mannKendall(series);
    mkByTopic.set(r.topicId, mk);
    familyPs.push({ topicId: r.topicId, p: mk.p });
  }

  // BH-FDR over the family.
  const adjusted = benjaminiHochberg(familyPs.map((x) => x.p));
  const adjByTopic = new Map<string, number>();
  familyPs.forEach((x, i) => adjByTopic.set(x.topicId, adjusted[i]!));

  const results: SkillCurveResult[] = rawList.map((r) => {
    if (!r.inFamily) {
      return {
        topicId: r.topicId,
        label: r.label,
        classification: 'Insufficient',
        mannKendallS: 0,
        z: Number.NaN,
        pValue: Number.NaN,
        pValueAdjusted: Number.NaN,
        askPerActiveSession: r.askPerActiveSession,
        weeksPresent: r.weeksPresent,
      };
    }
    const mk = mkByTopic.get(r.topicId)!;
    const pAdj = adjByTopic.get(r.topicId) ?? Number.NaN;

    let classification: SkillCurveClassification;
    if (mk.S < 0 && pAdj < bhFdrAlpha) {
      classification = 'Learning';
    } else if (mk.S >= 0 && r.askPerActiveSession >= corpusMedian) {
      classification = 'Stuck-dependent';
    } else {
      classification = 'Steady';
    }

    return {
      topicId: r.topicId,
      label: r.label,
      classification,
      mannKendallS: mk.S,
      z: mk.z,
      pValue: mk.p,
      pValueAdjusted: pAdj,
      askPerActiveSession: r.askPerActiveSession,
      weeksPresent: r.weeksPresent,
    };
  });

  return results;
}

/**
 * Mann-Kendall trend test with ties correction and continuity correction.
 *
 *   S = sum_{i<j} sign(x_j - x_i)
 *   Var(S) = (n(n-1)(2n+5) - sum_g g(g-1)(2g+5)) / 18
 *   z = (S - sign(S)) / sqrt(Var(S))   (continuity correction)
 *
 * Where g iterates over groups of tied values and the sum corrects the
 * variance for those groups. Returns the raw two-sided p-value.
 *
 * Exported (not just internal) so callers can run MK on series outside
 * the skill-curve framing — e.g. composite-score trends.
 */
export function mannKendall(series: readonly number[]): { S: number; z: number; p: number } {
  const n = series.length;
  if (n < 2) return { S: 0, z: Number.NaN, p: Number.NaN };

  let S = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = (series[j] as number) - (series[i] as number);
      if (d > 0) S += 1;
      else if (d < 0) S -= 1;
    }
  }

  // Ties correction.
  const groups = new Map<number, number>();
  for (const v of series) groups.set(v, (groups.get(v) ?? 0) + 1);
  let tieSum = 0;
  for (const g of groups.values()) {
    if (g > 1) tieSum += g * (g - 1) * (2 * g + 5);
  }
  const varS = (n * (n - 1) * (2 * n + 5) - tieSum) / 18;
  if (varS <= 0) return { S, z: Number.NaN, p: Number.NaN };

  const sigma = Math.sqrt(varS);
  let z: number;
  if (S > 0) z = (S - 1) / sigma;
  else if (S < 0) z = (S + 1) / sigma;
  else z = 0;

  // Two-sided p from the standard normal CDF.
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { S, z, p: Math.max(0, Math.min(1, p)) };
}

/**
 * Benjamini-Hochberg step-up adjusted p-values. Returns adjusted
 * p-values in the SAME order as the input (not sorted).
 *
 * Algorithm: sort p-values ascending; the BH-adjusted p at rank i is
 * min over j >= i of (p_j * m / j). Monotonicity is enforced from the
 * largest rank backwards.
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  const adjustedSorted: number[] = new Array(m);
  // Step-up: walk from largest rank to smallest, carrying the running minimum.
  let running = 1;
  for (let rank = m - 1; rank >= 0; rank--) {
    const p = indexed[rank]!.p;
    const candidate = (p * m) / (rank + 1);
    running = Math.min(running, candidate);
    adjustedSorted[rank] = Math.max(0, Math.min(1, running));
  }

  const out = new Array<number>(m);
  for (let r = 0; r < m; r++) out[indexed[r]!.i] = adjustedSorted[r]!;
  return out;
}

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 approximation
 * of erf. Max abs error ~1.5e-7; plenty for a p-value calculation.
 */
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
