import { readdir, readFile, stat, mkdir, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TokenTotals, UnifiedSessionEntry } from '@chat-arch/schema';
import { UNTITLED_SESSION } from '@chat-arch/schema';
import { readJsonlLines } from '../lib/jsonl.js';
import { runWithConcurrency } from '../lib/concurrency.js';
import { buildPreview } from '../lib/preview.js';
import { toPosixRelative } from '../lib/paths.js';
import { logger } from '../lib/logger.js';
import { countToolUsesInMessage } from '../lib/toolUses.js';

/**
 * `<uuid>.jsonl` at the TOP LEVEL of a project dir. Sub-agent transcripts
 * under `<uuid>/` (a directory sibling) are intentionally OUT OF SCOPE —
 * D1 of the Phase 3 plan. They're inner-child retries from the primary
 * transcript and add no new signal for the viewer.
 */
const UUID_JSONL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

const CONCURRENCY = 8;
const TITLE_FALLBACK_MAX_CHARS = 80;

/** Line types that appear routinely and need no drift warning. */
const KNOWN_LINE_TYPES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'attachment',
  'progress',
  'file-history-snapshot',
  'queue-operation',
  'last-prompt',
  'ai-title',
]);

export interface RunCliExportOptions {
  outDir: string;
  /** Defaults to `os.homedir() + /.claude/projects`. */
  projectsRoot?: string;
  /** Defaults to `<outDir>/cowork-sessions.json` (Phase 2's output). */
  phase2CoworkJsonPath?: string;
}

export interface CliExportResult {
  entries: UnifiedSessionEntry[];
  counts: { 'cli-direct': number; 'cli-desktop': number };
  transcriptsCopied: number;
  transcriptsSkipped: number;
  malformedLinesTotal: number;
  /**
   * Number of entries reused verbatim from the previous cli-sessions.json
   * (source mtime hadn't changed). Reported in the exporter summary so
   * the user can see how much work the incremental-rescan path saved.
   */
  reuseCounts: { 'cli-direct': number; 'cli-desktop': number };
}

/** Per-transcript accumulator produced by a single streaming pass. */
interface TranscriptAggregate {
  /** Count of `type === 'user'` lines. */
  userTurns: number;
  /** Count of `type === 'assistant'` lines. */
  assistantTurns: number;
  /** First `typeof line.cwd === 'string'` seen — D2. */
  cwd: string | undefined;
  /** `aiTitle` from the first non-empty `type === 'ai-title'` line. */
  aiTitle: string | undefined;
  /** `lastPrompt` from the last non-empty `type === 'last-prompt'` line. */
  lastPrompt: string | undefined;
  /** First user-message text, via {@link extractFirstUserText}. */
  firstUserText: string | undefined;
  /** Last assistant line's `message.model`. */
  lastAssistantModel: string | undefined;
  /** Distinct assistant models in insertion order — OQ3. */
  modelsUsed: string[];
  /** Summed assistant usage counters — D8. */
  tokens: TokenTotals;
  /** Min `timestamp` (ms-epoch) across event lines with parseable `timestamp`. */
  minTimestamp: number | undefined;
  /** Max `timestamp` (ms-epoch) across event lines. */
  maxTimestamp: number | undefined;
  /** Count of lines that failed JSON.parse. */
  malformedLineCount: number;
  /**
   * Tool-use histogram, keyed by tool name (e.g. `Bash`, `Edit`, `Read`).
   * Populated by scanning `tool_use` content blocks on every assistant
   * line. The same pass that counts user/assistant turns also counts
   * tools — no extra read. See `lib/toolUses.ts`.
   */
  toolUses: Record<string, number>;
}

function zeroAggregate(): TranscriptAggregate {
  return {
    userTurns: 0,
    assistantTurns: 0,
    cwd: undefined,
    aiTitle: undefined,
    lastPrompt: undefined,
    firstUserText: undefined,
    lastAssistantModel: undefined,
    modelsUsed: [],
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    minTimestamp: undefined,
    maxTimestamp: undefined,
    malformedLineCount: 0,
    toolUses: {},
  };
}

/**
 * Load the previous cli-sessions.json (if present) and index by
 * `${source}:${id}`. Used by the incremental-rescan path to reuse
 * entries whose source transcript hasn't changed since the last run.
 *
 * Missing / unreadable / malformed file is NOT fatal — we just skip
 * reuse and rebuild everything, which is the previous behavior.
 */
async function loadPreviousCliEntries(outDir: string): Promise<Map<string, UnifiedSessionEntry>> {
  const map = new Map<string, UnifiedSessionEntry>();
  const p = path.join(outDir, 'cli-sessions.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return map;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!Array.isArray(parsed)) return map;
  for (const e of parsed as UnifiedSessionEntry[]) {
    if (e && typeof e.id === 'string' && typeof e.source === 'string') {
      map.set(`${e.source}:${e.id}`, e);
    }
  }
  return map;
}

/**
 * Top-level entry: walk `<projectsRoot>`, stream every transcript, emit one
 * UnifiedSessionEntry per transcript, write `<outDir>/cli-sessions.json`,
 * and copy each transcript into `local-transcripts/cli-{direct,desktop}/`.
 *
 * Incremental: if a prior cli-sessions.json exists and an entry's
 * `sourceMtimeMs` matches the current transcript file's mtime, the entry
 * is reused verbatim and the file is neither streamed nor recopied.
 * A full rescan drops from O(transcripts × file-size) to O(transcripts)
 * stat calls when nothing has changed.
 */
export async function runCliExport(opts: RunCliExportOptions): Promise<CliExportResult> {
  const projectsRoot = opts.projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
  const outDir = opts.outDir;
  const phase2Path = opts.phase2CoworkJsonPath ?? path.join(outDir, 'cowork-sessions.json');

  // Ensure copy targets exist.
  await mkdir(path.join(outDir, 'local-transcripts', 'cli-direct'), {
    recursive: true,
  });
  await mkdir(path.join(outDir, 'local-transcripts', 'cli-desktop'), {
    recursive: true,
  });

  const transcriptPaths = await findTranscriptPaths(projectsRoot);
  const { desktopIds, phase2Entries } = await loadCliDesktopIds(phase2Path);
  const prevEntries = await loadPreviousCliEntries(outDir);

  const entries: UnifiedSessionEntry[] = [];
  let transcriptsCopied = 0;
  let transcriptsSkipped = 0;
  let malformedLinesTotal = 0;
  let directCount = 0;
  let desktopCount = 0;
  let directReused = 0;
  let desktopReused = 0;

  await runWithConcurrency(transcriptPaths, CONCURRENCY, async (transcriptPath) => {
    const base = path.win32.basename(transcriptPath); // D15 / plan rule
    // Filename -> UUID. Walker already filtered non-UUID names.
    const uuid = base.replace(/\.jsonl$/i, '');

    // Stat first — cheap. Used both for reuse eligibility and for
    // the fallback timestamp when the transcript has no dated lines.
    let fileMtime: number;
    try {
      const st = await stat(transcriptPath);
      fileMtime = st.mtimeMs;
    } catch {
      fileMtime = Date.now();
    }

    const isDesktop = desktopIds.has(uuid);
    const source = isDesktop ? 'cli-desktop' : 'cli-direct';
    const prev = prevEntries.get(`${source}:${uuid}`);

    const copySubdir = isDesktop ? 'cli-desktop' : 'cli-direct';
    const destRel = path.join('local-transcripts', copySubdir, `${uuid}.jsonl`);
    const destAbs = path.join(outDir, destRel);

    // Fast path: previous entry exists and its cached source mtime
    // matches the current file mtime — nothing changed. Reuse the
    // entry verbatim. Still ensure the copied transcript exists (it
    // lives in outDir and the user may have wiped it); if dest is
    // already up-to-date, skip the copy too.
    if (
      prev !== undefined &&
      typeof prev.sourceMtimeMs === 'number' &&
      prev.sourceMtimeMs === fileMtime
    ) {
      let destUpToDate = false;
      try {
        const destSt = await stat(destAbs);
        destUpToDate = destSt.mtimeMs >= fileMtime;
      } catch {
        destUpToDate = false;
      }
      if (!destUpToDate) {
        try {
          await copyFile(transcriptPath, destAbs);
          transcriptsCopied += 1;
        } catch (err) {
          logger.warn(
            `could not copy transcript ${transcriptPath} -> ${destAbs}: ${(err as Error).message}`,
          );
        }
      }
      entries.push(prev);
      if (isDesktop) {
        desktopCount += 1;
        desktopReused += 1;
      } else {
        directCount += 1;
        directReused += 1;
      }
      return;
    }

    // Slow path: file changed (or no prior entry) — do the full
    // stream-aggregate + entry-build.
    let agg: TranscriptAggregate;
    try {
      agg = await streamAggregate(transcriptPath);
    } catch (err) {
      logger.warn(
        `failed to stream transcript ${transcriptPath}: ${(err as Error).message}; skipping`,
      );
      transcriptsSkipped += 1;
      return;
    }

    malformedLinesTotal += agg.malformedLineCount;

    let transcriptRel: string | undefined;
    try {
      await copyFile(transcriptPath, destAbs);
      transcriptRel = toPosixRelative(destAbs, outDir);
      transcriptsCopied += 1;
    } catch (err) {
      logger.warn(
        `could not copy transcript ${transcriptPath} -> ${destAbs}: ${(err as Error).message}`,
      );
    }

    if (isDesktop) {
      const phase2Entry = phase2Entries.get(uuid);
      if (phase2Entry) {
        entries.push(enrichCliDesktopEntry(phase2Entry, agg, transcriptRel, fileMtime));
        desktopCount += 1;
      } else {
        // UUID was reported by Phase 2 but the entry has vanished — should be
        // impossible since we read from the same file, but fall back to direct.
        entries.push(buildCliDirectEntry(agg, uuid, transcriptRel, fileMtime));
        directCount += 1;
      }
    } else {
      entries.push(buildCliDirectEntry(agg, uuid, transcriptRel, fileMtime));
      directCount += 1;
    }
  });

  // Stable order: updatedAt desc. Matches Phase 2 convention.
  entries.sort((a, b) => b.updatedAt - a.updatedAt);

  const outFile = path.join(outDir, 'cli-sessions.json');
  await writeFile(outFile, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  return {
    entries,
    counts: {
      'cli-direct': directCount,
      'cli-desktop': desktopCount,
    },
    transcriptsCopied,
    transcriptsSkipped,
    malformedLinesTotal,
    reuseCounts: {
      'cli-direct': directReused,
      'cli-desktop': desktopReused,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests.
// ---------------------------------------------------------------------------

/**
 * Walk `<root>/<projectDir>/*.jsonl` at maxdepth 1 — D1. Skips:
 *  - non-directory entries at root,
 *  - files whose name is not `<uuid>.jsonl`,
 *  - sub-agent transcripts under `<projectDir>/<uuid>/...`.
 *
 * Returns absolute paths. Never throws on a missing root; returns [].
 */
export async function findTranscriptPaths(root: string): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    logger.warn(`CLI projects root not found at ${root}; Phase 3 will emit zero CLI entries`);
    return [];
  }

  const results: string[] = [];
  for (const projectDir of projectDirs) {
    const projectAbs = path.join(root, projectDir);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(projectAbs);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let entries: string[];
    try {
      entries = await readdir(projectAbs);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!UUID_JSONL_RE.test(name)) continue;
      results.push(path.join(projectAbs, name));
    }
  }
  return results;
}

/**
 * Parse `<outDir>/cowork-sessions.json` and return the set of cli-desktop UUIDs
 * plus a lookup map for enrichment. Missing / unreadable / malformed file is
 * NOT fatal — Phase 3 still runs (every transcript becomes cli-direct) and a
 * warning is emitted.
 */
export async function loadCliDesktopIds(phase2CoworkJsonPath: string): Promise<{
  desktopIds: Set<string>;
  phase2Entries: Map<string, UnifiedSessionEntry>;
}> {
  const desktopIds = new Set<string>();
  const phase2Entries = new Map<string, UnifiedSessionEntry>();
  let raw: string;
  try {
    raw = await readFile(phase2CoworkJsonPath, 'utf8');
  } catch {
    logger.warn(
      `Phase 2 output ${phase2CoworkJsonPath} not found; all CLI transcripts will be classified as cli-direct`,
    );
    return { desktopIds, phase2Entries };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `Phase 2 output ${phase2CoworkJsonPath} is not valid JSON (${(err as Error).message}); all CLI transcripts will be classified as cli-direct`,
    );
    return { desktopIds, phase2Entries };
  }
  if (!Array.isArray(parsed)) {
    logger.warn(`Phase 2 output ${phase2CoworkJsonPath} is not an array; ignoring`);
    return { desktopIds, phase2Entries };
  }
  for (const e of parsed as UnifiedSessionEntry[]) {
    if (e && e.source === 'cli-desktop' && typeof e.id === 'string') {
      desktopIds.add(e.id);
      phase2Entries.set(e.id, e);
    }
  }
  return { desktopIds, phase2Entries };
}

/**
 * D9 — extract first-user-text from a CLI user-line `message`.
 *   string          -> direct
 *   array of blocks -> first block with type !== 'tool_result' and
 *                      a non-empty `text` string.
 * Returns `undefined` when nothing usable is present.
 */
export function extractFirstUserText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content.length > 0 ? content : undefined;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'tool_result') continue;
      if (typeof b.text === 'string' && b.text.length > 0) return b.text;
    }
  }
  return undefined;
}

/**
 * One streaming pass over a transcript. Constant memory regardless of file size.
 * Malformed lines are counted and warnOnce'd per-file.
 */
export async function streamAggregate(transcriptPath: string): Promise<TranscriptAggregate> {
  const agg = zeroAggregate();
  const modelsSeen = new Set<string>();

  for await (const y of readJsonlLines<Record<string, unknown>>(transcriptPath)) {
    if (y.kind === 'error') {
      agg.malformedLineCount += 1;
      logger.warnOnce(
        `cli-transcript-malformed:${transcriptPath}`,
        `CLI transcript ${transcriptPath} has malformed line(s); skipping. First error line ${y.lineNumber}: ${y.error.message}`,
      );
      continue;
    }

    const line = y.line;

    // cwd: first string wins. D2/D3.
    if (agg.cwd === undefined && typeof line['cwd'] === 'string') {
      agg.cwd = line['cwd'] as string;
    }

    // Timestamp min/max — D10.
    const ts = line['timestamp'];
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms)) {
        if (agg.minTimestamp === undefined || ms < agg.minTimestamp) {
          agg.minTimestamp = ms;
        }
        if (agg.maxTimestamp === undefined || ms > agg.maxTimestamp) {
          agg.maxTimestamp = ms;
        }
      }
    }

    const type = line['type'];
    if (type === 'user') {
      agg.userTurns += 1;
      if (agg.firstUserText === undefined) {
        const t = extractFirstUserText(line['message']);
        if (t !== undefined) agg.firstUserText = t;
      }
    } else if (type === 'assistant') {
      agg.assistantTurns += 1;
      // Tool-use histogram — scan this message's content blocks for
      // `tool_use` entries and tally by name. Mirrors cloud-mapping's
      // approach (via the shared helper) so both sources produce the
      // same `topTools` shape.
      countToolUsesInMessage(line['message'], agg.toolUses);
      const msg = line['message'] as
        | {
            model?: unknown;
            usage?: {
              input_tokens?: unknown;
              output_tokens?: unknown;
              cache_creation_input_tokens?: unknown;
              cache_read_input_tokens?: unknown;
            };
          }
        | undefined;
      if (msg && typeof msg.model === 'string' && msg.model.length > 0) {
        agg.lastAssistantModel = msg.model;
        if (!modelsSeen.has(msg.model)) {
          modelsSeen.add(msg.model);
          agg.modelsUsed.push(msg.model);
        }
      }
      if (msg && msg.usage) {
        const u = msg.usage;
        if (typeof u.input_tokens === 'number' && Number.isFinite(u.input_tokens)) {
          agg.tokens.input += u.input_tokens;
        }
        if (typeof u.output_tokens === 'number' && Number.isFinite(u.output_tokens)) {
          agg.tokens.output += u.output_tokens;
        }
        if (
          typeof u.cache_creation_input_tokens === 'number' &&
          Number.isFinite(u.cache_creation_input_tokens)
        ) {
          agg.tokens.cacheCreation += u.cache_creation_input_tokens;
        }
        if (
          typeof u.cache_read_input_tokens === 'number' &&
          Number.isFinite(u.cache_read_input_tokens)
        ) {
          agg.tokens.cacheRead += u.cache_read_input_tokens;
        }
      }
    } else if (type === 'ai-title') {
      const v = line['aiTitle'];
      if (typeof v === 'string' && v.length > 0) agg.aiTitle = v;
    } else if (type === 'last-prompt') {
      const v = line['lastPrompt'];
      if (typeof v === 'string' && v.length > 0) agg.lastPrompt = v;
    } else if (typeof type === 'string') {
      if (!KNOWN_LINE_TYPES.has(type)) {
        logger.warnOnce(
          `cli-unknown-line-type:${type}`,
          `CLI transcript contains unknown line type "${type}" (first seen in ${transcriptPath}); ignoring`,
        );
      }
    }
    // Lines with no `type` field at all: silently ignored.
  }

  return agg;
}

/** Title cascade — D4. Empty strings are treated as absent. */
function resolveTitle(agg: TranscriptAggregate): {
  title: string;
  titleSource: 'ai-title' | 'first-prompt' | 'fallback';
} {
  if (agg.aiTitle !== undefined && agg.aiTitle.length > 0) {
    return { title: agg.aiTitle, titleSource: 'ai-title' };
  }
  if (agg.lastPrompt !== undefined && agg.lastPrompt.length > 0) {
    return {
      title: truncate(agg.lastPrompt, TITLE_FALLBACK_MAX_CHARS),
      titleSource: 'first-prompt',
    };
  }
  if (agg.firstUserText !== undefined && agg.firstUserText.length > 0) {
    return {
      title: truncate(agg.firstUserText, TITLE_FALLBACK_MAX_CHARS),
      titleSource: 'first-prompt',
    };
  }
  return { title: UNTITLED_SESSION, titleSource: 'fallback' };
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max);
}

/** Build a cli-direct entry from a streamed aggregate. */
export function buildCliDirectEntry(
  agg: TranscriptAggregate,
  uuid: string,
  transcriptRel: string | undefined,
  fileMtimeMs: number,
): UnifiedSessionEntry {
  const { title, titleSource } = resolveTitle(agg);

  const startedAt = agg.minTimestamp ?? fileMtimeMs;
  const updatedAt = agg.maxTimestamp ?? fileMtimeMs;
  const durationMs = Math.max(0, updatedAt - startedAt);

  const cwd = agg.cwd;
  const project = cwd !== undefined ? path.win32.basename(cwd) || undefined : undefined;

  const tokensHasAny =
    agg.tokens.input > 0 ||
    agg.tokens.output > 0 ||
    agg.tokens.cacheCreation > 0 ||
    agg.tokens.cacheRead > 0;

  const entry: UnifiedSessionEntry = {
    // REQUIRED
    id: uuid,
    source: 'cli-direct',
    rawSessionId: uuid, // D: CLI-direct rawSessionId = UUID (no local_ prefix)
    startedAt,
    updatedAt,
    durationMs,
    title,
    titleSource,
    preview: buildPreview(agg.firstUserText ?? null),
    userTurns: agg.userTurns,
    model: agg.lastAssistantModel ?? null,
    cwdKind: 'host',
    totalCostUsd: null, // D16 / CONTRADICTIONS C4

    // OPTIONAL (conditional spread — EOP discipline, R8)
    ...(agg.assistantTurns > 0 ? { assistantTurns: agg.assistantTurns } : {}),
    ...(agg.modelsUsed.length > 0 ? { modelsUsed: agg.modelsUsed } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(project !== undefined && project.length > 0 ? { project } : {}),
    ...(tokensHasAny ? { tokenTotals: agg.tokens } : {}),
    ...(Object.keys(agg.toolUses).length > 0 ? { topTools: agg.toolUses } : {}),
    // Cached source-file mtime: drives incremental rescan. Equal to
    // `fileMtimeMs` here because this entry was built from the file
    // whose mtime we just read; the reuse check compares this cached
    // value to the current stat on the next rescan.
    sourceMtimeMs: fileMtimeMs,
    ...(transcriptRel !== undefined ? { transcriptPath: transcriptRel } : {}),
  };
  return entry;
}

/**
 * Build an enriched `cli-desktop` entry by overlaying transcript-derived fields
 * on top of Phase 2's manifest entry. See plan §Module design for the explicit
 * field split.
 *
 * Kept from Phase 2: `id`, `rawSessionId` (local_-prefixed), `title`,
 *   `titleSource: 'manifest'`, `manifestPath`, `cwdKind`.
 * Overwritten by Phase 3: `startedAt/updatedAt/durationMs` (OQ4), `userTurns`,
 *   `assistantTurns`, `model` (transcript authoritative), `modelsUsed`,
 *   `tokenTotals`, `project` (derived from transcript cwd), `preview` (OQ1),
 *   `transcriptPath`.
 * `cwd` is preserved from the manifest — manifest and transcript agree in
 *   practice, and the manifest is canonical for Desktop-CLI.
 */
export function enrichCliDesktopEntry(
  phase2Entry: UnifiedSessionEntry,
  agg: TranscriptAggregate,
  transcriptRel: string | undefined,
  fileMtimeMs: number,
): UnifiedSessionEntry {
  const startedAt = agg.minTimestamp ?? phase2Entry.startedAt ?? fileMtimeMs;
  const updatedAt = agg.maxTimestamp ?? phase2Entry.updatedAt ?? fileMtimeMs;
  const durationMs = Math.max(0, updatedAt - startedAt);

  // Project derived from transcript cwd if present, else from phase2 cwd.
  const cwd = phase2Entry.cwd ?? agg.cwd;
  const project = cwd !== undefined ? path.win32.basename(cwd) || undefined : undefined;

  const tokensHasAny =
    agg.tokens.input > 0 ||
    agg.tokens.output > 0 ||
    agg.tokens.cacheCreation > 0 ||
    agg.tokens.cacheRead > 0;

  const entry: UnifiedSessionEntry = {
    // REQUIRED — kept from Phase 2 except temporal/userTurns.
    id: phase2Entry.id,
    source: 'cli-desktop',
    rawSessionId: phase2Entry.rawSessionId, // keeps `local_<uuid>`
    startedAt,
    updatedAt,
    durationMs,
    title: phase2Entry.title, // manifest wins
    titleSource: 'manifest', // stays — manifest is canonical for Desktop-CLI
    preview: buildPreview(agg.firstUserText ?? null), // OQ1 — overwrite
    userTurns: agg.userTurns,
    model: agg.lastAssistantModel ?? phase2Entry.model, // transcript authoritative
    cwdKind: phase2Entry.cwdKind,
    totalCostUsd: phase2Entry.totalCostUsd, // still null for Desktop-CLI

    // OPTIONAL
    ...(agg.assistantTurns > 0 ? { assistantTurns: agg.assistantTurns } : {}),
    ...(agg.modelsUsed.length > 0 ? { modelsUsed: agg.modelsUsed } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(project !== undefined && project.length > 0 ? { project } : {}),
    ...(tokensHasAny ? { tokenTotals: agg.tokens } : {}),
    ...(Object.keys(agg.toolUses).length > 0 ? { topTools: agg.toolUses } : {}),
    // Cached transcript mtime — drives incremental rescan (see
    // `runCliExport`'s fast-path guard).
    sourceMtimeMs: fileMtimeMs,
    ...(phase2Entry.manifestPath !== undefined ? { manifestPath: phase2Entry.manifestPath } : {}),
    ...(transcriptRel !== undefined ? { transcriptPath: transcriptRel } : {}),
  };

  return entry;
}

// Re-exports for test ergonomics.
export type { TranscriptAggregate };
