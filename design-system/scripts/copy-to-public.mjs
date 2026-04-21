#!/usr/bin/env node
// Copy the canonical design-system source files (spec.md, tokens.json)
// into the standalone app's public/ directory so Cloudflare Pages
// serves them verbatim at /design-system/spec.md and
// /design-system/tokens.json. The target directory is .gitignore'd
// so we don't track duplicates of the authoritative files under
// design-system/.
//
// Idempotent: run as the first step of apps/standalone's build script.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const source = resolve(repoRoot, 'design-system');
const target = resolve(repoRoot, 'apps/standalone/public/design-system');

mkdirSync(target, { recursive: true });

for (const filename of ['spec.md', 'tokens.json']) {
  copyFileSync(resolve(source, filename), resolve(target, filename));
}

console.log(`design-system assets copied to apps/standalone/public/design-system/`);
