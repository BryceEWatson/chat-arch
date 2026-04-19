import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { runCoworkExport } from '../sources/cowork.js';
import { runCliExport } from '../sources/cli.js';
import { runCloudExport } from '../sources/cloud.js';
import { mergeSources } from '../merge.js';
import { runAnalysis } from '../analysis/index.js';
import { findRepoRoot } from '../lib/repo-root.js';
import { validateEntries } from '../lib/validate-entry.js';
import { logger } from '../lib/logger.js';

/**
 * Read the cloud-manifest.json written by a previous `cloud` phase.
 * Used by `--no-cloud` mode so the merged output preserves the user's
 * last uploaded-ZIP data even when the rescan skips the cloud phase.
 *
 * Returns `[]` when the file is absent or unreadable — a fresh repo
 * with no cloud data yet is a legitimate state, not an error.
 */
async function readExistingCloudEntries(outDir: string): Promise<readonly UnifiedSessionEntry[]> {
  const p = path.join(outDir, 'cloud-manifest.json');
  try {
    const raw = await readFile(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as UnifiedSessionEntry[];
  } catch {
    return [];
  }
}

export async function runAllSubcommand(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      zip: { type: 'string' },
      'no-cloud': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    logger.info(
      'chat-arch all [--zip <path>] [--no-cloud] [--out <dir>]\n\n' +
        '  Run cowork + cli + cloud phases sequentially and merge their output\n' +
        '  into a single unified manifest.json.\n\n' +
        '  --zip            Cloud-export ZIP path (default: latest match in ~/Downloads).\n' +
        '  --no-cloud       Skip the cloud phase entirely; keep any previously-written\n' +
        '                   cloud-manifest.json in the merge. Used by the viewer\n' +
        '                   "RESCAN" button — cloud data is only refreshed when the\n' +
        '                   user uploads a ZIP, not as part of rescanning local disks.\n' +
        '  --out, -o        Output directory\n' +
        '                   (default: <repo-root>/apps/standalone/public/chat-arch-data).\n',
    );
    return 0;
  }

  const noCloud = values['no-cloud'] === true;
  if (noCloud && values.zip !== undefined) {
    logger.error('`--no-cloud` and `--zip` are mutually exclusive.');
    return 2;
  }

  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(findRepoRoot(), 'apps/standalone/public/chat-arch-data');

  const totalStarted = Date.now();
  logger.info(`all → ${outDir}`);

  // ---- Phase 2: cowork ----
  logger.info('  [1/3] cowork: scanning…');
  const coworkStart = Date.now();
  let coworkResult;
  try {
    coworkResult = await runCoworkExport({ outDir });
  } catch (err) {
    logger.error(`cowork phase failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const coworkMs = Date.now() - coworkStart;
  const coworkReused = coworkResult.reuseCounts.cowork;
  const coworkRescanned = coworkResult.counts.cowork - coworkReused;
  const cliDesktopReused = coworkResult.reuseCounts['cli-desktop'];
  const cliDesktopRescanned = coworkResult.counts['cli-desktop'] - cliDesktopReused;
  logger.info(
    `  [1/3] cowork: cowork=${coworkResult.counts.cowork} (${coworkReused} reused, ${coworkRescanned} rescanned) ` +
      `cli-desktop=${coworkResult.counts['cli-desktop']} (${cliDesktopReused} reused, ${cliDesktopRescanned} rescanned) in ${coworkMs} ms`,
  );

  // ---- Phase 3: cli ----
  logger.info('  [2/3] cli: scanning…');
  const cliStart = Date.now();
  let cliResult;
  try {
    cliResult = await runCliExport({ outDir });
  } catch (err) {
    logger.error(`cli phase failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const cliMs = Date.now() - cliStart;
  const cliDirectReused = cliResult.reuseCounts['cli-direct'];
  const cliDirectRescanned = cliResult.counts['cli-direct'] - cliDirectReused;
  const cliDeskReused = cliResult.reuseCounts['cli-desktop'];
  const cliDeskRescanned = cliResult.counts['cli-desktop'] - cliDeskReused;
  logger.info(
    `  [2/3] cli: cli-direct=${cliResult.counts['cli-direct']} (${cliDirectReused} reused, ${cliDirectRescanned} rescanned) ` +
      `cli-desktop=${cliResult.counts['cli-desktop']} (${cliDeskReused} reused, ${cliDeskRescanned} rescanned) in ${cliMs} ms`,
  );

  // ---- Phase 4: cloud ----
  // Cloud is a manual-upload model: a new cloud export only exists on
  // disk when the user drops a fresh ZIP in ~/Downloads. `--no-cloud`
  // mode skips this phase entirely and reads the existing cloud-
  // manifest.json from the last successful cloud run, so the user's
  // previously-uploaded cloud data stays in the merged manifest.
  let cloudEntries: readonly UnifiedSessionEntry[];
  if (noCloud) {
    cloudEntries = await readExistingCloudEntries(outDir);
    logger.info(
      `  [3/3] cloud: skipped (no-cloud mode; preserved ${cloudEntries.length} entries from previous cloud-manifest.json)`,
    );
  } else {
    logger.info('  [3/3] cloud: scanning…');
    const cloudStart = Date.now();
    let cloudResult;
    try {
      cloudResult = await runCloudExport({
        outDir,
        ...(values.zip !== undefined ? { zipPath: values.zip } : {}),
      });
    } catch (err) {
      logger.error(`cloud phase failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const cloudMs = Date.now() - cloudStart;
    logger.info(
      `  [3/3] cloud: cloud=${cloudResult.counts.cloud} (zip=${cloudResult.zipPath}) in ${cloudMs} ms`,
    );
    cloudEntries = cloudResult.entries;
  }

  // ---- Merge ----
  const merged = mergeSources(coworkResult.entries, cliResult.entries, cloudEntries);

  const manifestAbs = path.join(outDir, 'manifest.json');
  await writeFile(manifestAbs, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  const totalMs = Date.now() - totalStarted;
  logger.info(
    `all complete in ${totalMs} ms — merged=${merged.sessions.length} ` +
      `(cowork=${merged.counts.cowork} cli-direct=${merged.counts['cli-direct']} cli-desktop=${merged.counts['cli-desktop']} cloud=${merged.counts.cloud}) → ${manifestAbs}`,
  );

  // Post-merge shape validation.
  const errors = validateEntries(merged.sessions);
  if (errors.length > 0) {
    logger.error(`validateEntries() produced ${errors.length} errors on merged manifest:`);
    for (const e of errors.slice(0, 50)) {
      logger.error(`  [entry ${e.entryIndex} id=${e.entryId}] field=${e.field}: ${e.problem}`);
    }
    if (errors.length > 50) {
      logger.error(`  ... (${errors.length - 50} more)`);
    }
    return 1;
  }

  // Phase 6: run browser-tier analysis writers (Decision 1).
  try {
    const analysisStart = Date.now();
    const result = await runAnalysis(merged, { outDir });
    logger.info(
      `analysis complete in ${Date.now() - analysisStart} ms — dup_clusters=${result.counts.duplicatesClusters} dup_sessions=${result.counts.duplicatesSessions} active=${result.counts.active} dormant=${result.counts.dormant} zombie=${result.counts.zombie} → ${result.analysisDir}`,
    );
  } catch (err) {
    logger.error(
      `analysis phase failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return 1;
  }

  return 0;
}
