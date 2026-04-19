import { readdir, readFile, stat, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CoworkManifestKnown,
  CoworkManifestRaw,
  DesktopCliManifestKnown,
  DesktopCliManifestRaw,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { UNTITLED_SESSION } from '@chat-arch/schema';
import { resolveAppDataClaudeRoot } from '../lib/appdata.js';
import { aggregateAudit } from '../lib/audit.js';
import { runWithConcurrency } from '../lib/concurrency.js';
import { buildPreview } from '../lib/preview.js';
import { toPosixRelative } from '../lib/paths.js';
import { logger } from '../lib/logger.js';
import { streamToolUses } from '../lib/toolUses.js';
import { processDesktopCliManifest } from './desktop-cli.js';

/**
 * Load the previous cowork-sessions.json (if present) and index by
 * `${source}:${id}`. Used by the incremental-rescan fast path in
 * both the cowork and cli-desktop pipelines. Missing / unreadable
 * / malformed files fall through to full rebuild.
 */
async function loadPreviousCoworkEntries(
  outDir: string,
): Promise<Map<string, UnifiedSessionEntry>> {
  const map = new Map<string, UnifiedSessionEntry>();
  const p = path.join(outDir, 'cowork-sessions.json');
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COWORK_MANIFEST_RE = /^local_[0-9a-f-]{36}\.json$/i;
const CONCURRENCY = 8;

const COWORK_KNOWN_KEYS = new Set<string>([
  'sessionId',
  'processName',
  'cliSessionId',
  'cwd',
  'userSelectedFolders',
  'createdAt',
  'lastActivityAt',
  'model',
  'isArchived',
  'title',
  'vmProcessName',
  'initialMessage',
  'slashCommands',
  'enabledMcpTools',
  'remoteMcpServersConfig',
  'egressAllowedDomains',
  'systemPrompt',
  'accountName',
  'emailAddress',
  'userApprovedFileAccessPaths',
  'mcqAnswers',
  'hostLoopMode',
  'orgCliExecPolicies',
  'memoryEnabled',
  'scheduledTaskId',
  'sessionType',
  'error',
]);

export interface RunCoworkExportOptions {
  outDir: string;
  /** Override for tests. Defaults to `%APPDATA%\Claude`. */
  appDataClaudeRoot?: string;
}

export interface CoworkExportResult {
  entries: UnifiedSessionEntry[];
  counts: { cowork: number; 'cli-desktop': number };
  sessionsSkipped: number;
  transcriptsCopied: number;
  transcriptsMissing: number;
  /**
   * Entries reused verbatim from the previous cowork-sessions.json
   * (source mtime matched). Reported in the exporter summary so the
   * user can see how much work incremental rescan saved.
   */
  reuseCounts: { cowork: number; 'cli-desktop': number };
}

/**
 * Top-level entry: walk the Cowork + Desktop-CLI AppData trees, produce a
 * unified entry list, copy manifests/transcripts into `outDir`, and write
 * `<outDir>/cowork-sessions.json`.
 */
export async function runCoworkExport(opts: RunCoworkExportOptions): Promise<CoworkExportResult> {
  const appDataRoot = opts.appDataClaudeRoot ?? resolveAppDataClaudeRoot();
  const outDir = opts.outDir;

  // Make sure output subdirs exist.
  await mkdir(path.join(outDir, 'manifests', 'cowork'), { recursive: true });
  await mkdir(path.join(outDir, 'manifests', 'cli-desktop'), { recursive: true });
  await mkdir(path.join(outDir, 'local-transcripts', 'cowork'), { recursive: true });

  const coworkRoot = path.join(appDataRoot, 'local-agent-mode-sessions');
  const cliRoot = path.join(appDataRoot, 'claude-code-sessions');

  const coworkManifestPaths = await findManifestPaths(coworkRoot);
  const cliManifestPaths = await findManifestPaths(cliRoot);
  const prevEntries = await loadPreviousCoworkEntries(outDir);

  let sessionsSkipped = 0;
  let transcriptsCopied = 0;
  let transcriptsMissing = 0;
  let coworkReused = 0;
  let cliDesktopReused = 0;

  const coworkEntries: UnifiedSessionEntry[] = [];
  await runWithConcurrency(coworkManifestPaths, CONCURRENCY, async (manifestPath) => {
    const res = await processCoworkManifest(manifestPath, outDir, prevEntries);
    if (res === null) {
      sessionsSkipped += 1;
      return;
    }
    if (res.reused) coworkReused += 1;
    if (res.transcriptCopied) transcriptsCopied += 1;
    else transcriptsMissing += 1;
    coworkEntries.push(res.entry);
  });

  const cliEntries: UnifiedSessionEntry[] = [];
  let desktopCliZeroTurns = 0;
  await runWithConcurrency(cliManifestPaths, CONCURRENCY, async (manifestPath) => {
    const res = await processDesktopCliManifest(manifestPath, outDir, prevEntries);
    if (res === null) {
      sessionsSkipped += 1;
      return;
    }
    const { entry, reused } = res;
    if (reused) cliDesktopReused += 1;
    if (entry.userTurns === 0) desktopCliZeroTurns += 1;
    cliEntries.push(entry);
  });

  if (desktopCliZeroTurns > 0) {
    logger.warn(
      `${desktopCliZeroTurns} Desktop-CLI sessions have userTurns=0 until Phase 3 transcript walk enriches them.`,
    );
  }

  // Sort entries deterministically by updatedAt desc for downstream stability.
  const entries = [...coworkEntries, ...cliEntries].sort((a, b) => b.updatedAt - a.updatedAt);

  const outFile = path.join(outDir, 'cowork-sessions.json');
  await writeFile(outFile, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  return {
    entries,
    counts: {
      cowork: coworkEntries.length,
      'cli-desktop': cliEntries.length,
    },
    sessionsSkipped,
    transcriptsCopied,
    transcriptsMissing,
    reuseCounts: {
      cowork: coworkReused,
      'cli-desktop': cliDesktopReused,
    },
  };
}

/** Walk `<root>/<userUuid>/<installUuid>/local_<uuid>.json` pairs. */
async function findManifestPaths(root: string): Promise<string[]> {
  const results: string[] = [];
  let userDirs: string[];
  try {
    userDirs = await readdir(root);
  } catch {
    // Root missing entirely — no sessions of this type on disk. Not an error.
    return results;
  }

  for (const userEntry of userDirs) {
    if (!UUID_RE.test(userEntry)) continue; // skip 'skills-plugin' etc.
    const userPath = path.join(root, userEntry);
    let installDirs: string[];
    try {
      installDirs = await readdir(userPath);
    } catch {
      continue;
    }
    for (const installEntry of installDirs) {
      if (!UUID_RE.test(installEntry)) continue;
      const installPath = path.join(userPath, installEntry);
      let files: string[];
      try {
        files = await readdir(installPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (COWORK_MANIFEST_RE.test(f)) {
          results.push(path.join(installPath, f));
        }
      }
    }
  }
  return results;
}

interface ProcessCoworkResult {
  entry: UnifiedSessionEntry;
  transcriptCopied: boolean;
  /** True when the entry was reused verbatim from the previous run's cache. */
  reused: boolean;
}

async function processCoworkManifest(
  manifestPath: string,
  outDir: string,
  prevEntries: Map<string, UnifiedSessionEntry>,
): Promise<ProcessCoworkResult | null> {
  // Stat before read — the mtime is our incremental-rescan cache key.
  // Cowork's manifest is re-serialised whenever the session is active
  // (lastActivityAt updates in lock-step with the audit + transcript),
  // so file mtime is a reliable staleness signal.
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
    logger.warn(`could not read Cowork manifest ${manifestPath}: ${(err as Error).message}`);
    return null;
  }

  let parsed: CoworkManifestRaw;
  try {
    parsed = JSON.parse(raw) as CoworkManifestRaw;
  } catch (err) {
    logger.warn(
      `Cowork manifest ${manifestPath} is not valid JSON: ${(err as Error).message}; skipping`,
    );
    return null;
  }

  // Validate minimum required fields.
  if (!isMinimallyValidCowork(parsed)) {
    logger.warn(`Cowork manifest ${manifestPath} missing required minimum fields; skipping`);
    return null;
  }

  const manifest = parsed;
  const cliSessionIdResolved = manifest.cliSessionId ?? stripLocalPrefix(manifest.sessionId);

  // Fast path: manifest mtime matches what we cached last run →
  // nothing changed since the last rescan. Reuse the entry verbatim.
  // Skips: drift warnings (already seen), audit.jsonl aggregation
  // (biggest cost), transcript copy (unless outDir was wiped), and
  // tool-use mining.
  const prev = prevEntries.get(`cowork:${cliSessionIdResolved}`);
  if (
    prev !== undefined &&
    typeof prev.sourceMtimeMs === 'number' &&
    prev.sourceMtimeMs === currentMtime &&
    currentMtime > 0
  ) {
    // Still want the transcript on disk if the user wiped outDir; skip
    // the copy when an up-to-date one is already there.
    let transcriptCopiedNow = false;
    if (typeof prev.transcriptPath === 'string') {
      const destAbs = path.join(outDir, prev.transcriptPath);
      const destExistsAndFresh = await fileExists(destAbs);
      if (!destExistsAndFresh && manifest.cliSessionId) {
        // Locate the source transcript and copy it over. Same lookup
        // as the slow path below but localised here to avoid re-
        // running the rest of the pipeline.
        const candidates: string[] = [];
        if (manifest.processName) candidates.push(manifest.processName);
        if (manifest.vmProcessName && manifest.vmProcessName !== manifest.processName) {
          candidates.push(manifest.vmProcessName);
        }
        const sessionDir = manifestPath.replace(/\.json$/, '');
        for (const procName of candidates) {
          const src = path.join(
            sessionDir,
            '.claude',
            'projects',
            `-sessions-${procName}`,
            `${manifest.cliSessionId}.jsonl`,
          );
          if (await fileExists(src)) {
            try {
              await copyFile(src, destAbs);
              transcriptCopiedNow = true;
            } catch {
              // Fall through — the entry stays, the user re-rescans.
            }
            break;
          }
        }
      } else if (destExistsAndFresh) {
        transcriptCopiedNow = true;
      }
    }
    return { entry: prev, transcriptCopied: transcriptCopiedNow, reused: true };
  }

  // Drift detection — warnOnce per unknown key.
  for (const k of Object.keys(parsed)) {
    if (!COWORK_KNOWN_KEYS.has(k)) {
      logger.warnOnce(
        `cowork-drift-key:${k}`,
        `Cowork manifest contains unknown key "${k}" (first seen in ${manifestPath}); entry emitted anyway`,
      );
    }
  }

  const sessionDir = manifestPath.replace(/\.json$/, '');
  const cliSessionId = cliSessionIdResolved;

  // Audit aggregate (may be zeroed if file absent).
  const auditFilePath = path.join(sessionDir, 'audit.jsonl');
  const audit = (await fileExists(auditFilePath))
    ? await aggregateAudit(auditFilePath)
    : {
        userTurns: 0,
        assistantTurns: 0,
        resultLineCount: 0,
        malformedLineCount: 0,
        durationMs: undefined,
        durationApiMs: undefined,
        numTurns: undefined,
        totalCostUsd: undefined,
        modelUsage: undefined,
        lastResultModel: undefined,
      };

  // Copy manifest (Q1 — always) to manifests/cowork/<rawSessionId>.json (R3).
  const manifestOutRel = path.join('manifests', 'cowork', `${manifest.sessionId}.json`);
  const manifestOutAbs = path.join(outDir, manifestOutRel);
  try {
    await copyFile(manifestPath, manifestOutAbs);
  } catch (err) {
    logger.warn(`could not copy Cowork manifest to ${manifestOutAbs}: ${(err as Error).message}`);
  }

  // Copy transcript — R10 fallback: try processName, then vmProcessName.
  let transcriptCopied = false;
  let transcriptOutRel: string | undefined;
  let transcriptAbsTarget: string | undefined;
  const processNameCandidates: string[] = [];
  if (manifest.processName) processNameCandidates.push(manifest.processName);
  if (manifest.vmProcessName && manifest.vmProcessName !== manifest.processName) {
    processNameCandidates.push(manifest.vmProcessName);
  }

  if (manifest.cliSessionId && processNameCandidates.length > 0) {
    for (const procName of processNameCandidates) {
      const candidate = path.join(
        sessionDir,
        '.claude',
        'projects',
        `-sessions-${procName}`,
        `${manifest.cliSessionId}.jsonl`,
      );
      if (await fileExists(candidate)) {
        const relTarget = path.join(
          'local-transcripts',
          'cowork',
          `${manifest.cliSessionId}.jsonl`,
        );
        const absTarget = path.join(outDir, relTarget);
        try {
          await copyFile(candidate, absTarget);
          transcriptCopied = true;
          transcriptOutRel = toPosixRelative(absTarget, outDir);
          transcriptAbsTarget = absTarget;
        } catch (err) {
          logger.warn(`could not copy transcript ${candidate}: ${(err as Error).message}`);
        }
        break;
      }
    }
  }
  if (!transcriptCopied && manifest.cliSessionId) {
    logger.warn(
      `transcript missing for session ${manifest.sessionId} (cliSessionId=${manifest.cliSessionId})`,
    );
  }

  // Tool-use histogram — mined from the copied transcript (same content-
  // block shape as cli-direct / cloud). audit.jsonl does not carry tool
  // names (only `tool_use_summary` lines with ids), so we have to read
  // the transcript. Second pass is cheap on the cowork volume (low-100s
  // of sessions) and keeps the extraction co-located with the other
  // sources via the shared `streamToolUses` helper.
  const toolUses = transcriptAbsTarget ? await streamToolUses(transcriptAbsTarget) : {};
  const hasTools = Object.keys(toolUses).length > 0;

  const modelsUsedArr = audit.modelUsage !== undefined ? Object.keys(audit.modelUsage) : [];
  const modelsUsed: readonly string[] = modelsUsedArr.length > 0 ? modelsUsedArr : [manifest.model];

  // Build entry via R4 conditional-spread template.
  const entry: UnifiedSessionEntry = {
    // REQUIRED
    id: cliSessionId,
    source: 'cowork',
    rawSessionId: manifest.sessionId,
    startedAt: manifest.createdAt,
    updatedAt: manifest.lastActivityAt,
    durationMs: manifest.lastActivityAt - manifest.createdAt, // R2 wall-clock
    title: manifest.title || UNTITLED_SESSION,
    titleSource: 'manifest',
    preview: buildPreview(manifest.initialMessage),
    userTurns: audit.userTurns, // R1 — audit count, never num_turns
    model: audit.lastResultModel ?? manifest.model,
    cwdKind: 'vm',
    totalCostUsd: audit.totalCostUsd ?? null,

    // OPTIONAL (conditional spread)
    // Derived from assistant lines in audit.jsonl — independent of result line
    // presence. Gating on resultLineCount would violate research-authoritative
    // CONTRADICTIONS.md §C5 ("result lines are not guaranteed even in Cowork")
    // and mirror-drop the field for 16/274 real sessions (R4 F4.1).
    ...(audit.assistantTurns > 0 ? { assistantTurns: audit.assistantTurns } : {}),
    ...(modelsUsed.length > 0 ? { modelsUsed } : {}),
    cwd: manifest.cwd,
    ...(hasTools ? { topTools: toolUses } : {}),
    // Cached manifest file mtime — drives the incremental-rescan
    // fast path. Updated every time we (re)process the manifest.
    ...(currentMtime > 0 ? { sourceMtimeMs: currentMtime } : {}),
    ...(transcriptCopied && transcriptOutRel !== undefined
      ? { transcriptPath: toPosixRelative(path.join(outDir, transcriptOutRel), outDir) }
      : {}),
    manifestPath: toPosixRelative(manifestOutAbs, outDir),
    // auditPath: omitted (Q1)
  };

  return { entry, transcriptCopied, reused: false };
}

function isMinimallyValidCowork(
  m: Partial<CoworkManifestKnown> | CoworkManifestRaw,
): m is CoworkManifestKnown {
  return (
    typeof m.sessionId === 'string' &&
    typeof m.createdAt === 'number' &&
    typeof m.lastActivityAt === 'number' &&
    typeof m.title === 'string' &&
    typeof m.cwd === 'string'
  );
}

export function isMinimallyValidDesktopCli(
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

function stripLocalPrefix(sessionId: string): string {
  return sessionId.replace(/^local_/, '');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}
