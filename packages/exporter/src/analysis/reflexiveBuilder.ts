/**
 * Reflexive-lens builder — Phase 1 Wave 3 (Stream F, task 6).
 *
 * Detects "touched chat-arch" sessions and runs them through the pure
 * `computeReflexive` kernel as a 1-NN matched-pair contrast against the
 * non-touched control pool. The kernel does the math (E-value,
 * Wilson-style CI, etc.); this module is the I/O + covariate-extraction
 * shell.
 *
 * Treated set rule:
 *   - The session's `cwd` resolves to a chat-arch repo (path contains
 *     `chat-arch` or the project root, case-insensitive), OR
 *   - The transcript contains tool calls referencing chat-arch viewer
 *     paths or the `chat-answer` skill.
 *
 * Covariates: built from `THRESHOLDS.matching.covariates` — strictly
 * PRE-TREATMENT (project age, prior-7d session count, first-user-turn
 * length, project-id hash bucket, day/hour). `filesEdited` /
 * `toolCallDepth` are EXCLUDED (collider bias on the "touched chat-arch
 * viewer" treatment).
 *
 * Output: `analysis/reflexive.json`. Atomic write.
 */

import { atomicWriteJsonSync as atomicWriteJson } from '../lib/atomicWrite.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CompositeOutcomesFile,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  computeReflexive,
  THRESHOLDS,
  type ReflexiveEntry,
  type ReflexiveResult,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';

export interface BuildReflexiveOptions {
  outDir: string;
  now: number;
  /**
   * Hint string used to detect chat-arch-touch on `cwd`. Defaults to
   * `'chat-arch'` (matches the repo name); a test can override.
   */
  repoHint?: string;
  /** First-user-turn length lookup (one of the covariates). Optional;
   *  callers populate from a prior read pass to avoid re-walking
   *  transcripts here. When absent, the covariate falls back to 0. */
  firstUserTurnLen?: ReadonlyMap<string, number>;
}

export interface ReflexiveFile {
  version: 1;
  generatedAt: number;
  result: ReflexiveResult;
  methodology: {
    covariates: readonly string[];
    notes: string;
  };
}

export interface BuildReflexiveResult {
  file: ReflexiveFile;
  nTreated: number;
  nControl: number;
}

// atomicWriteJson is now the shared atomicWriteJsonSync helper from
// ../lib/atomicWrite.js (aliased on import) — consolidated per DN3.

async function loadComposite(outDir: string): Promise<CompositeOutcomesFile | null> {
  try {
    const raw = await readFile(
      path.join(outDir, 'analysis', 'composite-outcomes.json'),
      'utf8',
    );
    return JSON.parse(raw) as CompositeOutcomesFile;
  } catch {
    return null;
  }
}

/**
 * 32-bit FNV-1a hash → integer in [0, k). Deterministic + cheap.
 * Used for the `projectIdHash%K` covariate.
 */
function projectHashBucket(projectId: string, k: number): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < projectId.length; i += 1) {
    h ^= projectId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % k;
}

/**
 * "Touched chat-arch" detector. Stage 1: cwd contains the hint
 * substring. Stage 2: transcript contains a tool_use referencing
 * `chat-arch` repo paths or the `chat-answer` skill. The cwd check
 * is the cheap+high-precision signal; the transcript scan catches
 * the case where the user was in a *different* project but ran the
 * chat-arch viewer or skill from there.
 */
async function touchedChatArch(
  entry: UnifiedSessionEntry,
  outDir: string,
  repoHint: string,
): Promise<boolean> {
  const lcHint = repoHint.toLowerCase();
  if (typeof entry.cwd === 'string' && entry.cwd.toLowerCase().includes(lcHint)) {
    return true;
  }
  if (entry.project !== undefined && entry.project.toLowerCase().includes(lcHint)) {
    return true;
  }
  // Stage 2: scan transcript for tool calls referencing the project.
  // Cheap surface-form match against the raw transcript text — the
  // transcript is at most a few MB; this is one substring search per
  // session and avoids JSON-parsing every line.
  if (entry.transcriptPath === undefined) return false;
  const baseDir = path.resolve(outDir);
  const abs = path.resolve(baseDir, entry.transcriptPath);
  const rel = path.relative(baseDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    const raw = await readFile(abs, 'utf8');
    const lc = raw.toLowerCase();
    if (lc.includes(lcHint)) return true;
    if (lc.includes('chat-answer')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Pre-treatment-only covariate vector. Mirrors `THRESHOLDS.matching.covariates`
 * exactly. Returns null-safe finite numbers for the kernel's euclidean.
 */
function buildCovariates(
  entry: UnifiedSessionEntry,
  ctx: {
    projectAgeDays: number;
    prior7dCount: number;
    firstUserTurnLen: number;
  },
): readonly number[] {
  const startedAt = typeof entry.startedAt === 'number' ? entry.startedAt : 0;
  const projectId = entry.projectId ?? entry.project ?? '*';
  const date = new Date(startedAt);
  const dow = date.getUTCDay();
  const hod = date.getUTCHours();
  const k = THRESHOLDS.matching.projectIdBuckets;
  return [
    Math.log(Math.max(0, ctx.projectAgeDays) + 1),
    Math.log(Math.max(0, ctx.prior7dCount) + 1),
    Math.log(Math.max(0, ctx.firstUserTurnLen) + 1),
    projectHashBucket(projectId, k),
    dow,
    hod,
  ];
}

/**
 * Compute pre-treatment context per session: project age in days
 * (this session's startedAt minus the earliest session for the same
 * projectId), prior-7d session count (count of sessions for the same
 * projectId within 7d before this session's startedAt). O(N log N) per
 * grouping pass.
 */
function buildContextMap(
  sessions: readonly UnifiedSessionEntry[],
): Map<string, { projectAgeDays: number; prior7dCount: number }> {
  const out = new Map<string, { projectAgeDays: number; prior7dCount: number }>();
  const byProject = new Map<string, UnifiedSessionEntry[]>();
  for (const s of sessions) {
    const key = s.projectId ?? s.project ?? '*';
    const list = byProject.get(key);
    if (list === undefined) byProject.set(key, [s]);
    else list.push(s);
  }
  const SEVEN_DAYS_MS = 7 * 86_400_000;
  for (const group of byProject.values()) {
    group.sort((a, b) => a.startedAt - b.startedAt);
    const firstStart = group[0]?.startedAt ?? 0;
    for (const s of group) {
      const ageMs = s.startedAt - firstStart;
      const projectAgeDays = Math.max(0, ageMs / 86_400_000);
      // Prior-7d count: number of group members with startedAt in
      // [s.startedAt - 7d, s.startedAt). Linear scan; the per-project
      // cohort sizes are small enough that we don't need a binary
      // search here.
      let prior7dCount = 0;
      for (const other of group) {
        if (other === s) continue;
        const dt = s.startedAt - other.startedAt;
        if (dt > 0 && dt <= SEVEN_DAYS_MS) prior7dCount += 1;
      }
      out.set(s.id, { projectAgeDays, prior7dCount });
    }
  }
  return out;
}

export async function buildReflexiveFile(
  manifest: SessionManifest,
  options: BuildReflexiveOptions,
): Promise<BuildReflexiveResult> {
  const t0 = Date.now();
  const composite = await loadComposite(options.outDir);
  if (composite === null) {
    logger.warn(
      'reflexive: composite-outcomes.json missing — emitting empty reflexive sidecar',
    );
    const empty: ReflexiveFile = {
      version: 1,
      generatedAt: options.now,
      result: {
        pairs: [],
        pTreated: 0,
        pControl: 0,
        meanDelta: 0,
        ci: { low: -1, high: 1 },
        eValueCIBound: null,
        eValueStatus: 'ci-straddles-null',
        nTreated: 0,
        nControl: 0,
        mcnemarP: null,
        mcnemarMethod: 'undefined',
        discordantCount: 0,
      },
      methodology: {
        covariates: [...THRESHOLDS.matching.covariates],
        notes:
          'Pre-treatment covariates only. filesEdited / toolCallDepth EXCLUDED (collider bias). Descriptive contrast, not causal.',
      },
    };
    atomicWriteJson(
      path.join(options.outDir, 'analysis', 'reflexive.json'),
      empty,
    );
    return { file: empty, nTreated: 0, nControl: 0 };
  }

  const repoHint = options.repoHint ?? 'chat-arch';
  const compositeById = new Map(
    composite.outcomes.map((o) => [o.sessionId, o] as const),
  );
  // Restrict to sessions present in BOTH the manifest and the composite
  // sidecar — that ensures every reflexive entry has a real composite
  // score to evaluate.
  const eligible = manifest.sessions.filter((s) => compositeById.has(s.id));
  if (eligible.length === 0) {
    logger.info('reflexive: no eligible sessions (composite sidecar empty for manifest)');
  }

  // Detect treated set in parallel — substring scan is cheap; can
  // saturate I/O on large transcripts.
  const touchedFlags = await Promise.all(
    eligible.map((s) => touchedChatArch(s, options.outDir, repoHint)),
  );
  const touchedSet = new Set<string>();
  for (let i = 0; i < eligible.length; i += 1) {
    if (touchedFlags[i] === true) {
      const e = eligible[i] as UnifiedSessionEntry;
      touchedSet.add(e.id);
    }
  }

  // Pre-treatment context for every session (project-age + prior-7d).
  const ctxMap = buildContextMap(eligible);
  const firstUserTurnLen = options.firstUserTurnLen;

  const entries: ReflexiveEntry[] = eligible.map((e) => {
    const composite = compositeById.get(e.id);
    // compositeById has e.id by construction (eligible filter).
    return {
      sessionId: e.id,
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
      composite: composite as NonNullable<typeof composite>,
    };
  });

  const result = computeReflexive(entries, touchedSet, (entry) => {
    const e = manifest.sessions.find((m) => m.id === entry.sessionId);
    if (e === undefined) return [0, 0, 0, 0, 0, 0];
    const ctx = ctxMap.get(e.id) ?? { projectAgeDays: 0, prior7dCount: 0 };
    const len = firstUserTurnLen?.get(e.id) ?? 0;
    return buildCovariates(e, {
      projectAgeDays: ctx.projectAgeDays,
      prior7dCount: ctx.prior7dCount,
      firstUserTurnLen: len,
    });
  });

  const file: ReflexiveFile = {
    version: 1,
    generatedAt: options.now,
    result,
    methodology: {
      covariates: [...THRESHOLDS.matching.covariates],
      notes:
        'Pre-treatment covariates only. filesEdited / toolCallDepth EXCLUDED (collider bias). Descriptive contrast, not causal.',
    },
  };
  atomicWriteJson(
    path.join(options.outDir, 'analysis', 'reflexive.json'),
    file,
  );

  logger.info(
    `reflexive: nTreated=${result.nTreated}, nControl=${result.nControl}, ` +
      `meanDelta=${result.meanDelta.toFixed(3)}, ` +
      `eValue=${result.eValueCIBound === null ? 'null' : result.eValueCIBound.toFixed(2)} ` +
      `(${result.eValueStatus}), ${Date.now() - t0}ms`,
  );

  return { file, nTreated: result.nTreated, nControl: result.nControl };
}
