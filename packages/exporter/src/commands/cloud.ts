import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCloudExport } from '../sources/cloud.js';
import { findRepoRoot } from '../lib/repo-root.js';
import { validateEntries } from '../lib/validate-entry.js';
import { logger } from '../lib/logger.js';

export async function runCloudSubcommand(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      zip: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    logger.info(
      'chat-arch cloud [--zip <path>] [--out <dir>]\n\n' +
        '  Unpack a Claude cloud-export ZIP (Settings → Privacy → Export) and\n' +
        '  produce cloud-manifest.json + cloud-conversations/<uuid>.json.\n\n' +
        '  --zip            Path to the data-*-batch-*.zip file. If omitted, the\n' +
        '                   most recently modified matching ZIP in ~/Downloads\n' +
        '                   is used.\n' +
        '  --out, -o        Output directory\n' +
        '                   (default: <repo-root>/apps/standalone/public/chat-arch-data).\n',
    );
    return 0;
  }

  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(findRepoRoot(), 'apps/standalone/public/chat-arch-data');

  const started = Date.now();
  logger.info(`cloud export → ${outDir}`);

  let result;
  try {
    result = await runCloudExport({
      outDir,
      ...(values.zip !== undefined ? { zipPath: values.zip } : {}),
    });
  } catch (err) {
    logger.error(`cloud export failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const elapsedMs = Date.now() - started;
  const summaryCount = result.entries.filter((e) => e.summary !== undefined).length;
  logger.info(
    `cloud export complete in ${elapsedMs} ms — zip=${result.zipPath}, entries=${result.counts.cloud}, with-summary=${summaryCount}, skipped=${result.conversationsSkipped}`,
  );

  // Post-write shape validation.
  const errors = validateEntries(result.entries);
  if (errors.length > 0) {
    logger.error(`validateEntries() produced ${errors.length} errors on cloud output:`);
    for (const e of errors.slice(0, 50)) {
      logger.error(`  [entry ${e.entryIndex} id=${e.entryId}] field=${e.field}: ${e.problem}`);
    }
    if (errors.length > 50) {
      logger.error(`  ... (${errors.length - 50} more)`);
    }
    return 1;
  }

  return 0;
}
