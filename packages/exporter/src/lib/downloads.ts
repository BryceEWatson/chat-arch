import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const EXPORT_ZIP_RE = /^data-[0-9a-f-]+-[0-9]+-[0-9a-f]+-batch-\d+\.zip$/i;

/**
 * Scan `downloadsDir` for Claude cloud-export ZIPs matching
 * `data-<uuid>-<ts>-<hash>-batch-NNNN.zip` and return the absolute path of
 * the most recently modified one, or `null` if none exist or the directory
 * is unreadable.
 *
 * Pure I/O, no logging — callers decide how to surface "not found".
 */
export async function findLatestExportZip(downloadsDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(downloadsDir);
  } catch {
    return null;
  }

  const candidates: Array<{ abs: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!EXPORT_ZIP_RE.test(name)) continue;
    const abs = path.join(downloadsDir, name);
    try {
      const st = await stat(abs);
      if (!st.isFile()) continue;
      candidates.push({ abs, mtimeMs: st.mtimeMs });
    } catch {
      // inaccessible entry — skip.
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.abs;
}
