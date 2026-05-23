import type { APIRoute } from 'astro';
import { spawn } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveClaudeBin } from '../../lib/resolveClaude.js';

/**
 * Opt this route into server rendering. The rest of the site is static
 * (see `astro.config.mjs`); this endpoint runs at request time.
 */
export const prerender = false;

/**
 * CSRF gate. The endpoint shells out to `claude -p ...` against the
 * user's repo, so an unauthenticated POST from any cross-origin page
 * in the same browser is a real attack surface. Two stacked checks,
 * both must pass — same shape as `rescan.ts`:
 *
 *   1. `Origin` parses to a hostname in the local-only allow-list.
 *   2. `X-Requested-With: chat-arch-mine-corrections` — a custom
 *      header an attacker page cannot set on a simple form submit.
 */
export const REQUIRED_HEADER = 'chat-arch-mine-corrections';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

function csrfReject(reason: string): Response {
  return new Response(JSON.stringify({ ok: false, error: `Forbidden: ${reason}` }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Serializes concurrent invocations. Two parallel claude CLI runs
 * would race to write `corrections.json`; concurrent callers get 409.
 *
 * `inFlightRequestId` mirrors the active run's id so the GET probe can
 * tell the viewer "yes, busy, AND here's the requestId." That lets a
 * page reload (or a 409'd retry) attach to the existing run's status
 * file instead of failing closed.
 */
let inFlight: Promise<void> | null = null;
let inFlightRequestId: string | null = null;

const MAX_LINE_CHARS = 2_000;
const MAX_TAIL_BYTES = 8 * 1024;

function tailBytes(text: string, max = MAX_TAIL_BYTES): string {
  if (text.length <= max) return text;
  return '… (truncated) …\n' + text.slice(-max);
}

function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return line.slice(0, MAX_LINE_CHARS - 12) + '… (truncated)';
}

/**
 * Resolve repo root from this file's location — same arithmetic as
 * `rescan.ts`:
 *
 *   apps/standalone/src/pages/api/mine-corrections.ts   (this file)
 *   ..\..\..\..\..                                       (five up = repo root)
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

/** Substrings (lower-cased) that indicate the CLI didn't recognise our `/slash` command. */
const SLASH_UNSUPPORTED_MARKERS = ['unknown command', 'command not found', 'no such command'];

function looksLikeSlashUnsupported(stdout: string, stderr: string): boolean {
  const haystack = (stdout + '\n' + stderr).toLowerCase();
  return SLASH_UNSUPPORTED_MARKERS.some((m) => haystack.includes(m));
}

interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

/**
 * What we learn from probing the on-disk artifacts after the skill
 * exits. Used by `classifyOutcome` to decide whether the run actually
 * succeeded, independent of the CLI's exit code (which can be 0 even
 * when the skill refused to proceed in headless mode — see below).
 */
export interface OutcomeProbe {
  /** `generatedAt` from a corrections.json file present on disk, or
   *  null if the file is missing / unreadable / lacks the field. */
  correctionsGeneratedAt: number | null;
  /** `status` from a `correction-status-<requestId>.json` file, or
   *  null if absent. */
  statusFileStatus: string | null;
  /** `error` from the same status file (only set when status is
   *  `'error'`), or null. */
  statusFileError: string | null;
}

export interface MiningOutcomeVerdict {
  ok: boolean;
  reason: string | null;
}

/**
 * Decide whether a mining run actually succeeded. The CLI's exit code
 * isn't sufficient on its own: `claude -p` exits 0 when the skill
 * decides not to proceed (e.g. it hits a documented "ask the user
 * before proceeding" branch in headless mode where there's no one to
 * answer). Without this check, the endpoint would emit `ok: true` for
 * a run that wrote zero output, and the viewer's runMining would
 * silently swap back to the idle state — the exact "MINE ALL fails
 * silently" bug this helper exists to prevent.
 *
 * Definition of success: the skill wrote `corrections.json` (or
 * refreshed an existing one) with `generatedAt >= startedAt`. If the
 * status file says `status: error`, that's an explicit failure with a
 * useful message to surface.
 */
export function classifyOutcome(
  startedAt: number,
  exitCode: number | null,
  spawnError: Error | null,
  probe: OutcomeProbe,
): MiningOutcomeVerdict {
  if (spawnError !== null) {
    return { ok: false, reason: `spawn error: ${spawnError.message}` };
  }
  if (exitCode !== 0) {
    return { ok: false, reason: `claude CLI exited with code ${exitCode}` };
  }
  if (probe.statusFileStatus === 'error') {
    const msg = probe.statusFileError ?? '(no message in status file)';
    return { ok: false, reason: `skill reported error: ${msg}` };
  }
  if (
    probe.correctionsGeneratedAt === null ||
    probe.correctionsGeneratedAt < startedAt
  ) {
    const detail =
      probe.statusFileStatus !== null
        ? ` (last skill status: ${probe.statusFileStatus})`
        : ' (no skill status file written — skill likely aborted in Stage 0 before initializing, e.g. hit a cap-and-ask branch in headless mode or failed to verify Ollama)';
    return {
      ok: false,
      reason:
        `skill exited cleanly but did not write a fresh corrections.json${detail}. ` +
        `This is the "silent abort" failure mode — the CLI returned exit 0 but no output was produced.`,
    };
  }
  return { ok: true, reason: null };
}

async function probeOutcome(
  rootAbs: string,
  dataDir: string,
  requestId: string,
): Promise<OutcomeProbe> {
  const dataDirAbs = resolve(rootAbs, dataDir);
  const corrections = await readJsonOrNull<{ generatedAt?: unknown }>(
    join(dataDirAbs, 'analysis', 'corrections.json'),
  );
  const status = await readJsonOrNull<{
    status?: unknown;
    error?: unknown;
  }>(join(dataDirAbs, 'analysis', `correction-status-${requestId}.json`));
  return {
    correctionsGeneratedAt:
      typeof corrections?.generatedAt === 'number'
        ? corrections.generatedAt
        : null,
    statusFileStatus:
      typeof status?.status === 'string' ? status.status : null,
    statusFileError:
      typeof status?.error === 'string' ? status.error : null,
  };
}

interface MineParams {
  requestId: string;
  windowDays: number;
  dataDir: string;
  autoWindow: AutoWindowResult | null;
  /**
   * Absolute path to a JSON file the API wrote with the explicit
   * candidate-id list the skill should process. Present when auto-window
   * picked candidates by composite (signal × recency) score rather than
   * pure time window. Skill consumes via --candidate-ids-file.
   */
  candidateIdsFile: string | null;
}

const DEFAULT_DATA_DIR = 'apps/standalone/public/chat-arch-data';
const DAY_MS = 86_400_000;
/** Default first-run target candidate count when no prior pattern-yield exists. */
const FIRST_RUN_TARGET_CANDIDATES = 80;
/** Below this gap of unprocessed candidates, treat as "nothing new" and short-circuit. */
const MIN_INCREMENTAL_GAP = 5;
/** Hard ceiling so a fresh corpus with very old sessions can't pick a
 *  multi-year window by accident. */
const MAX_AUTO_WINDOW_DAYS = 365;
/** Outcome-aware sizing aims for this many patterns per run. Multiplied
 *  by the inverse of historical pattern yield to set the target count. */
const TARGET_PATTERNS_PER_RUN = 4;
/** Bounds on outcome-aware target so the heuristic doesn't suggest 5 or
 *  500 when yield is extreme. */
const MIN_OUTCOME_TARGET = 30;
const MAX_OUTCOME_TARGET = 200;
/** Recency boost decays linearly to 0 over this many days. */
const RECENCY_BOOST_DAYS = 30;
/** Composite ranking weights. Signal weights from the recall heuristic's
 *  signal kinds — explicit-stop / explicit-no / imperative-override are
 *  the strongest correction indicators; instead-of and repeat-instruction
 *  are weaker; frustration is noise without other signals. */
const SIGNAL_WEIGHT: Record<string, number> = {
  'explicit-stop': 3,
  'explicit-no': 2,
  'imperative-override': 2,
  'instead-of': 1,
  'repeat-instruction': 1,
  // soft-redirect / want-prefer: weaker correction shapes added 2026-05
  // after the recall audit. Same tier as instead-of/repeat-instruction —
  // the user IS expressing a preference, but politely, so the LLM stage
  // does more of the heavy lifting on actionability.
  'soft-redirect': 1,
  'want-prefer': 1,
  frustration: 0.5,
};

export interface BackfillInfo {
  /** Number of unprocessed candidates older than the most-recent target. */
  count: number;
  /** Suggested target if user opts to backfill instead. */
  suggestedTarget: number;
  /** Suggested windowDays for the backfill. Useful only as a display value;
   *  the actual selection is by candidate id. */
  suggestedWindowDays: number;
  /** ISO date of the oldest unprocessed candidate's session updatedAt. */
  oldestDate: string;
}

export interface AutoWindowResult {
  windowDays: number;
  candidateCount: number;
  reasoning: string;
  /** 'first-run' on cold start; 'incremental' when prior corrections exist;
   *  'idle' when nothing new since last run; 'unavailable' when the data
   *  files aren't readable yet; 'backfill' when explicitly running an
   *  oldest-first selection; 'all' when the caller asked to mine every
   *  unprocessed candidate in one pass (no cost cap). */
  mode: 'first-run' | 'incremental' | 'idle' | 'unavailable' | 'backfill' | 'all';
  /** Diagnostic for outcome-aware sizing. Null on first run. */
  patternYield: { patterns: number; classified: number; ratio: number } | null;
  /** Present when there are unprocessed candidates older than the picked
   *  set. Lets the viewer offer a separate "backfill older" option. */
  backfillAvailable: BackfillInfo | null;
}

interface ManifestSession {
  id?: unknown;
  updatedAt?: unknown;
}
interface ManifestShape {
  sessions?: ManifestSession[];
}
interface CandidateSignal {
  kind?: unknown;
}
interface CandidateShape {
  id?: unknown;
  sessionId?: unknown;
  signals?: CandidateSignal[];
  /**
   * Only populated by the LLM classification stage. Stage-1 candidates
   * have classification: null. The auto-window incremental check uses
   * this field to distinguish "actually processed" from "in the file but
   * still pending" — the prior run can write null-classification entries
   * for candidates outside its window without those counting as done.
   */
  classification?: unknown;
}
interface CandidatesFileShape {
  corrections?: CandidateShape[];
}
interface PatternShape {
  id?: unknown;
}
interface CorrectionsFileShape {
  corrections?: CandidateShape[];
  patterns?: PatternShape[];
  pipeline?: { llmClassification?: unknown };
}

interface RankedCandidate {
  id: string;
  sessionId: string;
  updatedAt: number;
  signalScore: number;
  /** signalScore + recency-boost-relative-to-now. Higher = pick first. */
  composite: number;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function signalScoreFor(c: CandidateShape): number {
  let total = 0;
  for (const s of c.signals ?? []) {
    if (typeof s.kind !== 'string') continue;
    total += SIGNAL_WEIGHT[s.kind] ?? 0;
  }
  return total;
}

function compositeFor(signalScore: number, updatedAt: number, now: number): number {
  if (updatedAt <= 0) return signalScore;
  const daysAgo = (now - updatedAt) / DAY_MS;
  const recencyBoost = Math.max(0, (RECENCY_BOOST_DAYS - daysAgo) / RECENCY_BOOST_DAYS);
  return signalScore + recencyBoost;
}

/**
 * Compute target candidate count from prior pattern yield. Aim for ~4
 * patterns per run; if last run produced 1 pattern per 25 candidates,
 * target 100. Falls back to the first-run constant when there's no
 * yield signal (zero classified, or prior produced patterns out of
 * proportion to classified — a confidence threshold can drop everything).
 */
function outcomeAwareTarget(
  patternCount: number,
  classifiedCount: number,
): number {
  if (classifiedCount === 0 || patternCount === 0) {
    return FIRST_RUN_TARGET_CANDIDATES;
  }
  const ratio = patternCount / classifiedCount;
  const raw = Math.ceil(TARGET_PATTERNS_PER_RUN / ratio);
  return Math.min(MAX_OUTCOME_TARGET, Math.max(MIN_OUTCOME_TARGET, raw));
}

/**
 * Pick the candidates to mine without asking the user. Scores each
 * unprocessed candidate by composite (signal-density × recency-boost)
 * so high-signal entries beat low-signal ones at the boundary, then
 * takes the top-N where N is sized from prior pattern yield. Returns
 * both the picked set (for the skill to process directly) and the
 * derived windowDays (for display + the existing --window-days arg).
 *
 * Mode semantics:
 *   first-run: no prior runs, target = FIRST_RUN_TARGET_CANDIDATES.
 *   incremental: prior runs exist; target sized by outcomeAwareTarget,
 *     ranking by composite score so high-signal old candidates can
 *     beat low-signal recent ones.
 *   backfill: caller passed mode='backfill' explicitly; pick OLDEST
 *     unprocessed by composite-with-inverted-recency, so historical
 *     patterns surface that the recent-first incremental never reaches.
 *   idle: too few unprocessed to bother running.
 *   unavailable: data files missing or corrupt.
 */
export async function computeAutoWindow(
  rootAbs: string,
  dataDir: string,
  selection: 'recent' | 'backfill' | 'all' = 'recent',
): Promise<{ result: AutoWindowResult; targetIds: string[] }> {
  const empty = (result: AutoWindowResult): { result: AutoWindowResult; targetIds: string[] } => ({
    result,
    targetIds: [],
  });
  const dataDirAbs = resolve(rootAbs, dataDir);
  const manifest = await readJsonOrNull<ManifestShape>(
    join(dataDirAbs, 'manifest.json'),
  );
  const candidates = await readJsonOrNull<CandidatesFileShape>(
    join(dataDirAbs, 'analysis', 'correction-candidates.json'),
  );
  if (manifest === null || candidates === null) {
    return empty({
      windowDays: 30,
      candidateCount: 0,
      reasoning:
        'Manifest or correction-candidates.json missing. Run the chat-arch exporter first.',
      mode: 'unavailable',
      patternYield: null,
      backfillAvailable: null,
    });
  }

  const sidToUpdatedAt = new Map<string, number>();
  for (const s of manifest.sessions ?? []) {
    if (typeof s.id === 'string' && typeof s.updatedAt === 'number') {
      sidToUpdatedAt.set(s.id, s.updatedAt);
    }
  }

  const now = Date.now();
  const ranked: RankedCandidate[] = [];
  for (const c of candidates.corrections ?? []) {
    if (typeof c.id !== 'string' || typeof c.sessionId !== 'string') continue;
    const ts = sidToUpdatedAt.get(c.sessionId) ?? 0;
    const signalScore = signalScoreFor(c);
    ranked.push({
      id: c.id,
      sessionId: c.sessionId,
      updatedAt: ts,
      signalScore,
      composite: compositeFor(signalScore, ts, now),
    });
  }

  if (ranked.length === 0) {
    return empty({
      windowDays: 30,
      candidateCount: 0,
      reasoning: 'No correction candidates in the corpus yet.',
      mode: 'unavailable',
      patternYield: null,
      backfillAvailable: null,
    });
  }

  const prior = await readJsonOrNull<CorrectionsFileShape>(
    join(dataDirAbs, 'analysis', 'corrections.json'),
  );
  const priorIds = new Set<string>();
  let priorClassified = 0;
  for (const c of prior?.corrections ?? []) {
    if (typeof c.id !== 'string') continue;
    if (c.classification === null || c.classification === undefined) continue;
    priorIds.add(c.id);
    priorClassified += 1;
  }
  const priorPatterns = (prior?.patterns ?? []).filter(
    (p) => typeof p.id === 'string',
  ).length;
  const hasPriorRun =
    prior !== null &&
    prior.pipeline?.llmClassification === true &&
    priorIds.size > 0;

  const patternYield = hasPriorRun
    ? {
        patterns: priorPatterns,
        classified: priorClassified,
        ratio: priorClassified > 0 ? priorPatterns / priorClassified : 0,
      }
    : null;

  const fresh = ranked.filter((r) => !priorIds.has(r.id));

  if (fresh.length === 0) {
    return empty({
      windowDays: 0,
      candidateCount: 0,
      reasoning:
        'All candidates have been classified. Run the chat-arch exporter to pick up new sessions.',
      mode: 'idle',
      patternYield,
      backfillAvailable: null,
    });
  }

  if (fresh.length < MIN_INCREMENTAL_GAP && hasPriorRun) {
    return empty({
      windowDays: 0,
      candidateCount: fresh.length,
      reasoning: `Idle: ${fresh.length} unprocessed candidate${fresh.length === 1 ? '' : 's'} of ${ranked.length} total (threshold ${MIN_INCREMENTAL_GAP}). Skip until more accumulate.`,
      mode: 'idle',
      patternYield,
      backfillAvailable: null,
    });
  }

  // Order: composite score desc for 'recent' AND 'all' (the user picks
  // everything; ranking just controls which items the skill processes
  // first within the batch). For 'backfill', re-score with INVERTED
  // recency so older high-signal candidates win.
  const ordered = [...fresh].sort((a, b) => {
    if (selection === 'recent' || selection === 'all') return b.composite - a.composite;
    const invA = a.signalScore + (a.updatedAt > 0 ? 0 : 0); // pure signal weight
    const invB = b.signalScore + (b.updatedAt > 0 ? 0 : 0);
    if (invB !== invA) return invB - invA;
    return a.updatedAt - b.updatedAt; // older first as tiebreak
  });

  // Outcome-aware sizing — falls back to FIRST_RUN_TARGET_CANDIDATES on
  // first run or zero-yield runs. 'all' bypasses the cap entirely:
  // the user explicitly opted into mining every unprocessed candidate
  // in one pass and accepted the cost in the ArmedPreview confirmation.
  const baseTarget = hasPriorRun
    ? outcomeAwareTarget(priorPatterns, priorClassified)
    : FIRST_RUN_TARGET_CANDIDATES;
  const target =
    selection === 'all' ? ordered.length : Math.min(baseTarget, ordered.length);
  const picked = ordered.slice(0, target);
  const targetIds = picked.map((p) => p.id);

  // windowDays covers the temporal span of the picked set. Note: under
  // density-aware ranking the window can be wider than the recency-only
  // version (because high-signal old candidates pull the boundary back).
  // The skill uses the explicit id list when present; windowDays is for
  // human display + back-compat with --window-days.
  let windowDays = 1;
  let oldestPicked = now;
  for (const p of picked) {
    if (p.updatedAt > 0 && p.updatedAt < oldestPicked) {
      oldestPicked = p.updatedAt;
    }
  }
  windowDays = Math.min(
    MAX_AUTO_WINDOW_DAYS,
    Math.max(1, Math.ceil((now - oldestPicked) / DAY_MS)),
  );

  // Backfill availability: any unprocessed candidates older than the
  // oldest picked one. Surfacing this lets the user run an explicit
  // "older first" pass to dig out historical patterns that recent-first
  // incremental will never reach.
  let backfillAvailable: BackfillInfo | null = null;
  if (selection === 'recent') {
    const olderUnpicked = fresh.filter(
      (r) => !targetIds.includes(r.id) && r.updatedAt > 0 && r.updatedAt < oldestPicked,
    );
    if (olderUnpicked.length >= MIN_INCREMENTAL_GAP) {
      const oldest = olderUnpicked.reduce(
        (acc, r) => (r.updatedAt < acc ? r.updatedAt : acc),
        olderUnpicked[0]!.updatedAt,
      );
      const suggested = Math.min(baseTarget, olderUnpicked.length);
      const suggestedWindowDays = Math.min(
        MAX_AUTO_WINDOW_DAYS,
        Math.max(1, Math.ceil((now - oldest) / DAY_MS)),
      );
      backfillAvailable = {
        count: olderUnpicked.length,
        suggestedTarget: suggested,
        suggestedWindowDays,
        oldestDate: new Date(oldest).toISOString().slice(0, 10),
      };
    }
  }

  let mode: AutoWindowResult['mode'];
  let reasoning: string;
  if (selection === 'all') {
    mode = 'all';
    reasoning = `All: targeting every unprocessed candidate (${target} of ${ranked.length} total). Composite-ranked so high-signal items run first within the batch. Covers ~${windowDays} day${windowDays === 1 ? '' : 's'}.`;
  } else if (selection === 'backfill') {
    mode = 'backfill';
    reasoning = `Backfill: targeting ${target} oldest unprocessed candidate${target === 1 ? '' : 's'} of ${fresh.length} total (~${windowDays} day${windowDays === 1 ? '' : 's'} span). High-signal items prioritized.`;
  } else if (hasPriorRun) {
    mode = 'incremental';
    const yieldNote = patternYield && patternYield.classified > 0
      ? ` Prior yield: ${patternYield.patterns} pattern${patternYield.patterns === 1 ? '' : 's'} / ${patternYield.classified} classified → target ${baseTarget}.`
      : ` Target ${baseTarget}.`;
    reasoning = `Incremental: ${fresh.length} unprocessed of ${ranked.length} total. Picking top ${target} by composite (signal × recency).${yieldNote} Covers ~${windowDays} day${windowDays === 1 ? '' : 's'}.`;
  } else {
    mode = 'first-run';
    reasoning = `First run: targeting top ${target} of ${ranked.length} candidate${ranked.length === 1 ? '' : 's'} by composite (signal × recency). Covers ~${windowDays} day${windowDays === 1 ? '' : 's'}.`;
  }

  return {
    result: {
      windowDays,
      candidateCount: target,
      reasoning,
      mode,
      patternYield,
      backfillAvailable,
    },
    targetIds,
  };
}

/**
 * Run the `claude` CLI once with the given prompt and stream its
 * stdout/stderr to the client as NDJSON events. Returns the final
 * accumulated buffers + exit code so the caller can decide whether
 * to fall back to a different prompt shape.
 */
function runClaudeOnce(
  prompt: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<SpawnOutcome> {
  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // Controller may already be closed if the client disconnected.
    }
  };

  return new Promise<SpawnOutcome>((resolvePromise) => {
    // Pre-authorize the tools the skill needs so it doesn't stall on
    // per-tool approval prompts in headless mode. Whitelist (not full
    // bypass) keeps the spawn under tool-level scrutiny: only Read /
    // Write / Edit / Bash / Task (sub-agent) / Glob / Grep are usable.
    // Risk is bounded by this endpoint's CSRF gate (local origin only)
    // and the skill's project-local write scope.
    const allowedTools = 'Read Write Edit Bash Task Glob Grep';

    // Resolve the claude binary via the central helper. It checks
    // CLAUDE_BIN → CLAUDE_CODE_EXECPATH → %APPDATA%\Claude\claude-code\
    // → bare 'claude' on PATH, in that order — so we get a working
    // install even when the global npm shim is broken (auto-updater
    // mid-flight leaves `claude.exe.old.*` files with no current .exe).
    // When the resolver returns an absolute path, spawn without a shell
    // so the OS launches the .exe directly and Node's arg array is
    // passed verbatim (no cmd.exe special-char surprises). Only the
    // PATH-fallback branch uses shell:true so PATHEXT can resolve
    // `claude.cmd`.
    const bin = resolveClaudeBin();
    const args = ['--allowedTools', allowedTools, '-p', prompt];
    const child = spawn(bin.file, args, {
      cwd: repoRoot(),
      env: process.env,
      shell: bin.useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    const stdoutFull = { v: '' };
    const stderrFull = { v: '' };
    let spawnError: Error | null = null;

    const drain = (
      buf: string,
      chunk: string,
      kind: 'stdout' | 'stderr',
      full: { v: string },
    ): string => {
      full.v += chunk;
      const combined = buf + chunk;
      const parts = combined.split('\n');
      const lastFragment = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (line.length === 0) continue;
        send({ type: kind, line: clampLine(line) });
        const m = /\[(\d+)\/(\d+)\]\s+(\w[\w-]*)\s*:/.exec(line);
        if (m) {
          send({
            type: 'phase',
            phase: m[3],
            ix: Number(m[1]),
            total: Number(m[2]),
          });
        }
      }
      return lastFragment;
    };

    // stdio: ['ignore', 'pipe', 'pipe'] above guarantees stdout/stderr
    // are present at runtime; spawn's return type narrows them to
    // possibly-null for the general case, so a non-null assertion is
    // load-bearing for TypeScript but a no-op at runtime.
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf = drain(stdoutBuf, chunk.toString('utf8'), 'stdout', stdoutFull);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf = drain(stderrBuf, chunk.toString('utf8'), 'stderr', stderrFull);
    });

    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      // Flush any unterminated trailing fragments so they aren't lost.
      if (stdoutBuf.trim().length > 0) {
        send({ type: 'stdout', line: clampLine(stdoutBuf.trim()) });
        stdoutFull.v += stdoutBuf;
        stdoutBuf = '';
      }
      if (stderrBuf.trim().length > 0) {
        send({ type: 'stderr', line: clampLine(stderrBuf.trim()) });
        stderrFull.v += stderrBuf;
        stderrBuf = '';
      }
      resolvePromise({
        exitCode: code,
        stdout: stdoutFull.v,
        stderr: stderrFull.v,
        spawnError,
      });
    });
  });
}

/**
 * Drive the mine-corrections skill. Tries a slash-command prompt
 * first; if the CLI rejects the slash form (older versions don't
 * accept `/foo` via `-p`), falls back once to a "read SKILL.md and
 * execute it" prompt, sharing the same NDJSON stream.
 */
async function streamMineCorrections(
  params: MineParams,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const started = Date.now();
  const { requestId, windowDays, dataDir, candidateIdsFile } = params;
  const idsArg = candidateIdsFile !== null
    ? ` --candidate-ids-file=${candidateIdsFile}`
    : '';
  const argSuffix = `--request-id=${requestId} --window-days=${windowDays} --data-dir=${dataDir}${idsArg}`;
  const slashPrompt = `/mine-corrections ${argSuffix}`;
  const fallbackPrompt =
    `Read .claude/skills/mine-corrections/SKILL.md and execute it with these arguments: ${argSuffix}`;

  const send = (obj: unknown) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
    } catch {
      // Already closed — ignore.
    }
  };

  // Initial start event carries the requestId so the viewer can
  // correlate this run with the file it later reads from disk. When
  // the run came from auto-window mode, surface the chosen window so
  // the live status can show "Mining 23 days, ~62 candidates" rather
  // than just "running."
  send({
    type: 'start',
    command: `claude -p "${slashPrompt}"`,
    requestId,
    startedAt: started,
    windowDays,
    autoWindow: params.autoWindow,
  });

  let outcome = await runClaudeOnce(slashPrompt, controller, encoder);
  let usedFallback = false;

  const slashLooksUnsupported =
    outcome.exitCode !== 0 && looksLikeSlashUnsupported(outcome.stdout, outcome.stderr);

  if (slashLooksUnsupported) {
    usedFallback = true;
    send({ type: 'phase', phase: 'fallback-prompt' });
    const second = await runClaudeOnce(fallbackPrompt, controller, encoder);
    // Concatenate buffers so the `done` event's tails reflect the
    // full session the operator can paste back as a bug report.
    outcome = {
      exitCode: second.exitCode,
      stdout: outcome.stdout + second.stdout,
      stderr: outcome.stderr + second.stderr,
      spawnError: second.spawnError ?? outcome.spawnError,
    };
  }

  const extraStderr = outcome.spawnError
    ? '\nspawn error: ' + (outcome.spawnError.message ?? String(outcome.spawnError))
    : '';

  // Validate the on-disk outcome. The CLI's exit code alone isn't a
  // reliable success signal: in headless `claude -p` mode, the skill
  // can hit an "ask the user" branch (e.g. Stage 0 sub-agent cap),
  // print a question, and exit cleanly with code 0 without writing
  // anything. Reporting `ok: true` for that case is the silent
  // failure path — the viewer would refresh, find no new corrections,
  // and revert to idle without surfacing why.
  const probe = await probeOutcome(repoRoot(), dataDir, requestId);
  const verdict = classifyOutcome(
    started,
    outcome.exitCode,
    outcome.spawnError,
    probe,
  );

  // Skill cleans up the target-ids file on Stage 7 success. If the run
  // failed, the file is now an orphan — sweep it ourselves so future
  // diagnostics aren't cluttered (and so the user can re-arm MINE ALL
  // without seeing a stale id file). Silent best-effort; an unreachable
  // file is fine.
  if (!verdict.ok && candidateIdsFile !== null) {
    try {
      await unlink(candidateIdsFile);
    } catch {
      // Already gone or unreadable — nothing to do.
    }
  }

  const verdictNote = verdict.reason !== null ? '\n[outcome] ' + verdict.reason : '';

  send({
    type: 'done',
    ok: verdict.ok,
    exitCode: outcome.exitCode,
    durationMs: Date.now() - started,
    requestId,
    usedFallback,
    stdoutTail: tailBytes(outcome.stdout),
    stderrTail: tailBytes(outcome.stderr + extraStderr + verdictNote),
    command: usedFallback
      ? `claude -p "${fallbackPrompt}"`
      : `claude -p "${slashPrompt}"`,
  });

  try {
    controller.close();
  } catch {
    // Already closed by client disconnect — ignore.
  }
}

interface MineRequestBody {
  windowDays?: unknown;
  dataDir?: unknown;
  /** 'recent' (default), 'backfill', or 'all' (mine every unprocessed
   *  candidate in one pass — bypasses the cost cap). */
  selection?: unknown;
}

async function parseParams(body: MineRequestBody): Promise<MineParams> {
  const rawDir = body.dataDir;
  const dataDir =
    typeof rawDir === 'string' && rawDir.trim().length > 0
      ? rawDir
      : DEFAULT_DATA_DIR;

  // Honor an explicit windowDays override. Otherwise compute auto-window
  // from manifest + correction-candidates + any prior corrections.json.
  const rawWindow = body.windowDays;
  if (
    typeof rawWindow === 'number' &&
    Number.isFinite(rawWindow) &&
    rawWindow > 0
  ) {
    return {
      requestId: randomUUID(),
      windowDays: Math.floor(rawWindow),
      dataDir,
      autoWindow: null,
      candidateIdsFile: null,
    };
  }

  const selection: 'recent' | 'backfill' | 'all' =
    body.selection === 'all'
      ? 'all'
      : body.selection === 'backfill'
        ? 'backfill'
        : 'recent';
  const { result: auto, targetIds } = await computeAutoWindow(
    repoRoot(),
    dataDir,
    selection,
  );

  // Write the explicit candidate-id list so the skill processes
  // composite-ranked picks rather than a pure time slice. The file is
  // request-scoped so concurrent runs (which the inFlight gate already
  // prevents) wouldn't collide anyway, but the requestId in the name
  // makes accidental orphan files easy to identify.
  const requestId = randomUUID();
  let candidateIdsFile: string | null = null;
  if (targetIds.length > 0) {
    const path = join(
      resolve(repoRoot(), dataDir),
      'analysis',
      `_correction-target-ids-${requestId}.json`,
    );
    try {
      await writeFile(
        path,
        JSON.stringify({ ids: targetIds }, null, 2) + '\n',
        'utf8',
      );
      candidateIdsFile = path;
    } catch {
      // If we can't write the file (permissions, missing dir), the skill
      // falls back to --window-days. Auto-window still surfaces in the
      // start event for display.
      candidateIdsFile = null;
    }
  }

  return {
    requestId,
    windowDays: auto.windowDays,
    dataDir,
    autoWindow: auto,
    candidateIdsFile,
  };
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  let body: MineRequestBody = {};
  // Empty bodies are fine — defaults cover everything. Malformed
  // JSON is also tolerant: we treat it as `{}` rather than 400-ing,
  // since the operator-facing UI shouldn't fail on a stray content-
  // type quirk.
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        body = parsed as MineRequestBody;
      }
    }
  } catch {
    body = {};
  }

  if (inFlight) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'A correction-mining run is already in progress. Wait for it to finish.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  const params = await parseParams(body);

  // If auto-window resolved to "idle" (nothing new to mine), short-circuit
  // before we even spawn claude. The viewer renders this as a clean
  // "everything is up to date" state instead of running a no-op pipeline.
  if (params.autoWindow !== null && params.autoWindow.mode === 'idle') {
    return new Response(
      JSON.stringify(
        {
          type: 'done',
          ok: true,
          exitCode: 0,
          durationMs: 0,
          requestId: params.requestId,
          usedFallback: false,
          autoWindow: params.autoWindow,
          stdoutTail: params.autoWindow.reasoning,
          stderrTail: '',
          command: '(skipped — auto-window mode: idle)',
        },
        null,
        0,
      ) + '\n',
      {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
        },
      },
    );
  }

  const encoder = new TextEncoder();
  let done: (() => void) | null = null;
  const completed = new Promise<void>((res) => {
    done = res;
  });
  inFlight = completed.then(() => undefined);
  inFlightRequestId = params.requestId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await streamMineCorrections(params, controller, encoder);
      } finally {
        inFlight = null;
        inFlightRequestId = null;
        done?.();
      }
    },
    cancel() {
      // Client disconnected; the CLI keeps running and writes to
      // disk. The promise chain above still resolves on close.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
};

/**
 * Readiness probe + auto-window preview. The viewer pings this on
 * mount and on panel-open to decide:
 *   (a) whether to show the MINE button (`available`)
 *   (b) whether a run is already in flight (`busy`)
 *   (c) what window the auto-mode would pick if you clicked MINE now
 *       (`autoWindow`) — surfaces "Will mine ~62 candidates from the
 *       last 23 days" in the preview without making the user choose.
 *
 * Production static builds without a backend have no GET; the viewer
 * treats fetch failure as `available: false`.
 */
export const GET: APIRoute = async ({ url }) => {
  const dirParam = url.searchParams.get('dataDir');
  const dataDir =
    typeof dirParam === 'string' && dirParam.trim().length > 0
      ? dirParam
      : DEFAULT_DATA_DIR;
  const selParam = url.searchParams.get('selection');
  const selection: 'recent' | 'backfill' | 'all' =
    selParam === 'all'
      ? 'all'
      : selParam === 'backfill'
        ? 'backfill'
        : 'recent';
  let autoWindow: AutoWindowResult | null = null;
  try {
    const out = await computeAutoWindow(repoRoot(), dataDir, selection);
    autoWindow = out.result;
  } catch {
    autoWindow = null;
  }
  return new Response(
    JSON.stringify({
      ok: true,
      available: true,
      busy: inFlight !== null,
      busyRequestId: inFlightRequestId,
      autoWindow,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  );
};
