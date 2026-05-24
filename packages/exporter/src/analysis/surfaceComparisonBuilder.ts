/**
 * Phase 3 #6 — surface-comparison builder.
 *
 * Groups sessions by `(source, archetypeId)`, computes a Wilson 95% CI
 * on the composite-binary "good" share per cell, then runs pairwise
 * two-proportion z-tests between cells whose both ns clear
 * `THRESHOLDS.display.minNForRate`, with Holm-Bonferroni multiplicity
 * correction across all qualifying pairs.
 *
 * Hard-depends on archetypes (#5) — reads `analysis/archetypes.json`
 * for the `(sessionId → archetypeId)` map. Aborts with a clear error
 * if missing; the caller should run the archetypes builder first.
 *
 * Cache: re-runs unconditionally. The output is small and the inputs
 * (manifest + composite + archetypes) change in lockstep.
 *
 * Node-only — file I/O. Pure stats live in `@chat-arch/analysis`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CompositeOutcome,
  CompositeOutcomesFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { THRESHOLDS, wilsonCI } from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';
import { atomicWriteJson } from '../lib/atomicWrite.js';
import type { ArchetypesFile } from './archetypesBuilder.js';

export interface SurfaceCell {
  /** Composite key: `<source>|<archetypeId>`. */
  key: string;
  source: string;
  archetypeId: string;
  /** Total sessions in this cell (cap'd to those with a composite outcome). */
  n: number;
  /** Sessions where `binary === 'good'`. */
  good: number;
  /** Empirical good-share (good / n); NaN when n == 0. */
  pHat: number;
  /** Wilson 95% CI on `pHat`. */
  ci: { low: number; high: number };
  /** Whether the cell clears `THRESHOLDS.display.minNForRate`. */
  meetsDisplayN: boolean;
}

export interface SurfacePairwiseTest {
  a: string;
  b: string;
  /** Raw two-sided p-value. */
  pValue: number;
  /** Holm-Bonferroni-adjusted p across the family of qualifying pairs. */
  pValueAdjusted: number;
  /** `pAdjusted < familyAlpha`. */
  significant: boolean;
}

export interface SurfaceComparisonFile {
  version: 1;
  generatedAt: number;
  /** Alpha used for the Holm-Bonferroni rejection threshold. */
  familyAlpha: number;
  /** Per-cell stats. */
  cells: readonly SurfaceCell[];
  /** Pairwise tests over cells that BOTH clear `minNForRate`. */
  pairwise: readonly SurfacePairwiseTest[];
}

export interface BuildSurfaceComparisonOptions {
  outDir: string;
  now: number;
  /** Override alpha for the family rejection threshold. Default 0.05. */
  familyAlpha?: number;
}

export interface BuildSurfaceComparisonResult {
  file: SurfaceComparisonFile;
  cellsTotal: number;
  cellsDisplayable: number;
  pairsTested: number;
  pairsSignificant: number;
}

const DEFAULT_FAMILY_ALPHA = 0.05;

async function loadArchetypes(outDir: string): Promise<ArchetypesFile> {
  const p = path.join(outDir, 'analysis', 'archetypes.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    throw new Error(
      `surfaceComparison: required input analysis/archetypes.json is missing — run buildArchetypesFile first.`,
    );
  }
  try {
    return JSON.parse(raw) as ArchetypesFile;
  } catch (err) {
    throw new Error(
      `surfaceComparison: analysis/archetypes.json is malformed — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function loadCompositeOutcomes(
  outDir: string,
): Promise<Map<string, CompositeOutcome>> {
  const p = path.join(outDir, 'analysis', 'composite-outcomes.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    // Soft dependency: missing composite means no cells will have
    // good>0, but we still emit the (n) cells so the viewer can show
    // the n-too-small note.
    return new Map();
  }
  let parsed: CompositeOutcomesFile;
  try {
    parsed = JSON.parse(raw) as CompositeOutcomesFile;
  } catch {
    return new Map();
  }
  const out = new Map<string, CompositeOutcome>();
  for (const o of parsed.outcomes ?? []) {
    if (typeof o.sessionId === 'string') out.set(o.sessionId, o);
  }
  return out;
}

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 approximation
 * of erf. Mirrors the implementation in `skillCurve.ts`; inlined here
 * because that's an internal helper of the analysis package.
 */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t) *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Pooled two-proportion z-test. Returns the two-sided p-value of the
 * null hypothesis p_a = p_b. Pooled estimate is the standard form for
 * this test under H_0.
 */
function twoProportionPValue(
  good_a: number,
  n_a: number,
  good_b: number,
  n_b: number,
): number {
  if (n_a <= 0 || n_b <= 0) return 1;
  const pA = good_a / n_a;
  const pB = good_b / n_b;
  const pPool = (good_a + good_b) / (n_a + n_b);
  if (pPool === 0 || pPool === 1) return 1;
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n_a + 1 / n_b));
  if (se === 0) return 1;
  const z = (pA - pB) / se;
  // Two-sided.
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Holm-Bonferroni step-down. Returns adjusted p-values in input order.
 * Algorithm: sort p ascending; adjusted_i = min(1, max over j<=i of
 * (m - j) * p_{(j)}). Standard step-down form.
 */
function holmBonferroni(ps: readonly number[]): number[] {
  const m = ps.length;
  if (m === 0) return [];
  const indexed = ps.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);
  const adjSorted: number[] = new Array(m);
  let running = 0;
  for (let j = 0; j < m; j += 1) {
    const factor = m - j;
    const candidate = factor * indexed[j]!.p;
    if (candidate > running) running = candidate;
    adjSorted[j] = Math.max(0, Math.min(1, running));
  }
  const out = new Array<number>(m);
  for (let j = 0; j < m; j += 1) out[indexed[j]!.i] = adjSorted[j]!;
  return out;
}

export async function buildSurfaceComparisonFile(
  manifest: SessionManifest,
  options: BuildSurfaceComparisonOptions,
): Promise<BuildSurfaceComparisonResult> {
  const t0 = Date.now();
  const archetypes = await loadArchetypes(options.outDir);
  const composite = await loadCompositeOutcomes(options.outDir);
  const familyAlpha = options.familyAlpha ?? DEFAULT_FAMILY_ALPHA;
  const minN = THRESHOLDS.display.minNForRate;

  const assignments = archetypes.assignments ?? {};

  // Build (source, archetypeId) → {n, good}.
  const cellAcc = new Map<string, { source: string; archetype: string; n: number; good: number }>();
  for (const entry of manifest.sessions as readonly UnifiedSessionEntry[]) {
    const archetypeId = assignments[entry.id];
    if (typeof archetypeId !== 'string') continue;
    const source = entry.source;
    const key = `${source}|${archetypeId}`;
    const slot = cellAcc.get(key) ?? { source, archetype: archetypeId, n: 0, good: 0 };
    slot.n += 1;
    const outcome = composite.get(entry.id);
    if (outcome !== undefined && outcome.binary === 'good') slot.good += 1;
    cellAcc.set(key, slot);
  }

  const cells: SurfaceCell[] = [];
  for (const [key, slot] of cellAcc) {
    const pHat = slot.n > 0 ? slot.good / slot.n : Number.NaN;
    const ci = wilsonCI(Number.isFinite(pHat) ? pHat : 0, slot.n);
    cells.push({
      key,
      source: slot.source,
      archetypeId: slot.archetype,
      n: slot.n,
      good: slot.good,
      pHat,
      ci,
      meetsDisplayN: slot.n >= minN,
    });
  }
  cells.sort((a, b) => a.key.localeCompare(b.key));

  // Pairwise tests over cells that BOTH clear minN.
  const displayable = cells.filter((c) => c.meetsDisplayN);
  const rawPs: number[] = [];
  const pairKeys: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < displayable.length; i += 1) {
    for (let j = i + 1; j < displayable.length; j += 1) {
      const A = displayable[i]!;
      const B = displayable[j]!;
      const p = twoProportionPValue(A.good, A.n, B.good, B.n);
      rawPs.push(p);
      pairKeys.push({ a: A.key, b: B.key });
    }
  }
  const adjusted = holmBonferroni(rawPs);
  const pairwise: SurfacePairwiseTest[] = rawPs.map((p, idx) => {
    const adj = adjusted[idx]!;
    return {
      a: pairKeys[idx]!.a,
      b: pairKeys[idx]!.b,
      pValue: p,
      pValueAdjusted: adj,
      significant: adj < familyAlpha,
    };
  });

  const file: SurfaceComparisonFile = {
    version: 1,
    generatedAt: options.now,
    familyAlpha,
    cells,
    pairwise,
  };

  const outPath = path.join(options.outDir, 'analysis', 'surface-comparison.json');
  await atomicWriteJson(outPath, JSON.stringify(file, null, 2) + '\n');

  const sig = pairwise.filter((p) => p.significant).length;
  logger.info(
    `analysis: surface-comparison.json — ${cells.length} cells (${displayable.length} ≥ n_min), ${pairwise.length} pairs tested, ${sig} significant after Holm, ${Date.now() - t0}ms`,
  );

  return {
    file,
    cellsTotal: cells.length,
    cellsDisplayable: displayable.length,
    pairsTested: pairwise.length,
    pairsSignificant: sig,
  };
}
