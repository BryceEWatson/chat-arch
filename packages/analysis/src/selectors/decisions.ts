/**
 * DECISIONS selector — the `data → view-model` derivations behind the
 * DECISIONS surface, extracted VERBATIM from `DecisionsMode.tsx`
 * (Phase 1 of the "Centralize data processing" refactor).
 *
 * Two derivations live here:
 *   - `partitionDecisions` — the classified / unclassified split.
 *   - `groupDecisionsByKind` — group the classified rows by decision
 *     kind with the per-group landed-rate denominator + landed count.
 *
 * Pure / deterministic / React-free. The component renders the returned
 * `KindGroup[]` (and the partition) without doing any further derivation.
 */

import type { Decision } from '@chat-arch/schema';

/**
 * Human-readable label per decision kind, surfaced as the group header.
 * Unknown kinds fall back to the upper-cased key (see `groupDecisionsByKind`).
 */
export const KIND_LABEL: Record<string, string> = {
  'explicit-marker': 'EXPLICIT MARKER',
  'explicit-go-with': 'GO-WITH',
  'instead-of': 'INSTEAD-OF',
  'alternative-block': 'ALTERNATIVE',
  'imperative-choice': 'IMPERATIVE',
  'tool-pivot': 'TOOL PIVOT',
  'scope-cut': 'SCOPE CUT',
  other: 'OTHER',
};

export interface KindGroup {
  key: string;
  label: string;
  rows: Decision[];
  /** outcomeRef present AND non-neutral — landed-rate denominator. */
  denom: number;
  landed: number;
}

/**
 * Split the decisions file rows into classified (classification !== null)
 * and unclassified (classification === null) buckets — the same partition
 * DecisionsMode computed inline via two `.filter` passes.
 */
export function partitionDecisions(decisions: readonly Decision[]): {
  classified: Decision[];
  unclassified: Decision[];
} {
  return {
    classified: decisions.filter((d) => d.classification !== null),
    unclassified: decisions.filter((d) => d.classification === null),
  };
}

export function groupDecisionsByKind(
  classified: readonly Decision[],
): KindGroup[] {
  const m = new Map<string, Decision[]>();
  for (const d of classified) {
    const k = d.classification?.kind ?? 'other';
    const arr = m.get(k);
    if (arr) arr.push(d);
    else m.set(k, [d]);
  }
  const out: KindGroup[] = [];
  for (const [key, rows] of m) {
    let denom = 0;
    let landed = 0;
    for (const r of rows) {
      const ref = r.outcomeRef;
      if (ref === null || ref.binaryClass === 'neutral') continue;
      denom += 1;
      if (ref.binaryClass === 'good') landed += 1;
    }
    out.push({
      key,
      label: KIND_LABEL[key] ?? key.toUpperCase(),
      rows,
      denom,
      landed,
    });
  }
  out.sort(
    (a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label),
  );
  return out;
}
