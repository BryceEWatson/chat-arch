import type { Sentiment, NarrativeAction } from './sentiment.js';
import { UNASSIGNED_PROJECT_ID } from './project.js';

/**
 * Per-narrative evidence row — one excerpt anchoring the claim to a
 * specific session and (optionally — Rev3-B B2) the exact transcript
 * turn where the supporting moment occurred. `turnIndex` is 0-based
 * to match the `session_messages` ordinal indexing.
 */
export interface NarrativeEvidence {
  sessionId: string;
  anchor?: string;
  excerpt?: string;
  /** 0-based message turn within the session. Optional (B2). */
  turnIndex?: number;
}

/**
 * "How the narrative concluded what it concluded" — the provenance
 * triple introduced in Phase Rev3-B. `intent` names what the kernel
 * was looking for; `observation` records the concrete pattern it
 * matched; `inference` is the load-bearing claim derived from the
 * observation. Together they let the falsifier (Rev3-F) check
 * "does the cited evidence actually support the inference?"
 */
export interface NarrativeProvenance {
  /** What the kernel was looking for ("repeated bash failures"). */
  intent: string;
  /** What the kernel observed ("3 of 5 sessions failed `pnpm test`"). */
  observation: string;
  /** What the kernel inferred ("project's test setup is flaky"). */
  inference: string;
}

/**
 * Attribution of the narrative's existence — `'deterministic'` for
 * kernels that match observable patterns from session data;
 * `'llm-derived'` for narratives a curator/LLM synthesized from
 * evidence. Drives the SourceAttribution rung shown to the user.
 *
 * `'deterministic-with-prior'` is the post-calibration variant —
 * a deterministic kernel whose Bayesian prior has been refined by
 * historical engagement data.
 */
export type NarrativeAttribution =
  | 'deterministic'
  | 'deterministic-with-prior'
  | 'llm-derived'
  | 'falsifier-verified';

/**
 * Outcome-correlation summary attached to a narrative. Surfaces only
 * when `evidence.length >= THRESHOLDS.curator.outcomeCorrelationEvidenceMinLength`
 * AND `Math.abs(delta) / standardError >= THRESHOLDS.curator.outcomeCorrelationSignificance`
 * (Welch's t / permutation test from `packages/analysis/src/stats.ts`).
 *
 * `null` (the field absent in JSON) means "not computed yet" or
 * "computed but below the significance gate" — viewer must NOT
 * display a correlation tag when this is null.
 */
export interface NarrativeCorrelatedOutcome {
  /** `pCited - pUncited` (good-share delta on outcome.binary === 'good'). */
  delta: number;
  /** Standard error on the delta — drives the significance gate. */
  standardError: number;
  /** Number of cited sessions in the comparison (pCited's n). */
  citedCount: number;
  /** Number of uncited sessions in the project (pUncited's n). */
  uncitedCount: number;
}

export interface Narrative {
  id: string;
  projectId: string;
  sessionIds: readonly string[];
  sentiment: Sentiment;
  title: string;
  body: string;
  evidence: readonly NarrativeEvidence[];
  generatedAt: string;
  actionType: NarrativeAction;

  // ----- Rev3-B B1 provenance fields (optional on schemaVersion=1; the
  //       backfill in B5 fills them in + bumps schemaVersion to 2) -----

  /**
   * Wire-format version of this Narrative row.
   *   - `1`: pre-Rev3-B legacy shape (no provenance fields).
   *   - `2`: Rev3-B+ shape; provenance fields populated.
   * Required (matches `UnifiedSessionEntry.schemaVersion` and
   * `AppliedImprovementsFile.schemaVersion` in the same package — the
   * type-level requirement prevents writer footguns where omitting
   * the field would silently skip v2 structural checks).
   * `validateNarrative` accepts both versions. Backfill (B5) bumps
   * every v1 row to v2 with `attributedTo='deterministic'` and
   * `confidence=computeConfidence(...)` from the existing evidence
   * count + a fresh prior.
   */
  schemaVersion: 1 | 2;

  /** Provenance triple — required for schemaVersion=2. */
  provenance?: NarrativeProvenance;

  /** How this narrative came to exist. Required for schemaVersion=2. */
  attributedTo?: NarrativeAttribution;

  /**
   * ISO-8601 timestamp of the last falsifier verification of this
   * narrative's evidence chain. `null` (absent) means "not yet
   * falsifier-verified" — Rev3-F is responsible for setting this.
   * Required-shape but value `null` is legal on schemaVersion=2.
   */
  verifiedAt?: string | null;

  /**
   * Bayesian posterior confidence in the inference, computed via
   * `computeConfidence(supporting, contradicting, prior)` (B6).
   *   `0 ≤ confidence ≤ 1`.
   * Drives the three-rung tier gating (`narrativeRung.tier1/2/3`
   * in THRESHOLDS). Required for schemaVersion=2.
   */
  confidence?: number;

  /** Count of evidence rows that support the inference. */
  supportingCount?: number;

  /** Count of evidence rows that contradict the inference. */
  contradictingCount?: number;

  /**
   * Outcome-correlation summary (good-share delta on cited vs.
   * uncited sessions). `null` means "below significance gate or
   * not computed"; the viewer must not display the correlation
   * tag when this is null. Optional even on schemaVersion=2.
   */
  correlatedOutcome?: NarrativeCorrelatedOutcome | null;
}

export class InvalidNarrativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNarrativeError';
  }
}

/**
 * Validate a Narrative against either schema version 1 (legacy) or
 * 2 (Rev3-B provenance fields populated). The shape-level checks
 * common to both versions run first; v2-specific structural checks
 * run only when `schemaVersion === 2`.
 *
 * Phase Rev3-B B4: callers can pass v1 rows in untouched (no
 * provenance fields required) and v2 rows are checked for shape
 * completeness. The backfill in B5 produces only v2 rows; the v1
 * acceptance is for the legacy on-disk corpus.
 */
export function validateNarrative(n: Narrative): void {
  if (n.projectId === UNASSIGNED_PROJECT_ID) {
    throw new InvalidNarrativeError(
      `Narrative ${n.id} has projectId === ${UNASSIGNED_PROJECT_ID}; the unassigned pseudo-project does not bear narratives (spec §4.3, decision D8).`,
    );
  }
  if (n.sentiment === 'neutral') {
    throw new InvalidNarrativeError(
      `Narrative ${n.id} has neutral sentiment; only positive/negative narratives are emitted (spec §4.4).`,
    );
  }
  const expected: NarrativeAction =
    n.sentiment === 'positive' ? 'encode-as-pattern' : 'generate-corrective-prompt';
  if (n.actionType !== expected) {
    throw new InvalidNarrativeError(
      `Narrative ${n.id} actionType ${n.actionType} mismatches sentiment ${n.sentiment} (expected ${expected}).`,
    );
  }

  // Rev3-B B4: dual-version acceptance. Treat absent schemaVersion as
  // 1 (legacy); validate v2-shape only when the field is explicitly 2.
  const version = n.schemaVersion ?? 1;
  if (version !== 1 && version !== 2) {
    throw new InvalidNarrativeError(
      `Narrative ${n.id} has unknown schemaVersion ${String(version)}; expected 1 or 2.`,
    );
  }
  if (version === 2) {
    if (!n.provenance) {
      throw new InvalidNarrativeError(
        `Narrative ${n.id} schemaVersion=2 requires provenance (intent/observation/inference).`,
      );
    }
    for (const k of ['intent', 'observation', 'inference'] as const) {
      if (typeof n.provenance[k] !== 'string' || n.provenance[k].length === 0) {
        throw new InvalidNarrativeError(
          `Narrative ${n.id} schemaVersion=2 has empty provenance.${k}.`,
        );
      }
    }
    if (!n.attributedTo) {
      throw new InvalidNarrativeError(
        `Narrative ${n.id} schemaVersion=2 requires attributedTo.`,
      );
    }
    if (typeof n.confidence !== 'number' || n.confidence < 0 || n.confidence > 1) {
      throw new InvalidNarrativeError(
        `Narrative ${n.id} schemaVersion=2 confidence must be a number in [0,1]; got ${String(n.confidence)}.`,
      );
    }
    if (typeof n.supportingCount !== 'number' || n.supportingCount < 0) {
      throw new InvalidNarrativeError(
        `Narrative ${n.id} schemaVersion=2 supportingCount must be a non-negative number.`,
      );
    }
    if (typeof n.contradictingCount !== 'number' || n.contradictingCount < 0) {
      throw new InvalidNarrativeError(
        `Narrative ${n.id} schemaVersion=2 contradictingCount must be a non-negative number.`,
      );
    }
  }
}
