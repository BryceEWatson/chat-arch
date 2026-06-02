/**
 * Atomic file write — write to a stamped sibling `.tmp` file then
 * rename over the destination. The rename is atomic on POSIX and
 * best-effort on Windows (NTFS rename is atomic at the metadata layer,
 * which is what we need to avoid a half-written JSON file being
 * visible to the viewer's static-server fetch).
 *
 * Both async and sync variants live here so every Phase 2/3 outcome-
 * substrate builder uses the same primitive — DN3 consolidation from
 * the PR #53 iter-2 review.
 *
 * Synchronous variants additionally call `fsyncSync()` on the tmp fd
 * before rename to guarantee durability; the async path relies on
 * Node's writeFile() ordering for the equivalent guarantee.
 */

import { rename, writeFile } from 'node:fs/promises';
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

/**
 * Windows raises these when the destination is momentarily held open by
 * another handle — most commonly the dev server's static-file middleware
 * serving the very sidecar we're rewriting during a rescan. The rename is
 * still the right primitive; the lock is transient, so we retry with a
 * short backoff instead of letting the write fail (which `runAnalysis`
 * fail-soft try/catch would swallow, silently leaving a STALE sidecar —
 * the bug this guards against). POSIX rename over an open file succeeds,
 * so these never fire there.
 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'ENOTEMPTY',
]);
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_BACKOFF_MS = 25;

function isTransientRenameError(err: unknown): boolean {
  return (
    err instanceof Error &&
    TRANSIENT_RENAME_CODES.has((err as NodeJS.ErrnoException).code ?? '')
  );
}

/** Synchronous sleep — used by the sync rename-retry on Windows lock races. */
function sleepSync(ms: number): void {
  // Atomics.wait blocks the thread without a busy-spin. The SharedArrayBuffer
  // is never signaled, so it always waits the full timeout.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stamped tmp filename so two concurrent writers to the same
 * destination never share a tmp name and race rename(). Format:
 * `<filePath>.tmp-<pid>-<msec>-<rand6>`. (S3)
 *
 * Exported so callers that need a hidden-dotfile naming convention
 * (e.g. ledger writers under apps/standalone) can use the same stamp
 * suffix by building the tmp path themselves.
 */
export function stampedTmpPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Async atomic write of `content` to `filePath`.
 */
export async function atomicWriteJson(
  filePath: string,
  content: string,
): Promise<void> {
  const tmpPath = stampedTmpPath(filePath);
  await writeFile(tmpPath, content, 'utf8');
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (err) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !isTransientRenameError(err)) throw err;
      await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS * attempt));
    }
  }
}

/**
 * Sync atomic write of a JSON-serializable value to `filePath`. Adds
 * a trailing newline. Calls `fsyncSync()` before rename so the bytes
 * are durable when the rename returns — important when the next
 * scan-stage may read the file before the OS flushes.
 *
 * Replaces 5+ inline copies in the outcome-substrate builders (DN3).
 */
export function atomicWriteJsonSync(target: string, value: unknown): void {
  atomicWriteTextSync(target, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Sync atomic write of a pre-serialized string to `target`. fsync'd
 * before rename. Used by the knowledge-debt builder for its `.md`
 * Obsidian export alongside the `.json` sidecar.
 */
export function atomicWriteTextSync(target: string, content: string): void {
  const tmp = stampedTmpPath(target);
  writeFileSync(tmp, content, 'utf8');
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(tmp, target);
      return;
    } catch (err) {
      if (attempt >= RENAME_MAX_ATTEMPTS || !isTransientRenameError(err)) throw err;
      sleepSync(RENAME_BACKOFF_MS * attempt);
    }
  }
}
