/** Phase 6 developer utility; parallel to pipeline CLI. Covered by
 *  integration runs against the real 1,464-session manifest (AC2/AC4/AC5
 *  regen path); no dedicated unit test per orchestrator ruling in
 *  phase6-review-scope.md. */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { CURRENT_SCHEMA_VERSION } from '@chat-arch/schema';
import { findRepoRoot } from '../lib/repo-root.js';
import { logger } from '../lib/logger.js';
import { runAnalysis } from '../analysis/index.js';
import { estimateCost } from '../cost/estimate.js';

/**
 * `chat-arch analyze` — re-runs Phase 6 analysis writers against an already
 * built manifest. Used for:
 *   - CI / verification runs (AC2, AC4, AC5)
 *   - Iterating on analysis heuristics without re-exporting all 1,464 sessions
 *
 * Behavior:
 *   1. Read `<outDir>/manifest.json`
 *   2. If schemaVersion < 2, re-populate cost fields on every entry
 *      (idempotent — exact cost wins, estimates re-computed) and rewrite
 *      the manifest in place. Prevents a stale v1 manifest from silently
 *      flowing through to the viewer.
 *   3. Run `runAnalysis(manifest, {outDir})` to write
 *      `analysis/duplicates.exact.json`, `analysis/zombies.heuristic.json`,
 *      `analysis/meta.json`.
 *
 * Never touches `cowork-sessions.json`, `cli-sessions.json`, `cloud-manifest.json`.
 */
export async function runAnalyzeSubcommand(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    logger.info(
      'chat-arch analyze [--out <dir>]\n\n' +
        '  Re-run Phase 6 browser-tier analysis writers against an existing\n' +
        '  manifest.json. Writes analysis/duplicates.exact.json,\n' +
        '  analysis/zombies.heuristic.json, and analysis/meta.json.\n\n' +
        '  --out, -o   Output directory containing manifest.json\n' +
        '              (default: <repo-root>/apps/standalone/public/chat-arch-data).\n',
    );
    return 0;
  }

  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(findRepoRoot(), 'apps/standalone/public/chat-arch-data');

  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest: SessionManifest;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as SessionManifest;
  } catch (err) {
    logger.error(
      `analyze: failed to read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  logger.info(
    `analyze: loaded manifest schemaVersion=${manifest.schemaVersion} sessions=${manifest.sessions.length} → ${outDir}`,
  );

  // Backfill cost fields + bump schemaVersion if needed.
  if (manifest.schemaVersion < CURRENT_SCHEMA_VERSION) {
    logger.info(
      `analyze: backfilling cost fields (schemaVersion ${manifest.schemaVersion} → ${CURRENT_SCHEMA_VERSION})`,
    );
    const unknownCounts = new Map<string, number>();
    const sessions = manifest.sessions.map((e): UnifiedSessionEntry => {
      const r = estimateCost(e);
      if (r.unknownModelId !== undefined) {
        unknownCounts.set(r.unknownModelId, (unknownCounts.get(r.unknownModelId) ?? 0) + 1);
      }
      return {
        ...e,
        costEstimatedUsd: r.costEstimatedUsd,
        costIsEstimate: r.costIsEstimate,
        ...(r.breakdown !== undefined ? { costBreakdown: r.breakdown } : {}),
      };
    });
    for (const [modelId, count] of unknownCounts) {
      logger.warn(
        `cost: unknown modelId "${modelId}" seen in ${count} session(s); costEstimatedUsd set to null`,
      );
    }
    manifest = {
      ...manifest,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sessions,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    logger.info(
      `analyze: manifest rewritten with cost fields populated on ${sessions.length} sessions`,
    );
  }

  const started = Date.now();
  const result = await runAnalysis(manifest, { outDir });
  logger.info(
    `analyze complete in ${Date.now() - started} ms — dup_clusters=${result.counts.duplicatesClusters} dup_sessions=${result.counts.duplicatesSessions} active=${result.counts.active} dormant=${result.counts.dormant} zombie=${result.counts.zombie} → ${result.analysisDir}`,
  );
  return 0;
}
