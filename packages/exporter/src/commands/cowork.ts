import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCoworkExport } from '../sources/cowork.js';
import { findRepoRoot } from '../lib/repo-root.js';
import { validateEntries } from '../lib/validate-entry.js';
import { logger } from '../lib/logger.js';

export async function runCoworkSubcommand(argv: readonly string[]): Promise<number> {
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
      'chat-arch cowork [--out <dir>]\n\n' +
        '  Walk %APPDATA%\\Claude\\local-agent-mode-sessions and claude-code-sessions,\n' +
        '  produce a unified cowork-sessions.json and copy manifests + transcripts.\n' +
        '  Default --out: <repo-root>/apps/standalone/public/chat-arch-data',
    );
    return 0;
  }

  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(findRepoRoot(), 'apps/standalone/public/chat-arch-data');

  const started = Date.now();
  logger.info(`cowork export → ${outDir}`);

  const result = await runCoworkExport({ outDir });

  const elapsedMs = Date.now() - started;
  logger.info(
    `cowork export complete in ${elapsedMs} ms — cowork=${result.counts.cowork}, cli-desktop=${result.counts['cli-desktop']}, transcripts copied=${result.transcriptsCopied}, transcripts missing=${result.transcriptsMissing}, skipped=${result.sessionsSkipped}`,
  );

  // Post-write shape validation — R11.
  const errors = validateEntries(result.entries);
  if (errors.length > 0) {
    logger.error(`validateEntries() produced ${errors.length} errors on live output:`);
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
