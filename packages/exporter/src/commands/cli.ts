import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCliExport } from '../sources/cli.js';
import { findRepoRoot } from '../lib/repo-root.js';
import { validateEntries } from '../lib/validate-entry.js';
import { logger } from '../lib/logger.js';

export async function runCliSubcommand(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
      'phase2-output': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    logger.info(
      'chat-arch cli [--out <dir>] [--phase2-output <path>]\n\n' +
        '  Walk ~/.claude/projects, stream every top-level <uuid>.jsonl transcript,\n' +
        '  produce a unified cli-sessions.json and copy transcripts into\n' +
        '  local-transcripts/cli-{direct,desktop}/.\n\n' +
        "  Desktop-CLI transcripts (UUIDs also present in Phase 2's cowork-sessions.json\n" +
        '  as source="cli-desktop") are enriched with transcript-derived userTurns,\n' +
        '  tokens, etc. Everything else is cli-direct.\n\n' +
        '  Default --out:            <repo-root>/apps/standalone/public/chat-arch-data\n' +
        '  Default --phase2-output:  <out>/cowork-sessions.json',
    );
    return 0;
  }

  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(findRepoRoot(), 'apps/standalone/public/chat-arch-data');
  const phase2CoworkJsonPath = values['phase2-output']
    ? path.resolve(values['phase2-output'])
    : undefined;

  const started = Date.now();
  logger.info(`cli export → ${outDir}`);

  const result = await runCliExport({
    outDir,
    ...(phase2CoworkJsonPath !== undefined ? { phase2CoworkJsonPath } : {}),
  });

  const elapsedMs = Date.now() - started;
  logger.info(
    `cli export complete in ${elapsedMs} ms — cli-direct=${result.counts['cli-direct']}, cli-desktop=${result.counts['cli-desktop']}, transcripts copied=${result.transcriptsCopied}, skipped=${result.transcriptsSkipped}, malformed lines=${result.malformedLinesTotal}`,
  );

  // Post-write shape validation — R11.
  const errors = validateEntries(result.entries);
  if (errors.length > 0) {
    logger.error(`validateEntries() produced ${errors.length} errors on CLI output:`);
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
