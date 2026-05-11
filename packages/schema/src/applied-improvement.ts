/**
 * Applied-improvement ledger — Phase 1 corrections-loop closure.
 *
 * When the user clicks APPLY on a `ProposedUpgrade` in the corrections
 * panel, the standalone server appends an entry to
 * `analysis/applied-improvements.json` (this module's shape). The
 * viewer's loader merges that ledger over the canonical
 * `corrections.json` at read time, flipping each matching upgrade's
 * `applied`/`appliedAt` and recomputing `recurringPostApplication` —
 * `corrections.json` is never mutated, so re-mining always overwrites
 * cleanly without losing the user's apply history.
 *
 * Idempotency key is the triple `(patternId, proposedUpgrade.target,
 * proposedUpgrade.targetPath)`. Re-applying the same upgrade replaces
 * the existing entry (the user re-confirmed; bookkeeping reflects the
 * latest decision, not a duplicate).
 */

import type { ProposedUpgrade } from './correction.js';

export interface AppliedImprovement {
  /** Stable id assigned at first-apply time. UUID-v4. */
  id: string;
  /** `CorrectionPattern.id` whose upgrade was applied. */
  patternId: string;
  /** ms-since-epoch of the apply click. */
  appliedAt: number;
  /**
   * Snapshot of `CorrectionPattern.canonicalRule` at apply time, kept so
   * the ledger remains human-readable even if the pattern is later
   * dropped from `corrections.json` (a re-mine on a smaller window can
   * elide patterns whose instances fell outside the window).
   */
  ruleSummary: string;
  /**
   * Verbatim copy of the applied `ProposedUpgrade`. The merge step uses
   * `(target, targetPath)` to find the matching upgrade in the live
   * `corrections.json`; the patch text is preserved here so the viewer
   * can show "what you applied" even when the live pattern's upgrades
   * have shifted.
   */
  proposedUpgrade: ProposedUpgrade;
  /**
   * Optional free-text list of files the user reports they edited
   * (e.g. `["~/.claude/CLAUDE.md", "<repo>/CLAUDE.md"]`). Not validated
   * by the server — purely a user-facing audit note.
   */
  targetFiles?: string[];
  /** Optional free-text apply note ("moved to PostToolUse hook" etc.). */
  notes?: string;
}

export interface AppliedImprovementsFile {
  schemaVersion: 1;
  generatedAt: number;
  entries: AppliedImprovement[];
}
