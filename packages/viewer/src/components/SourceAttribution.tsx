/**
 * Per-insight source attribution micro-label (Decision 18).
 *
 * Every chip / badge / KPI derived from an analysis output gets one of
 * these suffix labels so the user can tell at a glance what's Phase-6
 * regex and what's Phase-7 judgment:
 *
 *   DUP · exact            (Phase 6 duplicates.exact.json)
 *   DUP · semantic         (Phase 7 duplicates.semantic.json)
 *   DUP · exact+semantic   (viewer-merged per Decision 14)
 *   ZOMBIE · heuristic     (Phase 6 zombies.heuristic.json)
 *   ZOMBIE · diagnosed     (Phase 7 zombies.diagnosed.json)
 *   COST · estimate        (exporter-computed from rate table)
 *   COST · exact           (manifest.totalCostUsd when present)
 *   COST · diagnosed       (Phase 7 cost-diagnoses.json)
 *
 * Rev3 narrative-derived chips get rung labels (Phase Rev3-G G3):
 *
 *   NARRATIVE · tier1                    (candidate; supports ≥ 1)
 *   NARRATIVE · tier2                    (established; eligible for curator feed)
 *   NARRATIVE · tier3                    (promotable; eligible for encode-as-pattern)
 *   FINDING   · llm-derived              (Rev3-F curator output, generator only)
 *   FINDING   · falsifier-verified       (Rev3-F survived /falsify pass)
 *   NARRATIVE · deterministic-with-prior (Rev3-B Bayesian smoothing kicked in)
 *   ANY       · correlation-significant  (Rev3-G G2 gate passed)
 *
 * Palette: dim (`--lcars-dim`, opacity 0.7 per `[R-D18]`) so the label
 * reads as metadata, not chrome. Full-opacity on the parent chip handles
 * the primary signal; this label is the footnote.
 */

export type AttributionKind =
  | 'exact'
  | 'heuristic'
  | 'estimate'
  | 'exact+semantic'
  | 'semantic'
  | 'diagnosed'
  | 'tier1'
  | 'tier2'
  | 'tier3'
  | 'llm-derived'
  | 'falsifier-verified'
  | 'deterministic-with-prior'
  | 'correlation-significant';

/**
 * Subset of `AttributionKind` introduced by Phase Rev3-G G3. Exported
 * so consumers can constrain themselves to the new rungs without
 * coupling to the broader union (e.g. a curator-feed renderer only
 * ever emits these seven values).
 */
export const REV3_ATTRIBUTION_KINDS: readonly AttributionKind[] = [
  'tier1',
  'tier2',
  'tier3',
  'llm-derived',
  'falsifier-verified',
  'deterministic-with-prior',
  'correlation-significant',
];

export interface SourceAttributionProps {
  /** The label suffix. Rendered with a leading middle-dot separator. */
  kind: AttributionKind;
  /**
   * Optional override — defaults to "kind" as the accessible label. Use
   * when the surrounding chip already narrates the subject (e.g.
   * `DUP · exact (5)` — the chip says DUP, this label just whispers "exact").
   */
  ariaLabel?: string;
}

/**
 * Render a `· {kind}` micro-label. Inline-block so it sits flush inside
 * a chip without breaking baseline. Always dim + opacity 0.7 — the visual
 * opacity is load-bearing (mixing with a full-brightness chip creates the
 * "footnote" read; changing it would defeat Decision 18).
 */
export function SourceAttribution({ kind, ariaLabel }: SourceAttributionProps) {
  return (
    <span className="lcars-attribution" aria-label={ariaLabel ?? `source: ${kind}`}>
      {` · ${kind}`}
    </span>
  );
}
