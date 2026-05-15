import { readdir, readFile, stat, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CoworkManifestKnown,
  CoworkManifestRaw,
  DesktopCliManifestKnown,
  DesktopCliManifestRaw,
  TokenTotals,
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
import {
  aggregateSubagents,
  sumHistograms,
  sumTokens,
  uniqueModels,
} from '../lib/subagents.js';
// Note: `processDesktopCliManifest` (./desktop-cli) is no longer invoked
// from here — both AppData roots are Cowork-shaped per Anthropic's rename
// (anthropics/claude-code#29373, #27463). The Desktop-CLI module stays
// exported from `src/index.ts` for back-compat reads of legacy data only.

/**
 * Pull parent-session TokenTotals from a Cowork audit's `modelUsage` map.
 * Cowork audit lines carry per-model `inputTokens` / `outputTokens` /
 * `cacheCreationInputTokens` / `cacheReadInputTokens` — sum them up so the
 * unified entry exposes a single TokenTotals to consumers (cost estimation,
 * /chat answers).
 *
 * Returns a zero TokenTotals when modelUsage is absent or empty — callers
 * decide whether to drop the field via a conditional spread.
 */
/**
 * Coerce Cowork's `enabledMcpTools` (typed loosely as Record<string, unknown>)
 * to the unified entry's stricter `Record<string, boolean>`. In practice every
 * value observed is a boolean — non-boolean entries are dropped rather than
 * forced. Keeps the unified field's contract clean.
 */
function coerceMcpToolFlags(raw: Readonly<Record<string, unknown>>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function modelUsageToTokens(modelUsage: Record<string, unknown> | undefined): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  if (!modelUsage) return totals;
  for (const v of Object.values(modelUsage)) {
    if (!v || typeof v !== 'object') continue;
    const u = v as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cacheCreationInputTokens?: unknown;
      cacheReadInputTokens?: unknown;
    };
    if (typeof u.inputTokens === 'number' && Number.isFinite(u.inputTokens)) {
      totals.input += u.inputTokens;
    }
    if (typeof u.outputTokens === 'number' && Number.isFinite(u.outputTokens)) {
      totals.output += u.outputTokens;
    }
    if (
      typeof u.cacheCreationInputTokens === 'number' &&
      Number.isFinite(u.cacheCreationInputTokens)
    ) {
      totals.cacheCreation += u.cacheCreationInputTokens;
    }
    if (typeof u.cacheReadInputTokens === 'number' && Number.isFinite(u.cacheReadInputTokens)) {
      totals.cacheRead += u.cacheReadInputTokens;
    }
  }
  return totals;
}

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

  // Both `local-agent-mode-sessions/` and `claude-code-sessions/` are Cowork-
  // shaped per Anthropic's rename (refs anthropics/claude-code#29373, #27463).
  // The Desktop-CLI walker block is gone; the desktop-cli manifest processor
  // is kept for back-compat reads of older entries.
  const coworkRoots = [
    path.join(appDataRoot, 'local-agent-mode-sessions'),
    path.join(appDataRoot, 'claude-code-sessions'),
  ];
  const coworkManifestPaths = (
    await Promise.all(coworkRoots.map(findManifestPaths))
  ).flat();
  const prevEntries = await loadPreviousCoworkEntries(outDir);

  let sessionsSkipped = 0;
  let transcriptsCopied = 0;
  let transcriptsMissing = 0;
  let coworkReused = 0;
  const cliDesktopReused = 0;

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
    // claude-code-sessions/ shape divergence: warn-once when a manifest
    // there matches neither Cowork nor Desktop-CLI. This is the canary
    // for Anthropic shipping yet another shape on top of the rename.
    if (
      manifestPath.includes(`${path.sep}claude-code-sessions${path.sep}`) &&
      !isMinimallyValidDesktopCli(parsed)
    ) {
      logger.warnOnce(
        `claude-code-sessions-unknown-shape:${manifestPath}`,
        `[chat-arch] claude-code-sessions manifest ${manifestPath} matched neither ` +
          `Cowork nor Desktop-CLI schema — Anthropic may have shipped a new shape`,
      );
    } else {
      logger.warn(`Cowork manifest ${manifestPath} missing required minimum fields; skipping`);
    }
    return null;
  }

  const manifest = parsed;
  const cliSessionIdResolved = manifest.cliSessionId ?? stripLocalPrefix(manifest.sessionId);

  // Fast path: manifest mtime matches what we cached last run →
  // nothing changed since the last rescan. Reuse the entry verbatim.
  // Skips: drift warnings (already seen), audit.jsonl aggregation
  // (biggest cost), transcript copy (unless outDir was wiped),
  // tool-use mining, and the subagents/ walk.
  //
  // Staleness window: subagent rollups refresh only when the manifest
  // mtime changes. In practice Cowork rewrites the manifest on every
  // activity tick (lastActivityAt updates in lock-step with audit +
  // transcript), so a new subagent fan-out almost always trips the
  // mtime check on the next rescan.
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

  // Decide transcriptStatus — drives the viewer's SCANNED-panel split
  // between "transcript file missing on disk" and "Cowork CLI crashed
  // before writing a transcript". The diagnostic distinguishing the
  // two cases is whether the upstream manifest ever allocated a
  // `cliSessionId` (the CLI side never came up if not — these almost
  // always carry an `error` field too). Both states are no-transcript
  // from chat-arch's POV but they have different remediation paths:
  // crashes are recoverable from `audit.jsonl` in a future pass;
  // missing-from-disk files are genuinely gone.
  const transcriptStatus: 'ok' | 'crashed' | 'missing' = transcriptCopied
    ? 'ok'
    : typeof manifest.cliSessionId !== 'string' || manifest.cliSessionId.length === 0
      ? 'crashed'
      : 'missing';

  // Tool-use histogram — mined from the copied transcript (same content-
  // block shape as cli-direct / cloud). audit.jsonl does not carry tool
  // names (only `tool_use_summary` lines with ids), so we have to read
  // the transcript. Second pass is cheap on the cowork volume (low-100s
  // of sessions) and keeps the extraction co-located with the other
  // sources via the shared `streamToolUses` helper.
  const toolUses = transcriptAbsTarget ? await streamToolUses(transcriptAbsTarget) : {};

  // Subagent rollup — walk <sessionDir>/.claude/projects/-sessions-<proc>/
  // <cliSessionId>/subagents/agent-*.jsonl for Task-tool sub-agents (often
  // Haiku) whose tokens/tool calls would otherwise be invisible.
  //
  // Guard: cliSessionId may be null when CLI handoff crashed
  // (transcriptStatus='crashed'). Only walk when both cliSessionId and
  // processName are present; otherwise the path is invalid.
  const subagentRollup =
    typeof manifest.cliSessionId === 'string' &&
    manifest.cliSessionId.length > 0 &&
    typeof manifest.processName === 'string' &&
    manifest.processName.length > 0
      ? await aggregateSubagents(
          path.join(
            sessionDir,
            '.claude',
            'projects',
            `-sessions-${manifest.processName}`,
            manifest.cliSessionId,
            'subagents',
          ),
        )
      : undefined;

  // Merge parent + subagent aggregates so downstream consumers see a single
  // session-wide rollup. Tool counts come from disjoint transcripts (parent
  // vs. subagent files) and add cleanly. Token totals follow the same merge
  // — `audit.modelUsage` may or may not already include subagent tokens in
  // a given session; either way summing here over-attributes at worst, and
  // the standalone `subagentRollup` field below keeps the breakdown
  // inspectable for callers that need to disambiguate.
  const parentTokens = modelUsageToTokens(audit.modelUsage);
  const mergedTokens = subagentRollup
    ? sumTokens(parentTokens, subagentRollup.totalTokens)
    : parentTokens;
  const tokensHasAny =
    mergedTokens.input > 0 ||
    mergedTokens.output > 0 ||
    mergedTokens.cacheCreation > 0 ||
    mergedTokens.cacheRead > 0;
  const mergedTools = subagentRollup ? sumHistograms(toolUses, subagentRollup.topTools) : toolUses;
  const hasTools = Object.keys(mergedTools).length > 0;

  const modelsUsedArr = audit.modelUsage !== undefined ? Object.keys(audit.modelUsage) : [];
  const baseModels: readonly string[] = modelsUsedArr.length > 0 ? modelsUsedArr : [manifest.model];
  const modelsUsed: readonly string[] = subagentRollup
    ? uniqueModels(baseModels, subagentRollup.modelsUsed)
    : baseModels;

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
    ...(tokensHasAny ? { tokenTotals: mergedTokens } : {}),
    ...(hasTools ? { topTools: mergedTools } : {}),
    // Cached manifest file mtime — drives the incremental-rescan
    // fast path. Updated every time we (re)process the manifest.
    ...(currentMtime > 0 ? { sourceMtimeMs: currentMtime } : {}),
    ...(transcriptCopied && transcriptOutRel !== undefined
      ? { transcriptPath: toPosixRelative(path.join(outDir, transcriptOutRel), outDir) }
      : {}),
    transcriptStatus,
    manifestPath: toPosixRelative(manifestOutAbs, outDir),
    // auditPath: omitted (Q1)
    // Cowork manifest fields previously dropped — exposed for /chat answers.
    ...(manifest.userSelectedFolders
      ? { userSelectedFolders: manifest.userSelectedFolders }
      : {}),
    ...(manifest.slashCommands ? { slashCommands: manifest.slashCommands } : {}),
    ...(manifest.enabledMcpTools
      ? { enabledMcpTools: coerceMcpToolFlags(manifest.enabledMcpTools) }
      : {}),
    ...(typeof manifest.error === 'string' && manifest.error.length > 0
      ? { errorMessage: manifest.error }
      : {}),
    ...(subagentRollup ? { subagentRollup } : {}),
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
