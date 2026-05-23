/**
 * Atomic file write — write to `<path>.tmp` then rename over the
 * destination. The rename is atomic on POSIX and best-effort on
 * Windows (NTFS rename is atomic at the metadata layer, which is
 * what we need to avoid a half-written JSON file being visible to
 * the viewer's static-server fetch).
 *
 * Used by every Phase 2/3 outcome-substrate builder so a crash mid-
 * write can't corrupt the prior sidecar.
 */

import { rename, writeFile } from 'node:fs/promises';

/**
 * Write `content` to `filePath` atomically by way of a sibling
 * `.tmp` file. Any prior contents at `filePath` survive a crash
 * during the write; the rename is the visibility boundary.
 */
export async function atomicWriteJson(
  filePath: string,
  content: string,
): Promise<void> {
  // Stamped tmp name so concurrent writers to the same destination
  // never share a tmp filename and race rename(). (S3)
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}
