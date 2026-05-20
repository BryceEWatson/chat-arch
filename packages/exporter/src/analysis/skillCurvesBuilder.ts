/**
 * Phase 3 #9 — skill-curves builder.
 *
 * Reads topic membership from `analysis/topics.json` (Topic[]), buckets
 * each topic's session list by ISO week, and runs Mann-Kendall + BH-FDR
 * via the {@link analyzeSkillCurves} kernel. Emits
 * `analysis/skill-curves.json`.
 *
 * Topics with fewer than `THRESHOLDS.skillCurve.minWeeksPresent` weeks
 * of activity are skipped at the kernel layer (returned as
 * `classification: 'Insufficient'`); the builder excludes those from
 * the output to keep the file lean.
 *
 * The denominator for `askPerActiveSession` is the corpus-wide weekly
 * active-session count, NOT the topic's own session count — that's the
 * "what fraction of weeks am I asking about this topic" view the
 * classifier needs.
 *
 * Node-only — file I/O. Pure stats live in `@chat-arch/analysis`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  SessionManifest,
  Topic,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  analyzeSkillCurves,
  THRESHOLDS,
  type SkillCurvePoint,
  type SkillCurveResult,
  type SkillCurveSeries,
} from '@chat-arch/analysis';
import { logger } from '../lib/logger.js';
import { atomicWriteJson } from '../lib/atomicWrite.js';

export interface SkillCurvesFile {
  version: 1;
  generatedAt: number;
  minWeeksPresent: number;
  bhFdrAlpha: number;
  results: readonly SkillCurveResult[];
}

export interface BuildSkillCurvesOptions {
  outDir: string;
  now: number;
}

export interface BuildSkillCurvesResult {
  file: SkillCurvesFile;
  /** Topics whose series passed `minWeeksPresent`. */
  topicsAnalyzed: number;
  /** Topics in the input that were skipped before the kernel. */
  topicsSkipped: number;
  hasTopicsSidecar: boolean;
}

interface TopicsFileShape {
  generatedAt?: number;
  topics?: readonly Topic[];
}

async function loadTopics(outDir: string): Promise<Topic[] | null> {
  const p = path.join(outDir, 'analysis', 'topics.json');
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TopicsFileShape;
    return [...(parsed.topics ?? [])];
  } catch {
    return null;
  }
}

/**
 * ISO-8601 week label `YYYY-Wxx`. Browser- and Node-portable
 * implementation — follows the ISO definition (week containing the
 * year's first Thursday is week 1, weeks start on Monday).
 */
export function isoWeekLabel(d: Date): string {
  // Copy so we don't mutate caller's date.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Shift to nearest Thursday: current date + 4 - day-of-week
  // (where Sunday=0 → 7).
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week =
    1 +
    Math.round(
      (target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function buildSkillCurvesFile(
  manifest: SessionManifest,
  options: BuildSkillCurvesOptions,
): Promise<BuildSkillCurvesResult> {
  const t0 = Date.now();
  const topics = await loadTopics(options.outDir);
  const hasTopicsSidecar = topics !== null;
  const minWeeksPresent = THRESHOLDS.skillCurve.minWeeksPresent;
  const bhFdrAlpha = THRESHOLDS.skillCurve.bhFdrAlpha;

  if (topics === null) {
    const file: SkillCurvesFile = {
      version: 1,
      generatedAt: options.now,
      minWeeksPresent,
      bhFdrAlpha,
      results: [],
    };
    await atomicWriteJson(
      path.join(options.outDir, 'analysis', 'skill-curves.json'),
      JSON.stringify(file, null, 2) + '\n',
    );
    logger.info(
      `analysis: skill-curves.json — topics.json missing, ${Date.now() - t0}ms`,
    );
    return { file, topicsAnalyzed: 0, topicsSkipped: 0, hasTopicsSidecar };
  }

  // Index sessions by id for quick updatedAt lookup.
  const sessionsById = new Map<string, UnifiedSessionEntry>();
  for (const s of manifest.sessions as readonly UnifiedSessionEntry[]) {
    sessionsById.set(s.id, s);
  }

  // Corpus-wide weekly active-session count.
  const corpusWeekActive = new Map<string, Set<string>>();
  for (const s of sessionsById.values()) {
    if (typeof s.updatedAt !== 'number') continue;
    const w = isoWeekLabel(new Date(s.updatedAt));
    const set = corpusWeekActive.get(w) ?? new Set<string>();
    set.add(s.id);
    corpusWeekActive.set(w, set);
  }

  // Per-topic weekly ask counts.
  const series: SkillCurveSeries[] = [];
  let skipped = 0;
  for (const topic of topics) {
    const askByWeek = new Map<string, number>();
    for (const sid of topic.sessionIds) {
      const s = sessionsById.get(sid);
      if (s === undefined) continue;
      if (typeof s.updatedAt !== 'number') continue;
      const w = isoWeekLabel(new Date(s.updatedAt));
      askByWeek.set(w, (askByWeek.get(w) ?? 0) + 1);
    }
    if (askByWeek.size < minWeeksPresent) {
      skipped += 1;
      continue;
    }
    const points: SkillCurvePoint[] = [...askByWeek.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([week, askCount]) => ({
        week,
        askCount,
        activeSessions: corpusWeekActive.get(week)?.size ?? 0,
      }));
    series.push({
      topicId: topic.id,
      label: topic.displayName,
      points,
    });
  }

  const results = analyzeSkillCurves(series);

  const file: SkillCurvesFile = {
    version: 1,
    generatedAt: options.now,
    minWeeksPresent,
    bhFdrAlpha,
    results,
  };

  await atomicWriteJson(
    path.join(options.outDir, 'analysis', 'skill-curves.json'),
    JSON.stringify(file, null, 2) + '\n',
  );

  const learning = results.filter((r) => r.classification === 'Learning').length;
  const stuck = results.filter((r) => r.classification === 'Stuck-dependent').length;
  logger.info(
    `analysis: skill-curves.json — ${series.length} topics analyzed, ${skipped} skipped (<${minWeeksPresent}w), ${learning} Learning, ${stuck} Stuck-dependent, ${Date.now() - t0}ms`,
  );

  return {
    file,
    topicsAnalyzed: series.length,
    topicsSkipped: skipped,
    hasTopicsSidecar,
  };
}
