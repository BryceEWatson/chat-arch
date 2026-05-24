/**
 * `chat-arch embed` — run the v2 embedding pass against an existing manifest.
 *
 * Used for:
 *   - Iterative development on the embedding driver without re-running the
 *     full `all` pipeline.
 *   - Re-embedding after a model swap (`--model`) or a manual force
 *     (`--no-only-changed`).
 *
 * The driver is fail-soft on Ollama unavailability — see runEmbed in
 * `embeddings/embedDriver.ts`. This command never throws on a missing
 * Ollama; it logs and returns 0 so it slots into batch scripts cleanly.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { SessionManifest } from '@chat-arch/schema';
import { findRepoRoot } from '../lib/repo-root.js';
import { logger } from '../lib/logger.js';
import { runEmbed, V2_DEFAULT_EMBEDDING_MODEL } from '../embeddings/index.js';

export async function runEmbedSubcommand(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'only-changed': { type: 'boolean' },
      'no-only-changed': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    logger.info(
      'chat-arch embed [--out <dir>] [--model <name>] [--base-url <url>] [--only-changed|--no-only-changed]\n\n' +
        '  Embed every eligible session in manifest.json with the configured\n' +
        '  Ollama model and write analysis/embeddings.bin + analysis/embeddings.meta.json.\n\n' +
        '  --out, -o          Output directory containing manifest.json\n' +
        '                     (default: <repo-root>/apps/standalone/public/chat-arch-data).\n' +
        `  --model            Ollama model name (default: ${V2_DEFAULT_EMBEDDING_MODEL}).\n` +
        '  --base-url         Ollama base URL (default: http://localhost:11434).\n' +
        '  --only-changed     Reuse cached vectors when sourceMtimeMs is unchanged (default ON).\n' +
        '  --no-only-changed  Force re-embed every eligible session.\n',
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
      `embed: failed to read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const onlyChanged = values['no-only-changed'] !== true;

  logger.info(
    `embed: ${manifest.sessions.length} session(s) from ${manifestPath} ` +
      `(only-changed=${onlyChanged ? 'yes' : 'no'})`,
  );

  const started = Date.now();
  try {
    const result = await runEmbed({
      outDir,
      manifest,
      onlyChanged,
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values['base-url'] !== undefined ? { baseUrl: values['base-url'] } : {}),
    });
    if (result.skippedReason === undefined) {
      logger.info(
        `embed: done in ${Date.now() - started} ms — ` +
          `embedded=${result.embedded} reused=${result.reused} skipped=${result.skipped}`,
      );
    } else {
      logger.info(
        `embed: ${result.skippedReason} — no sidecars rewritten (or written empty for no-sessions).`,
      );
    }
    return 0;
  } catch (err) {
    logger.error(
      `embed: failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return 1;
  }
}
