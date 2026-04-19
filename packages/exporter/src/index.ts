import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionManifest } from '@chat-arch/schema';

export interface RunExportOptions {
  outDir: string;
}

export interface RunExportResult {
  manifest: SessionManifest;
  outDir: string;
  manifestPath: string;
}

/**
 * Phase 1 stub — kept for backwards compat. Writes an empty manifest.json.
 * Phase 4 replaces this with the true unified merge. Not called by the new
 * subcommand dispatcher.
 */
export async function runExport(options: RunExportOptions): Promise<RunExportResult> {
  const manifest: SessionManifest = {
    schemaVersion: 1,
    generatedAt: Date.now(),
    counts: { cloud: 0, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 },
    sessions: [],
  };
  await mkdir(options.outDir, { recursive: true });
  const manifestPath = path.join(options.outDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifest, outDir: options.outDir, manifestPath };
}

export { runCoworkExport } from './sources/cowork.js';
export type { RunCoworkExportOptions, CoworkExportResult } from './sources/cowork.js';
export { processDesktopCliManifest } from './sources/desktop-cli.js';
export { runCliExport } from './sources/cli.js';
export type { RunCliExportOptions, CliExportResult } from './sources/cli.js';
export {
  runCloudExport,
  buildEntry as buildCloudEntry,
  buildCloudOutputs,
} from './sources/cloud.js';
export type { RunCloudExportOptions, CloudExportResult } from './sources/cloud.js';
export { buildCloudEntries } from './cloud-mapping.js';
export type { CloudSourceData, CloudMappingResult } from './cloud-mapping.js';
export { mergeSources } from './merge.js';
export { validateEntries } from './lib/validate-entry.js';
export type { ValidationError } from './lib/validate-entry.js';
