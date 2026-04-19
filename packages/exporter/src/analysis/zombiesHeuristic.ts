/**
 * `[R-D7]` zombie classifier — browser-tier heuristic.
 *
 * Thresholds per the revised plan:
 *   - `dormant`  = lastActivity ≥ 30 days ago.
 *   - `zombie`   = dormant AND ≥1 probe session after a gap ≥ 60 days AND
 *                  probe followed by no dense activity (no ≥3 sessions in 14 days).
 *   - otherwise `active`.
 *
 * Probe detection regex (expanded per R-D7):
 *   /re-?evaluate|still (worth|viable|relevant)|revisit|check.?in|status of
 *   |profitability|feasibility|mvp|viable
 *   |worth (building|continuing|pursuing)
 *   |what (do you think|happened to)/i
 *
 * Input: the unified session array + a now-reference (ms). The classifier
 * groups by project (using `inferProject.ts`) and computes lifecycle state.
 * Pure function — no I/O.
 */

import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { inferProject, type InferenceSource } from './inferProject.js';

export const PROBE_REGEX: RegExp =
  /re-?evaluate|still (worth|viable|relevant)|revisit|check.?in|status of|profitability|feasibility|mvp|viable|worth (building|continuing|pursuing)|what (do you think|happened to)/i;

/**
 * Silently-abandoned threshold: a project with `daysSinceLast ≥ SILENT_ZOMBIE_DAYS`
 * is classified zombie even without an explicit probe session. Long-dormant
 * projects with no trailing dense activity get caught here. The probe-with-gap
 * case is still the primary zombie trigger; this is the fallback for abandoned
 * projects whose last activity included no re-evaluation.
 */
export const SILENT_ZOMBIE_DAYS = 180;

export type Classification = 'active' | 'dormant' | 'zombie';

export interface BurstWindow {
  start: number;
  end: number;
  count: number;
}

export interface ZombieProjectEntry {
  id: string;
  displayName: string;
  sessionCount: number;
  firstActiveAt: number;
  lastActiveAt: number;
  daysSinceLast: number;
  classification: Classification;
  probeSessionIds: string[];
  burstWindows: BurstWindow[];
  inferenceSource: InferenceSource;
}

export interface ZombiesFile {
  version: 1;
  tier: 'browser';
  generatedAt: number;
  projects: ZombieProjectEntry[];
}

const MS_PER_DAY = 86_400_000;

/** Classify a single project's session timeline. Exposed for unit tests. */
export function classifyProject(
  sessions: readonly Pick<
    UnifiedSessionEntry,
    'id' | 'startedAt' | 'updatedAt' | 'title' | 'preview'
  >[],
  now: number,
): {
  classification: Classification;
  probeSessionIds: string[];
  burstWindows: BurstWindow[];
  firstActiveAt: number;
  lastActiveAt: number;
  daysSinceLast: number;
} {
  if (sessions.length === 0) {
    return {
      classification: 'active',
      probeSessionIds: [],
      burstWindows: [],
      firstActiveAt: 0,
      lastActiveAt: 0,
      daysSinceLast: 0,
    };
  }

  // Ascending by startedAt.
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const firstActiveAt = sorted[0]!.startedAt;
  const lastActiveAt = sorted[sorted.length - 1]!.updatedAt;
  const daysSinceLast = Math.floor((now - lastActiveAt) / MS_PER_DAY);

  if (daysSinceLast < 30) {
    return {
      classification: 'active',
      probeSessionIds: [],
      burstWindows: computeBurstWindows(sorted),
      firstActiveAt,
      lastActiveAt,
      daysSinceLast,
    };
  }

  // Dormant or zombie. Check for probe sessions after a ≥60-day gap.
  const probeSessionIds: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const s = sorted[i]!;
    // Probe regex match against title OR preview (preview carries first-human text).
    const textToScan = `${s.title}\n${s.preview ?? ''}`;
    if (!PROBE_REGEX.test(textToScan)) continue;

    // Gap before this session: (startedAt - prev.updatedAt) in days.
    if (i === 0) continue; // can't be "after a gap" without a prior
    const prev = sorted[i - 1]!;
    const gapDays = (s.startedAt - prev.updatedAt) / MS_PER_DAY;
    if (gapDays < 60) continue;

    // No dense activity after: no 14-day window containing ≥3 sessions whose
    // window-start is at or after this probe.
    const tail = sorted.slice(i);
    let hasDense = false;
    for (let k = 0; k < tail.length && !hasDense; k += 1) {
      const windowStart = tail[k]!.startedAt;
      let count = 0;
      for (let m = k; m < tail.length; m += 1) {
        if (tail[m]!.startedAt <= windowStart + 14 * MS_PER_DAY) count += 1;
        else break;
      }
      if (count >= 3) hasDense = true;
    }
    if (hasDense) continue;

    probeSessionIds.push(s.id);
  }

  // Zombie classification:
  //   (a) probe-with-gap case (D7 canonical): ≥1 probe session after ≥60-day
  //       gap with no dense follow-up.
  //   (b) silently-abandoned case (R19 F19.4 fallback): daysSinceLast ≥
  //       SILENT_ZOMBIE_DAYS AND no 14-day burst in the trailing
  //       SILENT_ZOMBIE_DAYS window.
  let classification: Classification = probeSessionIds.length > 0 ? 'zombie' : 'dormant';
  if (classification === 'dormant' && daysSinceLast >= SILENT_ZOMBIE_DAYS) {
    const tailCutoff = now - SILENT_ZOMBIE_DAYS * MS_PER_DAY;
    const trailingDense = sorted.some((_, k, arr) => {
      const ws = arr[k]!.startedAt;
      if (ws < tailCutoff) return false;
      let count = 0;
      for (let m = k; m < arr.length; m += 1) {
        if (arr[m]!.startedAt <= ws + 14 * MS_PER_DAY) count += 1;
        else break;
      }
      return count >= 3;
    });
    if (!trailingDense) classification = 'zombie';
  }

  return {
    classification,
    probeSessionIds,
    burstWindows: computeBurstWindows(sorted),
    firstActiveAt,
    lastActiveAt,
    daysSinceLast,
  };
}

/**
 * 14-day rolling windows with ≥3 sessions. Non-overlapping, earliest-wins.
 */
function computeBurstWindows(
  sorted: readonly Pick<UnifiedSessionEntry, 'startedAt'>[],
): BurstWindow[] {
  const out: BurstWindow[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!.startedAt;
    const end = start + 14 * MS_PER_DAY;
    let j = i;
    while (j < sorted.length && sorted[j]!.startedAt <= end) j += 1;
    const count = j - i;
    if (count >= 3) {
      out.push({ start, end: sorted[j - 1]!.startedAt, count });
      i = j; // non-overlapping
    } else {
      i += 1;
    }
  }
  return out;
}

/**
 * Build the per-project zombie entries from a full manifest.
 */
export function buildZombieProjects(
  entries: readonly UnifiedSessionEntry[],
  now: number,
): ZombieProjectEntry[] {
  // Group by inferred project id.
  interface Group {
    id: string;
    displayName: string;
    inferenceSource: InferenceSource;
    sessions: UnifiedSessionEntry[];
  }
  const byId = new Map<string, Group>();

  for (const e of entries) {
    const inf = inferProject(e);
    if (inf === null) continue;
    const existing = byId.get(inf.id);
    if (existing === undefined) {
      byId.set(inf.id, {
        id: inf.id,
        displayName: inf.displayName,
        inferenceSource: inf.inferenceSource,
        sessions: [e],
      });
    } else {
      existing.sessions.push(e);
      // Prefer a more specific inference source: project_field > cwd_basename > title_keyword.
      const rank = (x: InferenceSource): number =>
        x === 'project_field' ? 2 : x === 'cwd_basename' ? 1 : 0;
      if (rank(inf.inferenceSource) > rank(existing.inferenceSource)) {
        existing.inferenceSource = inf.inferenceSource;
      }
    }
  }

  const out: ZombieProjectEntry[] = [];
  for (const g of byId.values()) {
    const cls = classifyProject(g.sessions, now);
    out.push({
      id: g.id,
      displayName: g.displayName,
      sessionCount: g.sessions.length,
      firstActiveAt: cls.firstActiveAt,
      lastActiveAt: cls.lastActiveAt,
      daysSinceLast: cls.daysSinceLast,
      classification: cls.classification,
      probeSessionIds: cls.probeSessionIds,
      burstWindows: cls.burstWindows,
      inferenceSource: g.inferenceSource,
    });
  }

  // Sort: zombies first, then dormant, then active; within each,
  // session-count desc.
  const classRank = (c: Classification): number => (c === 'zombie' ? 0 : c === 'dormant' ? 1 : 2);
  out.sort((a, b) => {
    if (classRank(a.classification) !== classRank(b.classification)) {
      return classRank(a.classification) - classRank(b.classification);
    }
    return b.sessionCount - a.sessionCount;
  });
  return out;
}

export function buildZombiesFile(
  entries: readonly UnifiedSessionEntry[],
  generatedAt: number,
): ZombiesFile {
  return {
    version: 1,
    tier: 'browser',
    generatedAt,
    projects: buildZombieProjects(entries, generatedAt),
  };
}
