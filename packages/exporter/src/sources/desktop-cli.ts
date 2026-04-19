import { readFile, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DesktopCliManifestKnown,
  DesktopCliManifestRaw,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { UNTITLED_SESSION } from '@chat-arch/schema';
import { logger } from '../lib/logger.js';
import { toPosixRelative } from '../lib/paths.js';

/** Result of processing one Desktop-CLI manifest, with reuse signal. */
export interface ProcessDesktopCliResult {
  entry: UnifiedSessionEntry;
  /** True when the entry was reused verbatim from the previous run's cache. */
  reused: boolean;
}

const DESKTOP_CLI_KNOWN_KEYS = new Set<string>([
  'sessionId',
  'cliSessionId',
  'cwd',
  'originCwd',
  'createdAt',
  'lastActivityAt',
  'model',
  'effort',
  'isArchived',
  'title',
  'titleSource',
  'permissionMode',
  'chromePermissionMode',
  'enabledMcpTools',
  'remoteMcpServersConfig',
]);

/**
 * Parse, validate, drift-log, and copy one Desktop-CLI manifest into
 * `outDir/manifests/cli-desktop/<rawSessionId>.json`. Returns a
 * UnifiedSessionEntry or null if the manifest is unreadable / invalid.
 *
 * Phase 3 overwrites `userTurns` (currently 0) and sets `transcriptPath`
 * after walking `~/.claude/projects/`.
 */
export async function processDesktopCliManifest(
  manifestPath: string,
  outDir: string,
  prevEntries?: Map<string, UnifiedSessionEntry>,
): Promise<ProcessDesktopCliResult | null> {
  // Stat first — mtime is the cache key for the incremental-rescan
  // fast path. Desktop-CLI manifests are rewritten on every activity
  // update, so file mtime is a reliable staleness signal.
  let currentMtime: number;
  try {
    const st = await stat(manifestPath);
    currentMtime = st.mtimeMs;
  } catch {
    currentMtime = 0;
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    logger.warn(`could not read Desktop-CLI manifest ${manifestPath}: ${(err as Error).message}`);
    return null;
  }

  let parsed: DesktopCliManifestRaw;
  try {
    parsed = JSON.parse(raw) as DesktopCliManifestRaw;
  } catch (err) {
    logger.warn(
      `Desktop-CLI manifest ${manifestPath} is not valid JSON: ${(err as Error).message}; skipping`,
    );
    return null;
  }

  if (!isMinimallyValid(parsed)) {
    logger.warn(`Desktop-CLI manifest ${manifestPath} missing required minimum fields; skipping`);
    return null;
  }

  const manifest = parsed;

  // Fast path: mtime unchanged since last rescan → reuse the entry.
  // Even cheaper than cowork's because Desktop-CLI has no audit file
  // to aggregate, just the manifest itself.
  if (prevEntries && currentMtime > 0) {
    const prev = prevEntries.get(`cli-desktop:${manifest.cliSessionId}`);
    if (
      prev !== undefined &&
      typeof prev.sourceMtimeMs === 'number' &&
      prev.sourceMtimeMs === currentMtime
    ) {
      return { entry: prev, reused: true };
    }
  }

  // Drift detection.
  for (const k of Object.keys(parsed)) {
    if (!DESKTOP_CLI_KNOWN_KEYS.has(k)) {
      logger.warnOnce(
        `cli-desktop-drift-key:${k}`,
        `Desktop-CLI manifest contains unknown key "${k}" (first seen in ${manifestPath}); entry emitted anyway`,
      );
    }
  }

  const manifestOutRel = path.join('manifests', 'cli-desktop', `${manifest.sessionId}.json`);
  const manifestOutAbs = path.join(outDir, manifestOutRel);
  try {
    await copyFile(manifestPath, manifestOutAbs);
  } catch (err) {
    logger.warn(
      `could not copy Desktop-CLI manifest to ${manifestOutAbs}: ${(err as Error).message}`,
    );
  }

  const entry: UnifiedSessionEntry = {
    // REQUIRED
    id: manifest.cliSessionId,
    source: 'cli-desktop',
    rawSessionId: manifest.sessionId,
    startedAt: manifest.createdAt,
    updatedAt: manifest.lastActivityAt,
    durationMs: manifest.lastActivityAt - manifest.createdAt, // R2
    title: manifest.title || UNTITLED_SESSION,
    titleSource: 'manifest',
    preview: null, // Desktop-CLI has no initialMessage equivalent
    userTurns: 0, // TODO(phase-3): overwrite with transcript-derived count
    model: manifest.model, // verbatim, keep [1m] suffix
    cwdKind: 'host',
    totalCostUsd: null, // Desktop-CLI has no cost summary; Phase 4 merge may fill

    // OPTIONAL (conditional spread)
    cwd: manifest.cwd,
    manifestPath: toPosixRelative(manifestOutAbs, outDir),
    // Cached manifest mtime drives the incremental-rescan fast path.
    ...(currentMtime > 0 ? { sourceMtimeMs: currentMtime } : {}),
    // transcriptPath, auditPath, assistantTurns, modelsUsed: omitted Phase 2
  };

  return { entry, reused: false };
}

function isMinimallyValid(
  m: Partial<DesktopCliManifestKnown> | DesktopCliManifestRaw,
): m is DesktopCliManifestKnown {
  return (
    typeof m.sessionId === 'string' &&
    typeof m.cliSessionId === 'string' &&
    typeof m.createdAt === 'number' &&
    typeof m.lastActivityAt === 'number' &&
    typeof m.title === 'string' &&
    typeof m.cwd === 'string' &&
    typeof m.model === 'string'
  );
}
