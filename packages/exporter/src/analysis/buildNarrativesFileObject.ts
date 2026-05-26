/**
 * Pure file-object composer for `analysis/narratives.json`.
 *
 * Both writers (the exporter's writer-side migration + the
 * `/mine-narratives` skill's Stage 2c write) serialize the same shape
 * via this composer so the file-level structure is single-sourced.
 * The composer is intentionally OWN-NOTHING: it takes the inputs as a
 * record of known fields + an optional `passthrough` map of unrecognized
 * top-level keys read from disk, and emits the merged record. Reserved
 * keys in `passthrough` are dropped with a `console.warn` (the known-key
 * contract wins over forward-compat passthrough).
 *
 * Pure, side-effect-free apart from the warn-on-collision log line.
 */

import type {
  Narrative,
  NarrativesFile,
  NarrativeThresholdsSnapshot,
  SkippedRow,
} from '@chat-arch/schema';

export interface BuildNarrativesFileObjectKnown {
  generatedAt: number;
  exporterVersion: string;
  thresholds: NarrativeThresholdsSnapshot;
  narratives: readonly Narrative[];
  skipped: readonly SkippedRow[];
}

const RESERVED_KEYS = new Set<string>([
  'generatedAt',
  'exporterVersion',
  'thresholds',
  'narratives',
  'skipped',
]);

/**
 * Compose a `NarrativesFile` from known fields + optional passthrough
 * for unrecognized top-level keys read from disk. Known fields take
 * precedence; passthrough entries are spread in for any key NOT in
 * `RESERVED_KEYS`. Reserved-key entries in `passthrough` are dropped
 * with a `console.warn`.
 */
export function buildNarrativesFileObject(
  known: BuildNarrativesFileObjectKnown,
  passthrough?: Record<string, unknown>,
): NarrativesFile {
  const extras: Record<string, unknown> = {};
  if (passthrough !== undefined) {
    for (const [k, v] of Object.entries(passthrough)) {
      if (RESERVED_KEYS.has(k)) {
        console.warn(
          `buildNarrativesFileObject: dropping passthrough key '${k}' — reserved by the known-field contract.`,
        );
        continue;
      }
      // Defense against prototype pollution: skip JS prototype-related
      // keys. JSON.parse can land `__proto__` / `constructor` /
      // `prototype` as own properties on the parsed object; spreading
      // them through `extras` into the output would propagate the
      // pollution down to readers. Drop with warning instead.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        console.warn(
          `buildNarrativesFileObject: dropping passthrough key '${k}' — JS prototype-related identifier.`,
        );
        continue;
      }
      extras[k] = v;
    }
  }

  return {
    ...extras,
    generatedAt: known.generatedAt,
    exporterVersion: known.exporterVersion,
    thresholds: known.thresholds,
    narratives: known.narratives,
    skipped: known.skipped,
  };
}
