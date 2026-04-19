#!/usr/bin/env node
import { runCoworkSubcommand } from './commands/cowork.js';
import { runCliSubcommand } from './commands/cli.js';
import { runCloudSubcommand } from './commands/cloud.js';
import { runAllSubcommand } from './commands/all.js';
import { runAnalyzeSubcommand } from './commands/analyze.js';
import { logger } from './lib/logger.js';

const USAGE = `\
chat-arch <subcommand> [options]

Subcommands:
  cowork   Walk %APPDATA%\\Claude (local-agent-mode-sessions + claude-code-sessions)
           and write cowork-sessions.json + copied manifests/transcripts.
  cli      Walk ~/.claude/projects/, stream each transcript, and write
           cli-sessions.json + copied transcripts (cli-direct + enriched cli-desktop).
  cloud    Unpack the Settings → Privacy export ZIP and write
           cloud-manifest.json + cloud-conversations/<uuid>.json.
  all      Run cowork + cli + cloud in sequence and merge into manifest.json.
           Also runs the Phase 6 browser-tier analysis writers.
  analyze  Re-run Phase 6 browser-tier analysis writers against an existing
           manifest.json (does not touch source exporters). Idempotent.

Options:
  -h, --help   Print help for the selected subcommand (or this usage).
  -o, --out    Output directory (default: <repo-root>/apps/standalone/public/chat-arch-data).
  --zip        Cloud-export ZIP path (for cloud/all; defaults to latest in ~/Downloads).
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === '-h' || sub === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const subArgs = argv.slice(1);

  let code: number;
  switch (sub) {
    case 'cowork':
      code = await runCoworkSubcommand(subArgs);
      break;
    case 'cli':
      code = await runCliSubcommand(subArgs);
      break;
    case 'cloud':
      code = await runCloudSubcommand(subArgs);
      break;
    case 'all':
      code = await runAllSubcommand(subArgs);
      break;
    case 'analyze':
      code = await runAnalyzeSubcommand(subArgs);
      break;
    default:
      logger.error(`unknown subcommand "${sub}"`);
      process.stdout.write(USAGE);
      process.exit(2);
  }
  process.exit(code);
}

main().catch((err: unknown) => {
  logger.error(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
