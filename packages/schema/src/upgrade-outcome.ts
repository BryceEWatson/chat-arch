/**
 * Upgrade-outcome tracking shape (v2 §5 A.2).
 *
 * For each `AppliedImprovement`, the analysis tier observes the next N
 * sessions in the affected project (or using the affected skill) and
 * records whether the corrected pattern recurred and whether session
 * metrics improved. Sidecar: `analysis/upgrade-outcomes.json`.
 */

export interface UpgradeOutcomeMetricsSnapshot {
  meanUserTurns: number | null;
  meanCostUsd: number | null;
  errorMessageRate: number | null;
}

export interface UpgradeOutcome {
  /** id of the `AppliedImprovement` this outcome attaches to. */
  appliedImprovementId: string;
  /** id of the source `Pattern` from `corrections.json`. */
  patternId: string;
  appliedAt: number;
  /** The N session ids observed after the application (chronological). */
  observedSessionIds: readonly string[];
  /** Window size (default 10 unless tuned). */
  windowSize: number;
  /**
   * True iff the original correction pattern (text or semantic — see
   * A.1) matched at least one assistant turn in the observation window.
   */
  recurred: boolean;
  /**
   * Optional semantic-match signal: cosine similarity of the recurring
   * excerpt against the original. Absent when recurred === false.
   */
  recurrenceCosine?: number;
  metrics: {
    before: UpgradeOutcomeMetricsSnapshot;
    after: UpgradeOutcomeMetricsSnapshot;
  };
}

export interface UpgradeOutcomesFile {
  version: 1;
  generatedAt: number;
  outcomes: readonly UpgradeOutcome[];
}
