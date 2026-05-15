import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { UNTITLED_SESSION } from '@chat-arch/schema';
import { logger } from './logger.js';
import { buildPreview } from './preview.js';

/**
 * `sessions-index.json` is a per-project-dir index Anthropic's CLI maintains
 * alongside `<uuid>.jsonl` transcripts under `~/.claude/projects/<dir>/`.
 * Crucially, the index outlives the transcripts: Anthropic auto-prunes old
 * `.jsonl` files but leaves the index entries behind, preserving session
 * metadata (sessionId, firstPrompt, messageCount, gitBranch, projectPath,
 * timestamps) for sessions whose conversation body is gone.
 *
 * This walker reconstructs `UnifiedSessionEntry`s from index entries whose
 * transcript file no longer exists on disk, emitting them with
 * `transcriptStatus: 'pruned'`. Entries whose transcript IS still on disk
 * are NOT emitted — they're already covered by `findTranscriptPaths` /
 * `streamAggregate` (which produce richer entries with tokens, tools,
 * subagent rollups). De-dup is by the transcript-file existence check.
 */

interface SessionsIndexEntry {
  sessionId: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface SessionsIndexFile {
  version?: number;
  entries?: readonly SessionsIndexEntry[];
}

/**
 * Truncate a long firstPrompt down to a title-shaped string.
 * Mirrors `truncate` in cli.ts:`resolveTitle`.
 */
function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max);
}

/**
 * Walk one `sessions-index.json` and produce synthetic entries for every
 * indexed session whose `fullPath` transcript no longer exists on disk.
 *
 * @param indexPath  Absolute path to a `sessions-index.json` file.
 * @param cwdKind    `'host'` for Windows-host CLI / WSL CLI walkers (the
 *                   indexed `projectPath` is a real filesystem path).
 * @param sourceTag  `'cli-direct'` — pruned sessions match the cli-direct
 *                   shape; cli-desktop entries come from Cowork manifests
 *                   which carry their own metadata and don't get pruned
 *                   from `~/.claude/projects/` since the CLI never touched
 *                   them in the first place.
 *
 * Never throws. Missing / malformed index → returns []. Per-entry
 * malformed/incomplete records are silently skipped.
 */
export async function readPrunedFromSessionsIndex(
  indexPath: string,
  cwdKind: 'host',
  sourceTag: 'cli-direct',
): Promise<readonly UnifiedSessionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: SessionsIndexFile;
  try {
    parsed = JSON.parse(raw) as SessionsIndexFile;
  } catch (err) {
    logger.warnOnce(
      `sessions-index-malformed:${indexPath}`,
      `sessions-index.json ${indexPath} is not valid JSON: ${(err as Error).message}; skipping`,
    );
    return [];
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  if (entries.length === 0) return [];

  // Cache fileExists across entries to avoid stat-ing the same path twice
  // when an index lists duplicates (rare but possible).
  const existsCache = new Map<string, boolean>();
  const checkExists = async (p: string): Promise<boolean> => {
    const cached = existsCache.get(p);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      const st = await stat(p);
      ok = st.isFile();
    } catch {
      ok = false;
    }
    existsCache.set(p, ok);
    return ok;
  };

  const out: UnifiedSessionEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e.sessionId !== 'string' || e.sessionId.length === 0) continue;
    // If the transcript is still on disk, the regular walker will handle it.
    if (typeof e.fullPath === 'string' && (await checkExists(e.fullPath))) continue;

    const startedAt =
      typeof e.created === 'string' ? Date.parse(e.created) : Number.NaN;
    const updatedAt =
      typeof e.modified === 'string' ? Date.parse(e.modified) : Number.NaN;
    if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt)) continue;

    const firstPrompt = typeof e.firstPrompt === 'string' ? e.firstPrompt : '';
    const title =
      firstPrompt.length > 0 ? truncate(firstPrompt, 80) : UNTITLED_SESSION;
    const titleSource: 'first-prompt' | 'fallback' =
      firstPrompt.length > 0 ? 'first-prompt' : 'fallback';

    const cwd = typeof e.projectPath === 'string' ? e.projectPath : undefined;
    const project =
      cwd !== undefined ? path.win32.basename(cwd) || undefined : undefined;

    // messageCount is total (user + assistant). Approximate userTurns as the
    // ceiling of half — better than 0 (which would imply "no user activity"
    // and confuse downstream filters) and never more than the truth.
    const userTurns =
      typeof e.messageCount === 'number' && Number.isFinite(e.messageCount)
        ? Math.max(1, Math.ceil(e.messageCount / 2))
        : 0;

    // Mirror firstPrompt into userTextSamples (single sample, ≤400 chars) so
    // discoverNarratives gets clustering input from pruned sessions too.
    const userTextSamples =
      firstPrompt.length > 0 ? [firstPrompt.slice(0, 400)] : [];

    const entry: UnifiedSessionEntry = {
      id: e.sessionId,
      source: sourceTag,
      rawSessionId: e.sessionId,
      startedAt,
      updatedAt,
      durationMs: Math.max(0, updatedAt - startedAt),
      title,
      titleSource,
      preview: buildPreview(firstPrompt.length > 0 ? firstPrompt : null),
      userTurns,
      model: null,
      cwdKind,
      totalCostUsd: null,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(project !== undefined && project.length > 0 ? { project } : {}),
      ...(typeof e.fileMtime === 'number' ? { sourceMtimeMs: e.fileMtime } : {}),
      ...(userTextSamples.length > 0 ? { userTextSamples } : {}),
      transcriptStatus: 'pruned',
      // No transcriptPath / manifestPath / tokenTotals / topTools /
      // subagentRollup — those would require a transcript that's gone.
    };
    out.push(entry);
  }
  return out;
}

/**
 * Convenience: walk every `<projectsRoot>/<projectDir>/sessions-index.json`
 * and collect all pruned entries in one go. Caller passes the projects
 * root (e.g. `~/.claude/projects`); we discover index files at depth-1.
 *
 * Returns `[]` when no project dirs exist or none carry an index file
 * (the index is a relatively recent Anthropic addition; older project
 * dirs simply don't have one).
 */
export async function collectPrunedEntries(
  projectsRoot: string,
  cwdKind: 'host',
  sourceTag: 'cli-direct',
  readdirFn: (p: string) => Promise<readonly string[]>,
): Promise<readonly UnifiedSessionEntry[]> {
  let projectDirs: readonly string[];
  try {
    projectDirs = await readdirFn(projectsRoot);
  } catch {
    return [];
  }
  const all: UnifiedSessionEntry[] = [];
  for (const d of projectDirs) {
    const indexPath = path.join(projectsRoot, d, 'sessions-index.json');
    const entries = await readPrunedFromSessionsIndex(indexPath, cwdKind, sourceTag);
    all.push(...entries);
  }
  return all;
}
