// Tests for the Phase Rev3-E E4+E5 applied-rule watcher kernel.
//
// Each closure path gets at least one positive case + one boundary
// case. The kernel is pure (no DB, no clock — `now` is injected), so
// every assertion is a deterministic value comparison.

import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from './thresholds.js';
import {
  evaluateAppliedPatternWatcher,
  type WatcherInput,
  type WatcherNarrativeLike,
  type WatcherPatternLike,
  type WatcherSessionLike,
} from './applyWatcher.js';

const MS_PER_DAY = 86_400_000;

function pattern(overrides: Partial<WatcherPatternLike> = {}): WatcherPatternLike {
  return {
    id: 'pattern_p1',
    projectId: 'p1',
    encodedAt: new Date('2026-04-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function session(
  daysAfterEncoded: number,
  overrides: Partial<WatcherSessionLike> = {},
): WatcherSessionLike {
  const t = Date.parse('2026-04-01T00:00:00Z') + daysAfterEncoded * MS_PER_DAY;
  return {
    id: `s_${daysAfterEncoded}`,
    startedAt: t,
    updatedAt: t,
    projectId: 'p1',
    ...overrides,
  };
}

function narrative(
  daysAfterEncoded: number,
  sentiment: WatcherNarrativeLike['sentiment'],
  overrides: Partial<WatcherNarrativeLike> = {},
): WatcherNarrativeLike {
  const t = Date.parse('2026-04-01T00:00:00Z') + daysAfterEncoded * MS_PER_DAY;
  return {
    id: `n_${daysAfterEncoded}_${sentiment}`,
    projectId: 'p1',
    generatedAt: new Date(t).toISOString(),
    sentiment,
    ...overrides,
  };
}

function now(daysAfterEncoded: number): number {
  return Date.parse('2026-04-01T00:00:00Z') + daysAfterEncoded * MS_PER_DAY;
}

describe('evaluateAppliedPatternWatcher', () => {
  describe('open (no signal yet)', () => {
    it('returns open when zero post-application sessions + zero narratives + within window', () => {
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [],
        projectNarratives: [],
        now: now(1),
      });
      expect(result.kind).toBe('open');
    });

    it('returns open with < N sessions and recent activity', () => {
      const sessionCount = THRESHOLDS.appliedRuleWatcher.watcherSessionsN - 1;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: sessionCount }, (_, i) =>
          session(i + 1),
        ),
        projectNarratives: [],
        now: now(sessionCount + 1),
      });
      expect(result.kind).toBe('open');
    });
  });

  describe('holding (N sessions, no recurrence)', () => {
    it('returns holding when exactly N post-application sessions observed', () => {
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: N }, (_, i) => session(i + 1)),
        projectNarratives: [],
        now: now(N + 1),
      });
      expect(result.kind).toBe('holding');
      if (result.kind === 'holding') {
        expect(result.sessionsObserved).toBe(N);
        // Wilson 95% upper bound on failure rate given N=5 with 0
        // observed failures ≈ 0.522. Pin the order-of-magnitude so
        // consumers don't treat 5/5 as 50/50 evidence.
        expect(result.failureRateUpperBound95).toBeGreaterThan(0.4);
        expect(result.failureRateUpperBound95).toBeLessThan(0.6);
      }
    });

    it('failureRateUpperBound95 tightens as sessionsObserved grows', () => {
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const widerN = N + 25;
      const tight = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: widerN }, (_, i) => session(i + 1)),
        projectNarratives: [],
        now: now(widerN + 1),
      });
      expect(tight.kind).toBe('holding');
      if (tight.kind === 'holding') {
        // 30 trials with 0 failures → Wilson upper bound ≈ 0.115.
        expect(tight.failureRateUpperBound95).toBeLessThan(0.2);
      }
    });

    it('returns holding with > N sessions (count never decreases on extra)', () => {
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const extra = N + 3;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: extra }, (_, i) => session(i + 1)),
        projectNarratives: [
          // A POSITIVE narrative doesn't count as recurrence.
          narrative(2, 'positive'),
        ],
        now: now(extra + 1),
      });
      expect(result.kind).toBe('holding');
    });

    it('ignores pre-application sessions when counting', () => {
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [
          session(-5),
          session(-3),
          session(-1),
          ...Array.from({ length: N - 1 }, (_, i) => session(i + 1)),
        ],
        projectNarratives: [],
        now: now(N),
      });
      // N-1 post-application sessions → still open.
      expect(result.kind).toBe('open');
    });
  });

  describe('recurring (negative/mixed narrative after encoding)', () => {
    it('returns recurring on first negative narrative after encoding', () => {
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [session(1), session(2)],
        projectNarratives: [narrative(2, 'negative')],
        now: now(3),
      });
      expect(result.kind).toBe('recurring');
      if (result.kind === 'recurring') {
        expect(result.recurrenceNarrativeId).toBe('n_2_negative');
      }
    });

    it('picks the EARLIEST recurrence when multiple exist', () => {
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [session(1), session(5), session(10)],
        projectNarratives: [
          narrative(10, 'negative'),
          narrative(3, 'mixed'), // earliest
          narrative(7, 'negative'),
        ],
        now: now(11),
      });
      expect(result.kind).toBe('recurring');
      if (result.kind === 'recurring') {
        expect(result.recurrenceNarrativeId).toBe('n_3_mixed');
      }
    });

    it('ignores positive narratives + ignores recurrences from other projects', () => {
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [session(1)],
        projectNarratives: [
          narrative(2, 'positive'),
          narrative(3, 'negative', { projectId: 'OTHER_PROJECT' }),
        ],
        now: now(4),
      });
      expect(result.kind).toBe('open');
    });

    it('treats `neutral` and unknown sentiments as NON-recurring (allow-list)', () => {
      // Stat-rigor iter-1 finding: the original `!== 'positive'`
      // implementation admitted `'neutral'` (the default class for
      // low-signal sessions) as recurrence — would close watchers on
      // ambient noise. The allow-list `['negative', 'mixed']`
      // pins the intent.
      for (const noisy of ['neutral', 'unknown', 'negatve' /* typo */]) {
        const result = evaluateAppliedPatternWatcher({
          pattern: pattern(),
          projectSessions: [session(1)],
          projectNarratives: [narrative(2, noisy)],
          now: now(3),
        });
        expect(result.kind).toBe('open');
      }
    });

    it('ignores recurrences generated BEFORE encoding (pre-existing problem)', () => {
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [session(1)],
        projectNarratives: [narrative(-3, 'negative')],
        now: now(2),
      });
      expect(result.kind).toBe('open');
    });

    it('recurring beats holding (even if N sessions also passed)', () => {
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: N }, (_, i) => session(i + 1)),
        projectNarratives: [narrative(2, 'negative')],
        now: now(N + 1),
      });
      expect(result.kind).toBe('recurring');
    });
  });

  describe('inconclusive — wall-clock timeout', () => {
    it('returns inconclusive after watcherWallClockDays elapsed', () => {
      const T = THRESHOLDS.appliedRuleWatcher.watcherWallClockDays;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [session(1)],
        projectNarratives: [],
        now: now(T),
      });
      expect(result.kind).toBe('inconclusive');
      if (result.kind === 'inconclusive') {
        expect(result.reason).toBe('wall-clock-timeout');
      }
    });

    it('wall-clock timeout beats recurrence (you already missed the window)', () => {
      const T = THRESHOLDS.appliedRuleWatcher.watcherWallClockDays;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [session(1)],
        // A late recurrence happens at the boundary — the wall-clock
        // closure fires first, recording the watch as inconclusive.
        projectNarratives: [narrative(T - 1, 'negative')],
        now: now(T + 1),
      });
      expect(result.kind).toBe('inconclusive');
      if (result.kind === 'inconclusive') {
        expect(result.reason).toBe('wall-clock-timeout');
      }
    });
  });

  describe('inconclusive — project-inactive', () => {
    it('returns inconclusive when no activity for staleProjectDays before reaching N', () => {
      const S = THRESHOLDS.appliedRuleWatcher.staleProjectDays;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        // Only 1 session, 31 days after encoding → daysSinceActivity
        // crosses S=30 next.
        projectSessions: [session(1)],
        projectNarratives: [],
        now: now(S + 5),
      });
      expect(result.kind).toBe('inconclusive');
      if (result.kind === 'inconclusive') {
        expect(result.reason).toBe('project-inactive');
      }
    });

    it('does NOT invalidate via inactivity once N sessions have already passed', () => {
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const S = THRESHOLDS.appliedRuleWatcher.staleProjectDays;
      // All N sessions land in the first few days, then quiet for S+
      // days. The window closed naturally — holding beats inactive.
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: N }, (_, i) => session(i + 1)),
        projectNarratives: [],
        now: now(N + S + 5),
      });
      expect(result.kind).toBe('holding');
    });
  });

  describe('defensive behavior', () => {
    it('returns open on malformed pattern.encodedAt (never throws)', () => {
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern({ encodedAt: 'not-a-date' }),
        projectSessions: [],
        projectNarratives: [],
        now: 1_700_000_000_000,
      });
      expect(result.kind).toBe('open');
    });

    it('skips narratives with malformed generatedAt', () => {
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: [session(1)],
        projectNarratives: [
          narrative(2, 'negative', { generatedAt: 'not-a-date' }),
        ],
        now: now(3),
      });
      // The malformed narrative is dropped → no recurrence found.
      expect(result.kind).toBe('open');
    });

    it('ignores sessions from a different project (projectId mismatch)', () => {
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: N }, (_, i) =>
          session(i + 1, { projectId: 'OTHER_PROJECT' }),
        ),
        projectNarratives: [],
        now: now(N + 1),
      });
      // All sessions belong to OTHER_PROJECT → 0 in-project sessions.
      // No activity → project-inactive after staleProjectDays.
      const stale = THRESHOLDS.appliedRuleWatcher.staleProjectDays;
      if (N + 1 >= stale) {
        expect(result.kind).toBe('inconclusive');
      } else {
        expect(result.kind).toBe('open');
      }
    });

    it('treats sessions with null/undefined projectId as in-scope', () => {
      // SDK rows whose project_id is NULL still count — they're un-
      // assigned but happened on the dev machine. The kernel doesn't
      // assume strict project membership unless `projectId` is set.
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: N }, (_, i) =>
          session(i + 1, { projectId: null }),
        ),
        projectNarratives: [],
        now: now(N + 1),
      });
      expect(result.kind).toBe('holding');
    });
  });

  describe('precedence (closure-path priority)', () => {
    it('wall-clock > recurrence > project-inactive > holding > open', () => {
      const T = THRESHOLDS.appliedRuleWatcher.watcherWallClockDays;
      const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
      // Construct a state that satisfies ALL closure conditions —
      // verify wall-clock wins.
      const result = evaluateAppliedPatternWatcher({
        pattern: pattern(),
        projectSessions: Array.from({ length: N }, (_, i) => session(i + 1)),
        projectNarratives: [narrative(1, 'negative')],
        now: now(T + 5),
      });
      expect(result.kind).toBe('inconclusive');
      if (result.kind === 'inconclusive') {
        expect(result.reason).toBe('wall-clock-timeout');
      }
    });
  });
});

// Type-only test: verify WatcherInput accepts a SessionRow-shaped
// object without coercion (structural typing pays off here).
function _typeCheckWatcherInput(): void {
  const input: WatcherInput = {
    pattern: {
      id: 'p',
      projectId: 'x',
      encodedAt: '2026-01-01T00:00:00Z',
    },
    projectSessions: [{ id: 's', startedAt: 0, updatedAt: 0 }],
    projectNarratives: [],
    now: Date.now(),
  };
  evaluateAppliedPatternWatcher(input);
}
