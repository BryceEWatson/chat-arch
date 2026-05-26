/**
 * Narrative discovery — spec §4.4, §15, decisions D7, D8, D9, D13.
 *
 * Per-project sentiment-clustered narrative emission. Heuristic only
 * (D7) — no LLM. For each project except `[UNASSIGNED]` (D8 — the
 * pseudo-project does not bear narratives):
 *
 *   1. Score every member session via `sentimentHeuristic.scoreSentiment`
 *      against `title + preview + summary`.
 *   2. Group sessions by sentiment polarity (positive / negative).
 *   3. For each polarity with at least 2 members, emit a single narrative
 *      whose evidence is the top-3 strongest hits.
 *
 * Body text is assembled mechanically from session titles + sentiment
 * markers — never LLM-generated. Result feeds the PROJECTS detail
 * surface (spec §5.1) and PRACTICE → "value leaks" lens (§5.4).
 *
 * Pure. Caller writes the result to `analysis/narratives.json` (D2)
 * and uses `narrativesByProject` to backfill `Project.narrativeIds[]`
 * + `Project.sentiment`.
 */

import type {
  UnifiedSessionEntry,
  Narrative,
  NarrativeEvidence,
  Sentiment,
  Project,
  ProjectSentiment,
} from '@chat-arch/schema';
import { UNASSIGNED_PROJECT_ID, validateNarrative } from '@chat-arch/schema';
import { scoreSentiment } from './sentimentHeuristic.js';

export interface DiscoverNarrativesOptions {
  now?: number;
  /** Minimum cluster size to emit a narrative. Default 2. */
  minClusterSize?: number;
  /** Cap on evidence pills per narrative. Default 3. */
  maxEvidence?: number;
}

export interface DiscoverNarrativesResult {
  narratives: Narrative[];
  /** Map: projectId → narrativeIds[]. */
  narrativesByProject: Map<string, string[]>;
  /** Map: projectId → rolled-up sentiment per spec §4.1. */
  projectSentiment: Map<string, ProjectSentiment>;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function discoverNarratives(
  sessions: readonly UnifiedSessionEntry[],
  projects: readonly Project[],
  options: DiscoverNarrativesOptions = {},
): DiscoverNarrativesResult {
  const now = options.now ?? Date.now();
  const minClusterSize = options.minClusterSize ?? 2;
  const maxEvidence = options.maxEvidence ?? 3;

  const sessionById = new Map<string, UnifiedSessionEntry>();
  for (const s of sessions) sessionById.set(s.id, s);

  const narratives: Narrative[] = [];
  const narrativesByProject = new Map<string, string[]>();
  const projectSentiment = new Map<string, ProjectSentiment>();

  for (const project of projects) {
    if (project.id === UNASSIGNED_PROJECT_ID) {
      // D8: pseudo-project is a parking lot — no narratives.
      narrativesByProject.set(project.id, []);
      projectSentiment.set(project.id, 'neutral');
      continue;
    }

    type Scored = {
      session: UnifiedSessionEntry;
      sentiment: Sentiment;
      strength: number;
    };
    const scored: Scored[] = [];
    for (const sid of project.sessionIds) {
      const s = sessionById.get(sid);
      if (s === undefined) continue;
      const text = [
        s.title,
        s.preview ?? '',
        s.summary ?? '',
        ...(s.userTextSamples ?? []),
      ].join('\n');
      const r = scoreSentiment(text);
      scored.push({
        session: s,
        sentiment: r.sentiment,
        strength: Math.max(r.positiveHits, r.negativeHits),
      });
    }

    const positives = scored.filter((x) => x.sentiment === 'positive');
    const negatives = scored.filter((x) => x.sentiment === 'negative');

    const projectNarrativeIds: string[] = [];

    if (positives.length >= minClusterSize) {
      const n = buildNarrative(project.id, 'positive', positives, maxEvidence, now);
      validateNarrative(n);
      narratives.push(n);
      projectNarrativeIds.push(n.id);
    }
    if (negatives.length >= minClusterSize) {
      const n = buildNarrative(project.id, 'negative', negatives, maxEvidence, now);
      validateNarrative(n);
      narratives.push(n);
      projectNarrativeIds.push(n.id);
    }

    narrativesByProject.set(project.id, projectNarrativeIds);

    let sentiment: ProjectSentiment;
    if (positives.length >= minClusterSize && negatives.length >= minClusterSize) {
      sentiment = 'mixed';
    } else if (positives.length >= minClusterSize) {
      sentiment = 'positive';
    } else if (negatives.length >= minClusterSize) {
      sentiment = 'negative';
    } else {
      sentiment = 'neutral';
    }
    projectSentiment.set(project.id, sentiment);
  }

  return { narratives, narrativesByProject, projectSentiment };
}

function buildNarrative(
  projectId: string,
  sentiment: 'positive' | 'negative',
  scored: ReadonlyArray<{
    session: UnifiedSessionEntry;
    sentiment: Sentiment;
    strength: number;
  }>,
  maxEvidence: number,
  now: number,
): Narrative {
  const sorted = [...scored].sort((a, b) => b.strength - a.strength);
  const sessionIds = sorted.map((x) => x.session.id);
  const evidence: NarrativeEvidence[] = sorted.slice(0, maxEvidence).map((x) => ({
    sessionId: x.session.id,
    excerpt: x.session.title,
  }));

  const title =
    sentiment === 'positive'
      ? `Recurring win pattern across ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}`
      : `Recurring failure pattern across ${sessionIds.length} session${sessionIds.length === 1 ? '' : 's'}`;

  const bodyLines: string[] = [
    sentiment === 'positive'
      ? 'Sessions in this cluster show consistent positive outcome markers (shipped / merged / tests pass / fixed).'
      : 'Sessions in this cluster show consistent negative outcome markers (broken / failed / stuck / abandoned).',
    '',
    'Representative session titles:',
    ...sorted.slice(0, maxEvidence).map((x) => `- ${x.session.title}`),
  ];

  const id = `narr_${projectId}_${sentiment}_${simpleHash(sessionIds.join('|'))}`;
  return {
    id,
    projectId,
    sessionIds,
    sentiment,
    title,
    body: bodyLines.join('\n'),
    evidence,
    generatedAt: isoFromMs(now),
    actionType:
      sentiment === 'positive' ? 'encode-as-pattern' : 'generate-corrective-prompt',
    // Legacy v1 shape — Rev3-B backfill (B5) bumps existing rows to
    // v2 with provenance + confidence populated. Narrative-mining V1
    // (EXPORTER_VERSION 1.7.0) stamps every heuristic emission with
    // `attributedTo: 'deterministic'` so the merge helper + viewer
    // two-tier surface can classify families without reader-side
    // defaulting.
    schemaVersion: 1,
    attributedTo: 'deterministic',
  };
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
