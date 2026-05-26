/**
 * Heuristic-vs-LLM merge helper for `narratives.json`. Consumed by
 * the exporter writer-side migration (rescan path) and the
 * `/mine-narratives` skill (Stage 2 write).
 *
 * The narrative-mining V1 feature introduces a second row family in
 * `narratives.json`: `attributedTo: 'llm-derived'` rows alongside the
 * existing `attributedTo: 'deterministic'` heuristic rows. Both row
 * families coexist in one file. This helper enforces the pinned merge
 * policy so the two writers (rescan + skill) never accidentally
 * delete each other's family.
 *
 * Contract (pinned in narrative-mining V1 spec §"Merge policy"):
 *
 *   - `heuristic` → newly-emitted heuristic rows for THIS rescan. Caller
 *     passes them as-is; they replace any previous heuristic rows.
 *   - `existingLlm` → LLM rows already on disk (caller filters via
 *     `classifyAttribution(normalizeNarrativeRow(row)) === 'llm'`).
 *   - `incomingLlm` → new LLM rows being introduced this call (empty
 *     when called from the rescan path; populated when called from the
 *     skill's Stage 2 write).
 *   - `mode` → scope of the call:
 *       - `'full-rewrite'` (default): every projectId's LLM rows in
 *         `existingLlm` are preserved EXCEPT those that appear in
 *         `incomingLlm` — those projects' LLM rows are replaced.
 *       - `{ projectId }`: only this project's LLM rows are eligible
 *         for replacement; all other projects' LLM rows are preserved
 *         untouched. Off-project rows in `incomingLlm` are dropped
 *         with a log (NOT thrown — see edge case d).
 *
 * Edge cases (spec §"Merge policy"):
 *
 *   (a) empty `heuristic` → result contains only `existingLlm` ∪
 *       `incomingLlm`.
 *   (b) empty `existingLlm` + empty `incomingLlm` → result is
 *       `heuristic` only (first-ever run after upgrade).
 *   (c) id collision between heuristic and either LLM array → log
 *       warning + drop the COLLIDING LLM row (heuristic precedence).
 *       Do NOT throw — id-namespace separation SHOULD prevent this,
 *       but one corrupted row should not crash the rescan chain.
 *   (d) `mode = { projectId }` with off-project rows in `incomingLlm`
 *       → drop the off-project rows with log, retain in-project ones.
 *       NOT thrown.
 *   (e) Row order in the output: heuristic rows first (matches legacy
 *       disk order), then LLM rows ordered by `confidence` desc within
 *       each projectId.
 *   (f) `mode` argument with garbage type → throw `TypeError`. This IS
 *       a programmer-error case, not a data-quality case.
 *
 * Pure, browser-safe.
 */

import type { Narrative } from '@chat-arch/schema';

export interface MergeNarrativeFamiliesInputs {
  /** Newly-emitted heuristic rows (always tagged `attributedTo: 'deterministic'`). */
  heuristic: readonly Narrative[];
  /** LLM rows already on disk (read by the caller from the existing narratives.json). */
  existingLlm: readonly Narrative[];
  /** New LLM rows being introduced this call (empty when called from the rescan path). */
  incomingLlm?: readonly Narrative[];
  /**
   * Scope of the call. Default `'full-rewrite'`.
   *   - `'full-rewrite'`: every projectId's LLM rows in `existingLlm`
   *     are preserved except those that appear in `incomingLlm` —
   *     those get replaced wholesale.
   *   - `{ projectId }`: only this project's LLM rows are eligible for
   *     replacement; all other projects' LLM rows are preserved untouched.
   */
  mode?: 'full-rewrite' | { projectId: string };
}

/**
 * Compose the merged narrative-row list for writing to
 * `narratives.json`. Returns a fresh array; inputs are not mutated.
 */
export function mergeNarrativeFamilies(
  inputs: MergeNarrativeFamiliesInputs,
): readonly Narrative[] {
  const { heuristic, existingLlm } = inputs;
  const incomingLlm = inputs.incomingLlm ?? [];
  const mode = validateMode(inputs.mode);

  // ---- LLM family ----
  // Decide which existing LLM rows survive, then merge in the incoming
  // rows. Project-scoped replacement (`mode = { projectId }`) drops
  // off-project rows from `incomingLlm` with a log.

  const heuristicIds = new Set<string>();
  for (const row of heuristic) heuristicIds.add(row.id);

  let survivingExistingLlm: Narrative[];
  let scopedIncomingLlm: Narrative[];

  if (mode === 'full-rewrite') {
    // Drop existing LLM rows whose projectId appears in incomingLlm —
    // the incoming set wholesale-replaces those projects' LLM rows.
    const replacedProjectIds = new Set<string>();
    for (const row of incomingLlm) replacedProjectIds.add(row.projectId);
    survivingExistingLlm = existingLlm.filter(
      (row) => !replacedProjectIds.has(row.projectId),
    );
    scopedIncomingLlm = [...incomingLlm];
  } else {
    // Project-scoped: only this projectId's existing LLM rows are
    // evicted; everyone else's existing LLM rows survive untouched.
    const scopedProjectId = mode.projectId;
    survivingExistingLlm = existingLlm.filter(
      (row) => row.projectId !== scopedProjectId,
    );
    // Drop off-project incomingLlm rows with a log (edge case d).
    scopedIncomingLlm = [];
    for (const row of incomingLlm) {
      if (row.projectId === scopedProjectId) {
        scopedIncomingLlm.push(row);
      } else {
        console.warn(
          `mergeNarrativeFamilies: dropping off-project LLM row ${row.id} (projectId=${row.projectId}, scope=${scopedProjectId}).`,
        );
      }
    }
  }

  // Drop id collisions with the heuristic family with a log (edge case c).
  const filteredExistingLlm: Narrative[] = [];
  for (const row of survivingExistingLlm) {
    if (heuristicIds.has(row.id)) {
      console.warn(
        `mergeNarrativeFamilies: dropping existing LLM row ${row.id} that collides with a heuristic row id (id namespace was breached on disk).`,
      );
      continue;
    }
    filteredExistingLlm.push(row);
  }
  const filteredIncomingLlm: Narrative[] = [];
  for (const row of scopedIncomingLlm) {
    if (heuristicIds.has(row.id)) {
      console.warn(
        `mergeNarrativeFamilies: dropping incoming LLM row ${row.id} that collides with a heuristic row id (id namespace breached upstream).`,
      );
      continue;
    }
    filteredIncomingLlm.push(row);
  }

  // ---- Order per spec §"Merge policy" edge case (e) ----
  // Heuristic rows first (legacy disk order), then LLM rows by
  // confidence desc within each projectId.
  const allLlm: Narrative[] = [...filteredExistingLlm, ...filteredIncomingLlm];
  allLlm.sort((a, b) => {
    // Group by projectId first so within-project ordering is contiguous.
    if (a.projectId !== b.projectId) {
      return a.projectId < b.projectId ? -1 : 1;
    }
    const ac = typeof a.confidence === 'number' ? a.confidence : 0;
    const bc = typeof b.confidence === 'number' ? b.confidence : 0;
    return bc - ac;
  });

  return [...heuristic, ...allLlm];
}

/**
 * Validate the `mode` argument shape. Default to `'full-rewrite'` when
 * absent; throw on garbage types (programmer-error case per spec §
 * "Merge policy" edge case f).
 */
function validateMode(
  mode: MergeNarrativeFamiliesInputs['mode'],
): 'full-rewrite' | { projectId: string } {
  if (mode === undefined) return 'full-rewrite';
  if (mode === 'full-rewrite') return 'full-rewrite';
  if (
    typeof mode === 'object' &&
    mode !== null &&
    typeof (mode as { projectId?: unknown }).projectId === 'string'
  ) {
    return { projectId: (mode as { projectId: string }).projectId };
  }
  throw new TypeError(
    `mergeNarrativeFamilies: invalid mode argument; expected 'full-rewrite' or { projectId: string }, got ${String(mode)}.`,
  );
}
