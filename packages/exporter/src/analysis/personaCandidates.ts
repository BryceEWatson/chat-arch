/**
 * Stage-1 persona-candidates writer — heuristic per-project bucket
 * extraction over user-turn excerpts. Pure data prep: emits
 * `analysis/persona-candidates.json`. The Claude Code skill
 * `/mine-persona` consumes this file in Stage 2 (LLM synthesis)
 * and writes per-project markdown to `analysis/personas/<id>.md`.
 *
 * Why the 6 buckets: they mirror the structure of
 * `research/persona-evals/bryce.md` so the LLM synthesizer has a
 * pre-segmented input that maps cleanly onto the persona's pattern
 * sections (role/expertise → §1, preferences → §2, etc.). The
 * deterministic Stage-1 layer keeps the LLM stage's job small:
 * "pick verbatim quotes per bucket and write durable Pattern. /
 * Evidence. / What this implies. paragraphs" instead of "find
 * patterns in 200 transcripts."
 *
 * PII posture: every emitted candidate is a verbatim user-prompt
 * excerpt. Carries the same PII surface as `correction-candidates.json`
 * — gitignored under `apps/standalone/public/chat-arch-data/*`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  PersonaBucket,
  PersonaCandidate,
  PersonaCandidateProject,
  PersonaCandidatesFile,
  Project,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { THRESHOLDS } from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';

/**
 * Bump when a heuristic-bucket regex family changes. Drives no cache
 * (Stage 1 always re-runs as part of `runAnalysis`), but it labels the
 * sidecar so the Stage-2 skill can refuse to synthesize against an
 * incompatible version of the candidate format.
 */
export const PERSONA_HEURISTIC_VERSION = 1;

export interface BuildPersonaCandidatesOptions {
  outDir: string;
  now: number;
  /** From `discoverProjects(...)`. Drives bucketing by projectId. */
  projects: readonly Project[];
  /** Map: sessionId → projectId (includes UNASSIGNED). */
  sessionToProject: Map<string, string>;
  /** Parallelism for transcript reads. Same default as corrections.ts. */
  ioConcurrency?: number;
}

export interface BuildPersonaCandidatesResult {
  file: PersonaCandidatesFile;
  projectsAnalyzed: number;
  candidatesTotal: number;
}

const DEFAULT_IO_CONCURRENCY = 8;
const MAX_EXCERPT_CHARS = 500;
const MAX_USER_PROMPT_CHARS = 4000;
/** Per-bucket cap on candidates per project so the LLM stage's input
 *  stays bounded even for a corpus with 600+ sessions per project. */
const MAX_CANDIDATES_PER_BUCKET = 40;

/**
 * Wrapper prefixes for harness-injected user-role lines (same list as
 * corrections.ts — duplicated locally rather than imported so neither
 * builder accidentally depends on the other's internals; the shared
 * shape lives in the transcript format itself).
 */
const WRAPPER_PREFIXES: readonly string[] = [
  '<command-message>',
  '<command-name>',
  '<command-args>',
  '<system-reminder>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<scheduled-task',
  '<uploaded_files>',
  'Base directory for this skill:',
  '<file>',
  '<file_path>',
  '<file_uuid>',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  '[Request interrupted by user',
];

interface BucketPatternDef {
  bucket: PersonaBucket;
  patternKey: string;
  regex: RegExp;
}

/**
 * Heuristic pattern catalogue. Word-boundary `\b` anchors keep matches
 * tight; case-insensitive `i` because user prompts mix casing freely.
 * Patterns are intentionally permissive — the Stage-2 LLM trims false
 * positives, the Stage-1 heuristic just needs broad recall.
 */
const BUCKET_PATTERNS: readonly BucketPatternDef[] = [
  // role-expertise — claims about the user's profession, experience,
  // or stance on the work. Anchor on first-person + role nouns or
  // experience-duration tokens.
  {
    bucket: 'role-expertise',
    patternKey: 'first-person-role',
    regex: /\bI(?:'m| am)\s+(?:an?\s+)?(?:senior|junior|principal|staff|lead|chief)?\s*(?:software\s+)?(?:engineer|developer|designer|scientist|founder|maker|operator|architect|researcher|writer|owner|consultant|cto|ceo|pm|product\s+manager|tech\s+lead)\b/i,
  },
  {
    bucket: 'role-expertise',
    patternKey: 'years-experience',
    regex: /\b(?:I(?:'ve| have)\s+been|with|after)\s+(?:writing|building|using|working\s+(?:on|with|in))[^.]*?\b\d+\s*(?:\+\s*)?(?:year|yr)s?\b/i,
  },
  {
    bucket: 'role-expertise',
    patternKey: 'as-a',
    regex: /\b(?:as\s+(?:an?|the))\s+(?:engineer|developer|maker|founder|operator|designer|architect|user|owner|scientist)\b/i,
  },
  {
    bucket: 'role-expertise',
    patternKey: 'this-is-my-first',
    regex: /\bthis\s+is\s+(?:my\s+)?(?:first|second|third)\s+time\b/i,
  },

  // preferences — direct preference statements + use-X-not-Y constructs.
  {
    bucket: 'preferences',
    patternKey: 'i-prefer',
    regex: /\bI\s+(?:prefer|like|love|favou?r|enjoy)\b/i,
  },
  {
    bucket: 'preferences',
    patternKey: 'i-want',
    regex: /\bI\s+(?:want|need|expect|require|hope)\b/i,
  },
  {
    bucket: 'preferences',
    patternKey: 'i-dont-like',
    regex: /\bI\s+(?:don'?t|do\s+not)\s+(?:like|want|need)\b/i,
  },
  {
    bucket: 'preferences',
    patternKey: 'use-X-not-Y',
    regex: /\b(?:use|prefer)\s+\w[\w\-./]*\s+(?:not|over|instead\s+of|rather\s+than)\s+\w[\w\-./]*/i,
  },
  {
    bucket: 'preferences',
    patternKey: 'always-never',
    regex: /\b(?:always|never)\s+(?:use|do|run|write|prefer|skip|avoid)\b/i,
  },
  {
    bucket: 'preferences',
    patternKey: 'default-to',
    regex: /\bdefault(?:s|ing|ed)?\s+to\b/i,
  },

  // working-rhythm — process / sequencing / iteration words.
  {
    bucket: 'working-rhythm',
    patternKey: 'lets-first',
    regex: /\blet'?s\s+(?:first|start|begin|kick|do|build|ship|land|merge)\b/i,
  },
  {
    bucket: 'working-rhythm',
    patternKey: 'loop-iterate',
    regex: /\b(?:loop|iterate|continue|keep\s+going|don'?t\s+stop|until\s+(?:it'?s|the)\s+(?:done|complete|fixed|passing))\b/i,
  },
  {
    bucket: 'working-rhythm',
    patternKey: 'before-after-then',
    regex: /\b(?:before|after|then|next|finally),\s/i,
  },
  {
    bucket: 'working-rhythm',
    patternKey: 'step-by-step',
    regex: /\b(?:step\s+by\s+step|stage|phase|wave)\s+\d+\b/i,
  },
  {
    bucket: 'working-rhythm',
    patternKey: 'continue-dont-wait',
    regex: /\bcontinue,?\s+don'?t\s+(?:wait|stop|ask)\b/i,
  },

  // frictions — negative signals about state of work or tool output.
  {
    bucket: 'frictions',
    patternKey: 'doesnt-work',
    regex: /\b(?:doesn'?t|does\s+not|did\s+not|didn'?t)\s+(?:work|run|build|compile|pass|render|load)\b/i,
  },
  {
    bucket: 'frictions',
    patternKey: 'broken-failing',
    regex: /\b(?:broken|failing|crashes|crashed|hangs|stuck|hangs?\s+forever)\b/i,
  },
  {
    bucket: 'frictions',
    patternKey: 'frustration-explicit',
    regex: /\b(?:annoying|frustrating|hate|sucks|garbage|useless|wrong\s+again)\b/i,
  },
  {
    bucket: 'frictions',
    patternKey: 'wish-shouldnt',
    regex: /\b(?:I\s+wish|shouldn'?t\s+(?:that|this)|why\s+(?:does|is|isn'?t))\b/i,
  },
  {
    bucket: 'frictions',
    patternKey: 'lost-my-work',
    regex: /\b(?:lost\s+my|don'?t\s+lose|don'?t\s+overwrite|preserve\s+my)\b/i,
  },

  // project-specific — placeholder pattern; the per-project augmentation
  // (project-name tokens) is wired into the scan loop below since regex
  // would need to be project-aware.
  {
    bucket: 'project-specific',
    patternKey: 'this-project',
    regex: /\b(?:this|the)\s+(?:project|repo|app|codebase|tool)\b/i,
  },

  // voice — terse + verbose are special-cased by length below.
];

/**
 * Run `fn` over `items` with a sliding concurrency window. Preserves
 * input order. Inlined from corrections.ts pattern.
 */
async function parallelMap<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const i = cursor;
          cursor += 1;
          if (i >= items.length) return;
          out[i] = await fn(items[i] as T, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

interface ExtractedTurn {
  sessionId: string;
  userTurnIndex: number;
  text: string;
}

/**
 * Read a session's user turns. Mirrors the cloud/JSONL split from
 * corrections.ts but emits only user-text (no assistant context — the
 * persona stage works from user voice alone) and applies the same
 * wrapper / length filters so harness noise doesn't masquerade as
 * persona signal.
 */
async function readUserTurns(
  entry: UnifiedSessionEntry,
  outDir: string,
): Promise<readonly ExtractedTurn[]> {
  if (entry.transcriptPath === undefined) return [];
  const baseDir = path.resolve(outDir);
  const abs = path.resolve(baseDir, entry.transcriptPath);
  const rel = path.relative(baseDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];

  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    return [];
  }

  if (entry.source === 'cloud') {
    return parseCloudUserTurns(entry.id, raw);
  }
  return parseJsonlUserTurns(entry.id, raw);
}

interface CloudShape {
  chat_messages?: ReadonlyArray<{
    sender?: string;
    text?: string;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  }>;
}

function parseCloudUserTurns(sessionId: string, raw: string): readonly ExtractedTurn[] {
  let j: CloudShape;
  try {
    j = JSON.parse(raw) as CloudShape;
  } catch {
    return [];
  }
  const turns: ExtractedTurn[] = [];
  let idx = 0;
  for (const m of j.chat_messages ?? []) {
    if (m.sender !== 'human') continue;
    const text = extractCloudText(m);
    if (text === null) continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_USER_PROMPT_CHARS) continue;
    turns.push({ sessionId, userTurnIndex: idx, text: trimmed });
    idx += 1;
  }
  return turns;
}

function extractCloudText(m: {
  text?: string;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
}): string | null {
  if (typeof m.text === 'string' && m.text !== '') return m.text;
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const part of m.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

function parseJsonlUserTurns(
  sessionId: string,
  raw: string,
): readonly ExtractedTurn[] {
  const turns: ExtractedTurn[] = [];
  let idx = 0;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;
    if (rec['type'] !== 'user') continue;
    const msg = rec['message'];
    if (msg === null || typeof msg !== 'object') continue;
    const mrec = msg as Record<string, unknown>;
    if (mrec['role'] !== 'user') continue;
    const text = extractJsonlText(mrec['content']);
    if (text === null) continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    if (WRAPPER_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    if (trimmed.length > MAX_USER_PROMPT_CHARS) continue;
    turns.push({ sessionId, userTurnIndex: idx, text: trimmed });
    idx += 1;
  }
  return turns;
}

function extractJsonlText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as Record<string, unknown>)['type'] === 'text' &&
        typeof (part as Record<string, unknown>)['text'] === 'string'
      ) {
        parts.push((part as Record<string, unknown>)['text'] as string);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/**
 * Match a single user turn against the heuristic catalogue + the per-
 * project name token, emitting one candidate per (bucket, patternKey)
 * combination that fires. A long prompt can fire on multiple buckets;
 * that's deliberate — voice + preferences + frictions can all coexist
 * in one prompt.
 */
function matchTurn(
  turn: ExtractedTurn,
  projectNameTokens: readonly string[],
): readonly PersonaCandidate[] {
  const out: PersonaCandidate[] = [];
  const excerpt = truncate(turn.text, MAX_EXCERPT_CHARS);

  for (const def of BUCKET_PATTERNS) {
    if (def.regex.test(turn.text)) {
      out.push({
        sessionId: turn.sessionId,
        userTurnIndex: turn.userTurnIndex,
        excerpt,
        bucket: def.bucket,
        patternKey: def.patternKey,
      });
    }
  }

  // Project-specific augmentation — the project name itself (and its
  // lowercase tokens) is the strongest project-specific signal. A
  // mention of "chat-arch" or "shopforge" in a user turn ALMOST always
  // means the user is referring to the current project. We dedupe
  // against the catalogue's `this-project` hit so a turn with both
  // doesn't get two project-specific rows.
  if (!out.some((c) => c.bucket === 'project-specific')) {
    const lowered = turn.text.toLowerCase();
    for (const token of projectNameTokens) {
      if (token.length < 4) continue; // skip 1-3 char tokens — too noisy
      if (lowered.includes(token)) {
        out.push({
          sessionId: turn.sessionId,
          userTurnIndex: turn.userTurnIndex,
          excerpt,
          bucket: 'project-specific',
          patternKey: 'project-name-mention',
        });
        break;
      }
    }
  }

  // Voice — terse + verbose by length. One emission per turn at most;
  // the bucket cap downstream prevents the LLM stage from drowning in
  // hundreds of short pings.
  if (turn.text.length <= 30) {
    out.push({
      sessionId: turn.sessionId,
      userTurnIndex: turn.userTurnIndex,
      excerpt,
      bucket: 'voice',
      patternKey: 'terse',
    });
  } else if (turn.text.length >= 1200) {
    out.push({
      sessionId: turn.sessionId,
      userTurnIndex: turn.userTurnIndex,
      excerpt,
      bucket: 'voice',
      patternKey: 'verbose',
    });
  }

  return out;
}

/** Tokenize a project displayName for project-specific matching. */
function projectNameTokens(displayName: string): readonly string[] {
  return displayName
    .toLowerCase()
    .split(/[\s\-_./\\]+/)
    .filter((t) => t.length > 0);
}

/**
 * Sample the most recent `maxN` sessions for one project. Stable: sort
 * by updatedAt desc, take prefix. When the project has fewer sessions
 * than the cap, returns everything.
 */
function sampleRecentSessions(
  sessionIds: readonly string[],
  sessionById: Map<string, UnifiedSessionEntry>,
  maxN: number,
): readonly UnifiedSessionEntry[] {
  const entries: UnifiedSessionEntry[] = [];
  for (const sid of sessionIds) {
    const e = sessionById.get(sid);
    if (e !== undefined) entries.push(e);
  }
  entries.sort((a, b) => {
    const av = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
    const bv = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
    return bv - av;
  });
  return entries.slice(0, maxN);
}

/**
 * Cap each bucket to `MAX_CANDIDATES_PER_BUCKET`. Keeps high-recency
 * candidates first so the LLM stage sees the most representative recent
 * signal. Returns the bucketed map for one project.
 */
function capCandidatesByBucket(
  raw: readonly PersonaCandidate[],
  sessionUpdatedAt: Map<string, number>,
): Record<PersonaBucket, readonly PersonaCandidate[]> {
  const buckets: Record<PersonaBucket, PersonaCandidate[]> = {
    'role-expertise': [],
    preferences: [],
    'project-specific': [],
    'working-rhythm': [],
    frictions: [],
    voice: [],
  };
  for (const c of raw) buckets[c.bucket].push(c);
  for (const k of Object.keys(buckets) as PersonaBucket[]) {
    buckets[k].sort((a, b) => {
      const av = sessionUpdatedAt.get(a.sessionId) ?? 0;
      const bv = sessionUpdatedAt.get(b.sessionId) ?? 0;
      return bv - av;
    });
    buckets[k] = buckets[k].slice(0, MAX_CANDIDATES_PER_BUCKET);
  }
  return buckets;
}

export async function buildPersonaCandidatesFile(
  manifest: SessionManifest,
  options: BuildPersonaCandidatesOptions,
): Promise<BuildPersonaCandidatesResult> {
  const t0 = Date.now();
  const concurrency = options.ioConcurrency ?? DEFAULT_IO_CONCURRENCY;
  const maxSessions = THRESHOLDS.persona.maxSessionsForCorpus;

  // Index manifest sessions by id for O(1) project→session lookup.
  const sessionById = new Map<string, UnifiedSessionEntry>();
  const sessionUpdatedAt = new Map<string, number>();
  for (const e of manifest.sessions) {
    sessionById.set(e.id, e);
    if (typeof e.updatedAt === 'number') {
      sessionUpdatedAt.set(e.id, e.updatedAt);
    }
  }

  const perProject: PersonaCandidateProject[] = [];
  let totalCandidates = 0;

  for (const project of options.projects) {
    const sampled = sampleRecentSessions(
      project.sessionIds,
      sessionById,
      maxSessions,
    );
    if (sampled.length === 0) {
      perProject.push({
        projectId: project.id,
        projectName: project.displayName,
        sessionsTotal: project.sessionIds.length,
        sessionsSampled: 0,
        sessionsWithCandidates: 0,
        earliestSampledAt: null,
        latestSampledAt: null,
        candidatesByBucket: {
          'role-expertise': [],
          preferences: [],
          'project-specific': [],
          'working-rhythm': [],
          frictions: [],
          voice: [],
        },
      });
      continue;
    }

    const nameTokens = projectNameTokens(project.displayName);

    const perSessionTurns = await parallelMap(
      sampled,
      concurrency,
      (entry) => readUserTurns(entry, options.outDir),
    );

    const rawCandidates: PersonaCandidate[] = [];
    let sessionsWithCandidates = 0;
    let earliest: number | null = null;
    let latest: number | null = null;
    for (let i = 0; i < sampled.length; i += 1) {
      const entry = sampled[i] as UnifiedSessionEntry;
      if (typeof entry.updatedAt === 'number') {
        earliest = earliest === null ? entry.updatedAt : Math.min(earliest, entry.updatedAt);
        latest = latest === null ? entry.updatedAt : Math.max(latest, entry.updatedAt);
      }
      const turns = perSessionTurns[i] ?? [];
      let hitCount = 0;
      for (const turn of turns) {
        const matches = matchTurn(turn, nameTokens);
        if (matches.length > 0) {
          hitCount += matches.length;
          rawCandidates.push(...matches);
        }
      }
      if (hitCount > 0) sessionsWithCandidates += 1;
    }

    const capped = capCandidatesByBucket(rawCandidates, sessionUpdatedAt);
    const cappedCount = Object.values(capped).reduce((n, arr) => n + arr.length, 0);
    totalCandidates += cappedCount;

    perProject.push({
      projectId: project.id,
      projectName: project.displayName,
      sessionsTotal: project.sessionIds.length,
      sessionsSampled: sampled.length,
      sessionsWithCandidates,
      earliestSampledAt: earliest,
      latestSampledAt: latest,
      candidatesByBucket: capped,
    });
  }

  logger.info(
    `analysis: persona-candidates — ${perProject.length} projects, ${totalCandidates} candidates, ${Date.now() - t0}ms`,
  );

  const file: PersonaCandidatesFile = {
    version: 1,
    generatedAt: options.now,
    heuristicVersion: PERSONA_HEURISTIC_VERSION,
    thresholds: {
      minSessionsForGeneration: THRESHOLDS.persona.minSessionsForGeneration,
      maxSessionsForCorpus: THRESHOLDS.persona.maxSessionsForCorpus,
    },
    projects: perProject,
  };

  return {
    file,
    projectsAnalyzed: perProject.length,
    candidatesTotal: totalCandidates,
  };
}
