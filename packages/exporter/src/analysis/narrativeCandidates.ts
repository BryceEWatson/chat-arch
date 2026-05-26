/**
 * Stage-1 narrative-candidates writer — per-project deterministic
 * candidate evidence pool. Pure data prep: emits
 * `analysis/narrative-candidates.json`. The Claude Code skill
 * `/mine-narratives` consumes this file in Stage 2 (LLM synthesis)
 * and writes `attributedTo: 'llm-derived'` rows back into the shared
 * `analysis/narratives.json` via the `mergeNarrativeFamilies` helper.
 *
 * Why per-session (not per-user-turn): narratives describe DURABLE
 * project-level themes ("ShopForge ships marketplace integrations
 * weekly"), not user-voice patterns. The unit of evidence is the
 * SESSION — its title + preview + summary + sentiment + outcome
 * markers — not individual user prompts. Personas use per-user-turn
 * because the goal there is to triangulate user-voice patterns from
 * many prompts; narratives use per-session because the goal is to
 * surface session-level themes.
 *
 * Why 4 recency quartiles (not 6 semantic categories): persona-mining
 * uses 6 because the synthesizer needs pre-segmented bucketing into
 * the 6 sections of the persona markdown. Narrative-mining uses 4
 * recency quartiles because the synthesizer needs founding → recent
 * temporal spread to label patterns as "durable across phases" vs
 * "recent — uncertain". The 4-quartile-by-recency strategy mirrors
 * `sampleSessionsStratifiedByRecency` in `personaCandidates.ts`.
 *
 * PII posture: every emitted candidate carries a verbatim session
 * title + preview/summary excerpt. Same surface as
 * `persona-candidates.json` — gitignored under
 * `apps/standalone/public/chat-arch-data/*`.
 */

import type {
  NarrativeBucket,
  NarrativeCandidate,
  NarrativeCandidateProject,
  NarrativeCandidatesFile,
  Project,
  SessionManifest,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { THRESHOLDS, scoreSentiment } from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';

const NUM_QUARTILES = 4;
const BUCKET_ORDER: readonly NarrativeBucket[] = [
  'founding',
  'mid-early',
  'mid-late',
  'recent',
];

/**
 * Bump when the candidate extractor's outcome-marker dictionary or
 * sampling policy changes. Labels the sidecar so the Stage-2 skill can
 * refuse to synthesize against an incompatible candidate format.
 */
export const NARRATIVE_HEURISTIC_VERSION = 1;

const MAX_EXCERPT_CHARS = 280;

/**
 * Outcome-marker dictionary. Used by Stage 2a sub-agents to anchor
 * sentiment-polarization claims ("majority of this theme's supporting
 * sessions ended in `shipped`/`merged` outcomes"). The list is
 * intentionally broad — false positives are filtered by Stage 2a's
 * "≥2 supporting sessions per theme" rule.
 */
const POSITIVE_MARKERS: readonly string[] = [
  'shipped',
  'shipping',
  'merged',
  'merging',
  'landed',
  'landing',
  'passing',
  'passed',
  'fixed',
  'works',
  'working',
  'green',
  'success',
  'complete',
  'completed',
  'done',
  'finished',
];

const NEGATIVE_MARKERS: readonly string[] = [
  'broken',
  'breaks',
  'failing',
  'failed',
  'failure',
  'crash',
  'crashed',
  'crashes',
  'stuck',
  'abandoned',
  'reverted',
  'rolled back',
  'rollback',
  'blocker',
  'blocked',
  'red',
  'error',
  'errored',
];

export interface BuildNarrativeCandidatesOptions {
  now: number;
  /** From `discoverProjects(...)`. Drives bucketing by projectId. */
  projects: readonly Project[];
}

export interface BuildNarrativeCandidatesResult {
  file: NarrativeCandidatesFile;
  projectsAnalyzed: number;
  candidatesTotal: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

/**
 * Lowercased token-membership check for outcome markers. We collapse
 * the multi-word markers (`rolled back`) into the lowercased text
 * directly via `includes` because a stricter tokenizer would miss
 * hyphenated and slashed forms (`pre-shipped`, `rollback/revert`).
 */
function detectMarkers(text: string): readonly string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const m of POSITIVE_MARKERS) {
    if (lower.includes(m)) hits.push(m);
  }
  for (const m of NEGATIVE_MARKERS) {
    if (lower.includes(m)) hits.push(m);
  }
  return hits;
}

/**
 * Stratified-by-recency sample: split the project's session list into
 * 4 quartile buckets (founding → recent) and return them. Inherits the
 * sampling logic from `personaCandidates.sampleSessionsStratifiedByRecency`
 * — when the project's session count exceeds the corpus cap, we draw
 * `maxN / 4` from each bucket; otherwise we return all sessions split
 * by quartile.
 *
 * Returns one array per bucket (in BUCKET_ORDER order).
 */
function bucketSessionsByRecency(
  sessionIds: readonly string[],
  sessionById: Map<string, UnifiedSessionEntry>,
  maxN: number,
): readonly (readonly UnifiedSessionEntry[])[] {
  const entries: UnifiedSessionEntry[] = [];
  for (const sid of sessionIds) {
    const e = sessionById.get(sid);
    if (e !== undefined) entries.push(e);
  }
  if (entries.length === 0) {
    return [[], [], [], []];
  }

  // Ascending sort so quartiles run founding → recent.
  entries.sort((a, b) => {
    const av = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
    const bv = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
    return av - bv;
  });

  const perBucket = Math.floor(maxN / NUM_QUARTILES);
  const out: UnifiedSessionEntry[][] = [];
  const cap = entries.length > maxN ? perBucket : Number.POSITIVE_INFINITY;
  for (let q = 0; q < NUM_QUARTILES; q += 1) {
    const start = Math.floor((q * entries.length) / NUM_QUARTILES);
    const end = Math.floor(((q + 1) * entries.length) / NUM_QUARTILES);
    const bucket = entries.slice(start, end);
    // Within each bucket prefer the bucket's most-recent — Stage-2
    // sub-agents anchor on "newest in this bucket carries the most signal".
    bucket.sort((a, b) => {
      const av = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
      const bv = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
      return bv - av;
    });
    const finiteCap = Number.isFinite(cap) ? cap : bucket.length;
    out.push(bucket.slice(0, finiteCap));
  }
  return out;
}

/**
 * Build one project's candidate set from its bucketed sessions. Cap
 * each bucket to `THRESHOLDS.narrative.maxCandidatesPerRecencyBucket`.
 */
function buildProjectCandidates(
  project: Project,
  bucketedSessions: readonly (readonly UnifiedSessionEntry[])[],
): {
  perBucket: Record<NarrativeBucket, readonly NarrativeCandidate[]>;
  sessionsSampled: number;
  sessionsWithCandidates: number;
  earliest: number | null;
  latest: number | null;
} {
  const cap = THRESHOLDS.narrative.maxCandidatesPerRecencyBucket;
  const perBucket: Record<NarrativeBucket, NarrativeCandidate[]> = {
    founding: [],
    'mid-early': [],
    'mid-late': [],
    recent: [],
  };

  let sessionsSampled = 0;
  let sessionsWithCandidates = 0;
  let earliest: number | null = null;
  let latest: number | null = null;

  for (let q = 0; q < NUM_QUARTILES; q += 1) {
    const bucket = BUCKET_ORDER[q] as NarrativeBucket;
    const entries = bucketedSessions[q] ?? [];
    for (const s of entries) {
      sessionsSampled += 1;
      if (typeof s.updatedAt === 'number') {
        earliest = earliest === null ? s.updatedAt : Math.min(earliest, s.updatedAt);
        latest = latest === null ? s.updatedAt : Math.max(latest, s.updatedAt);
      }
      const title = s.title;
      const preview = (s.preview ?? '').trim();
      const summary = (s.summary ?? '').trim();
      const text = [title, preview, summary].filter((t) => t.length > 0).join('\n');
      // Skip sessions with no usable text — they contribute nothing.
      if (text.length === 0) continue;
      const sentiment = scoreSentiment(text);
      const markers = detectMarkers(text);
      sessionsWithCandidates += 1;
      const candidate: NarrativeCandidate = {
        sessionId: s.id,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
        title,
        previewExcerpt: truncate(preview, MAX_EXCERPT_CHARS),
        summaryExcerpt: truncate(summary, MAX_EXCERPT_CHARS),
        sentimentPolarity: sentiment.sentiment,
        sentimentStrength: Math.max(sentiment.positiveHits, sentiment.negativeHits),
        outcomeMarkers: markers,
      };
      if (perBucket[bucket].length < cap) {
        perBucket[bucket].push(candidate);
      }
    }
  }

  return {
    perBucket,
    sessionsSampled,
    sessionsWithCandidates,
    earliest,
    latest,
  };
}

export function buildNarrativeCandidatesFile(
  manifest: SessionManifest,
  options: BuildNarrativeCandidatesOptions,
): BuildNarrativeCandidatesResult {
  const t0 = Date.now();
  const maxSessions = THRESHOLDS.narrative.maxSessionsForCorpus;

  const sessionById = new Map<string, UnifiedSessionEntry>();
  for (const e of manifest.sessions) {
    sessionById.set(e.id, e);
  }

  const perProject: NarrativeCandidateProject[] = [];
  let totalCandidates = 0;

  for (const project of options.projects) {
    const bucketed = bucketSessionsByRecency(
      project.sessionIds,
      sessionById,
      maxSessions,
    );
    const result = buildProjectCandidates(project, bucketed);
    const bucketCount = Object.values(result.perBucket).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    totalCandidates += bucketCount;
    perProject.push({
      projectId: project.id,
      projectName: project.displayName,
      sessionsTotal: project.sessionIds.length,
      sessionsSampled: result.sessionsSampled,
      sessionsWithCandidates: result.sessionsWithCandidates,
      earliestSampledAt: result.earliest,
      latestSampledAt: result.latest,
      candidatesByBucket: result.perBucket,
    });
  }

  logger.info(
    `analysis: narrative-candidates — ${perProject.length} projects, ${totalCandidates} candidates, ${Date.now() - t0}ms`,
  );

  const file: NarrativeCandidatesFile = {
    version: 1,
    heuristicVersion: NARRATIVE_HEURISTIC_VERSION,
    generatedAt: options.now,
    thresholds: {
      minSessionsForLlm: THRESHOLDS.narrative.minSessionsForLlm,
      maxSessionsForCorpus: THRESHOLDS.narrative.maxSessionsForCorpus,
      maxLlmUsdPerProject: THRESHOLDS.narrative.maxLlmUsdPerProject,
      evidenceMinPerNarrative: THRESHOLDS.narrative.evidenceMinPerNarrative,
    },
    projects: perProject,
  };

  return {
    file,
    projectsAnalyzed: perProject.length,
    candidatesTotal: totalCandidates,
  };
}
