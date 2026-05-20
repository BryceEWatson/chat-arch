/**
 * Export-manifest writer.
 *
 * Writes `analysis/exports/manifest.json` indexing every generated
 * markdown/Obsidian export. The viewer's Wave-4 export panel reads
 * this file to render the checklist.
 *
 * Atomic write via tmp + rename (same idiom as the analysis writers).
 * Node-only — uses `node:fs/promises` and `node:path`.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Schema-shape version. Bump whenever the on-disk fields change.
 * The viewer's manifest reader gates on this; an older viewer will
 * refuse to load a newer-version manifest rather than silently miss
 * fields.
 */
export const EXPORT_MANIFEST_VERSION = 1;

/**
 * Per-export entry. `relativePath` is relative to `outDir` (typically
 * `chat-arch-data/`), so the viewer can resolve files without knowing
 * the absolute disk layout.
 */
export interface ExportManifestEntry {
  /** Stable identifier for the export — usually the source sessionId. */
  id: string;
  /** Kind of export this entry represents. Drives viewer iconography. */
  kind: 'post-mortem' | 'knowledge-debt' | 'other';
  /** Path relative to `outDir`. e.g. `exports/post-mortems/abc-123.md`. */
  relativePath: string;
  /** ISO timestamp when this entry was generated. */
  generatedAt: string;
  /** Optional human-readable title surfaced in the viewer checklist. */
  title?: string;
  /** Optional tags propagated from the frontmatter (deduped, sorted). */
  tags?: readonly string[];
}

export interface ExportManifest {
  manifestVersion: number;
  generatedAt: string;
  entries: readonly ExportManifestEntry[];
}

export interface WriteExportManifestResult {
  manifestPath: string;
  entries: number;
}

/**
 * Build the on-disk manifest object. Pure — separate from the I/O step
 * so tests can assert on shape without touching the filesystem.
 */
export function buildExportManifest(
  entries: readonly ExportManifestEntry[],
  nowMs: number = Date.now(),
): ExportManifest {
  // Sort by relativePath for stable diffs; this also gives the viewer
  // a deterministic order to render in.
  const sorted = [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    manifestVersion: EXPORT_MANIFEST_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    entries: sorted,
  };
}

/**
 * Write the manifest to `<outDir>/analysis/exports/manifest.json`.
 * `outDir` is typically the project's `chat-arch-data` root.
 *
 * Atomic: writes to `manifest.json.tmp-<pid>-<ts>` then renames.
 */
export async function writeExportManifest(
  outDir: string,
  entries: readonly ExportManifestEntry[],
  options?: { now?: number },
): Promise<WriteExportManifestResult> {
  const manifest = buildExportManifest(entries, options?.now ?? Date.now());
  const dir = path.join(outDir, 'analysis', 'exports');
  await mkdir(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(tmp, manifestPath);
  return { manifestPath, entries: manifest.entries.length };
}
