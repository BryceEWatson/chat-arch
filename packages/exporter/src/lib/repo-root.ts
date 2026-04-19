import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'pnpm-workspace.yaml';

let cachedRoot: string | undefined;

/**
 * Walk up from this module's directory looking for a `pnpm-workspace.yaml`
 * marker. Memoized at module scope. Fixes the Phase 1 `--out` default bug
 * where resolving a relative path off `process.cwd()` broke when the CLI
 * ran from a subdirectory.
 */
export function findRepoRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;

  // import.meta.dirname is Node 20+. Falls back to fileURLToPath for safety.
  const hereUrl = import.meta.url;
  let dir = path.dirname(fileURLToPath(hereUrl));

  // Walk up until we find the marker.
  // Hard cap at 20 hops to avoid infinite loop on a malformed mount.
  for (let i = 0; i < 20; i++) {
    if (existsSync(path.join(dir, MARKER))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `[chat-arch] Could not locate repo root (no ${MARKER} found walking up from ${fileURLToPath(hereUrl)})`,
  );
}

/** Test helper — clears the module-level cache between tests. */
export function _resetRepoRootCacheForTests(): void {
  cachedRoot = undefined;
}
