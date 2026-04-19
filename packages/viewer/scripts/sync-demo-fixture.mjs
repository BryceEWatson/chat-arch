/**
 * Copy the realistic fixture tree from `test/fixtures/` into the demo vite
 * publicDir at `demo/public/chat-arch-data/` so the dev harness can serve it.
 *
 * Run this any time the fixture changes. The dev script invokes it first.
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = resolve(ROOT, 'test/fixtures');
const DEST = resolve(ROOT, 'demo/public/chat-arch-data');

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });

// Root manifest.
await cp(resolve(SRC, 'realistic-manifest.json'), resolve(DEST, 'manifest.json'));

// Cloud conversations.
await mkdir(resolve(DEST, 'cloud-conversations'), { recursive: true });
await cp(resolve(SRC, 'conversations'), resolve(DEST, 'cloud-conversations'), { recursive: true });

// Local transcripts.
await cp(resolve(SRC, 'local-transcripts'), resolve(DEST, 'local-transcripts'), {
  recursive: true,
});

console.log(`Synced fixture from ${SRC} -> ${DEST}`);
