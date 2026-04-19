/**
 * Populate apps/standalone/public/chat-arch-data/ with the viewer fixture
 * the FIRST time `pnpm dev` runs after a fresh clone. Without this, the
 * standalone app boots to an empty viewer because chat-arch-data/* is
 * gitignored — a hostile first impression.
 *
 * Idempotent: if chat-arch-data/manifest.json already exists, the script
 * does nothing. Real exporter output (or a previous demo seed) wins.
 *
 * Sentinel: writes a sibling `.demo` file so the viewer can show a
 * "DEMO DATA — run the exporter to see your own" banner. The exporter
 * does not write `.demo`, so once the user runs a real RESCAN the banner
 * disappears automatically.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STANDALONE_ROOT = resolve(HERE, '..');
const DEST = resolve(STANDALONE_ROOT, 'public/chat-arch-data');
const VIEWER_FIXTURES = resolve(STANDALONE_ROOT, '../../packages/viewer/test/fixtures');

if (existsSync(resolve(DEST, 'manifest.json'))) {
  process.stdout.write('[seed-demo-data] chat-arch-data/manifest.json exists — skipping.\n');
  process.exit(0);
}

if (!existsSync(VIEWER_FIXTURES)) {
  process.stderr.write(
    `[seed-demo-data] viewer fixtures not found at ${VIEWER_FIXTURES} — skipping.\n`,
  );
  process.exit(0);
}

await mkdir(DEST, { recursive: true });
await cp(resolve(VIEWER_FIXTURES, 'realistic-manifest.json'), resolve(DEST, 'manifest.json'));
await mkdir(resolve(DEST, 'cloud-conversations'), { recursive: true });
await cp(resolve(VIEWER_FIXTURES, 'conversations'), resolve(DEST, 'cloud-conversations'), {
  recursive: true,
});
await cp(resolve(VIEWER_FIXTURES, 'local-transcripts'), resolve(DEST, 'local-transcripts'), {
  recursive: true,
});
await writeFile(resolve(DEST, '.demo'), 'demo-fixture\n');

process.stdout.write('[seed-demo-data] chat-arch-data seeded with viewer demo fixture.\n');
