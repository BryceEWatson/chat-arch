/**
 * Phase Rev3-E E6 — gate test.
 *
 * Plan exit criterion for Phase Rev3-E:
 *   "an applied pattern visibly closes its watcher within the
 *    window; bypass path produces an auditable Pattern row."
 *
 * What this test composes (the full Closure C round-trip on top of
 * the C1+C2+C4 SQLite substrate and E1+E2+E3+E4+E5 surfaces):
 *
 *   1. **Encode a positive narrative as a Pattern**, both with and
 *      without the falsifier-skip override (E3 surface). Assert the
 *      persisted row carries `falsifierStatus: 'skipped-by-user'`
 *      when the override fired, and `undefined` when it didn't (the
 *      "not yet falsified" sentinel reserved for Rev3-F's curator
 *      to populate).
 *   2. **Walk the watcher kernel** (E4+E5) through three closure
 *      paths against a synthetic project session/narrative stream:
 *      a. open → holding (N sessions pass without recurrence)
 *      b. open → recurring (negative narrative fires after encoding)
 *      c. open → inconclusive (wall-clock timeout)
 *   3. **Assert the holding verdict carries the Wilson upper bound**
 *      so consumers don't treat 5/5 as 50/50 evidence (stat-rigor
 *      iter-1 finding on PR #81).
 *
 * Why integration-level (not just SDK): the gate stitches together
 * the E3 schema (Pattern.falsifierStatus), the E4+E5 kernel
 * (WatcherVerdict), and the existing buildPatternFromNarrative
 * helper. Each layer has unit tests; this proves they compose.
 */
import { describe, expect, it } from 'vitest';

import { THRESHOLDS } from '@chat-arch/analysis';
import { evaluateAppliedPatternWatcher } from '@chat-arch/analysis';

import { buildPatternFromNarrative } from '../../../../packages/viewer/src/data/narrativeActions.js';

const MS_PER_DAY = 86_400_000;

function fixtureNarrative(): Parameters<typeof buildPatternFromNarrative>[0] {
  return {
    id: 'narr-gate-1',
    projectId: 'p-gate',
    sentiment: 'positive',
    actionType: 'encode-as-pattern',
    title: 'Always reach for the test harness first',
    body: 'When debugging a flaky integration test, prefer reading the harness over re-running.',
    evidence: [
      {
        sessionId: 's-evid-0',
        sessionSource: 'cli-direct',
        excerpt: 'fixing flake',
      },
    ],
    generatedAt: '2026-04-01T00:00:00Z',
    schemaVersion: 1,
  };
}

describe('Rev3-E E6 — Closure C gate (encode → watch → close)', () => {
  describe('encode-as-pattern (E3)', () => {
    it('omits falsifierStatus on the default path (Rev3-F will populate later)', () => {
      const pattern = buildPatternFromNarrative(fixtureNarrative(), false);
      expect(pattern.falsifierStatus).toBeUndefined();
    });

    it('writes `skipped-by-user` when the override checkbox fires', () => {
      const pattern = buildPatternFromNarrative(fixtureNarrative(), false, {
        falsifierOverride: true,
      });
      expect(pattern.falsifierStatus).toBe('skipped-by-user');
    });

    it('preserves the `appendedToClaudeMd` flag independent of the override', () => {
      const both = buildPatternFromNarrative(fixtureNarrative(), true, {
        falsifierOverride: true,
      });
      expect(both.appendedToClaudeMd).toBe(true);
      expect(both.falsifierStatus).toBe('skipped-by-user');
    });
  });

  describe('watcher round-trip (E4+E5)', () => {
    const baseTime = Date.parse('2026-04-01T00:00:00Z');
    const pattern = {
      id: 'pattern_narr-gate-1',
      projectId: 'p-gate',
      encodedAt: new Date(baseTime).toISOString(),
    };
    const N = THRESHOLDS.appliedRuleWatcher.watcherSessionsN;
    const T = THRESHOLDS.appliedRuleWatcher.watcherWallClockDays;

    function sessionAtDay(d: number) {
      return {
        id: `s-day${d}`,
        startedAt: baseTime + d * MS_PER_DAY,
        updatedAt: baseTime + d * MS_PER_DAY,
        projectId: 'p-gate',
      };
    }

    it('closure path A — open → holding (visibly closes within the window)', () => {
      // Day 1 immediately after encoding: 0 post-application sessions
      // → still open. The watcher hasn't accumulated signal yet.
      const day1 = evaluateAppliedPatternWatcher({
        pattern,
        projectSessions: [],
        projectNarratives: [],
        now: baseTime + 1 * MS_PER_DAY,
      });
      expect(day1.kind).toBe('open');

      // After N sessions land within the window with no recurrence,
      // the watcher closes as `holding`. This is the plan's
      // "Non-recurrence → confidence-up on the original pattern."
      const sessions = Array.from({ length: N }, (_, i) =>
        sessionAtDay(i + 1),
      );
      const dayN = evaluateAppliedPatternWatcher({
        pattern,
        projectSessions: sessions,
        projectNarratives: [],
        now: baseTime + (N + 1) * MS_PER_DAY,
      });
      expect(dayN.kind).toBe('holding');
      if (dayN.kind === 'holding') {
        expect(dayN.sessionsObserved).toBe(N);
        // Wilson upper bound surfaced so consumers don't overclaim
        // (stat-rigor iter-1 fix). At default N=5 the bound is ~0.52.
        expect(dayN.failureRateUpperBound95).toBeGreaterThan(0);
        expect(dayN.failureRateUpperBound95).toBeLessThan(1);
      }
    });

    it('closure path B — open → recurring (RECURRING_AFTER_APPLIED is emittable)', () => {
      const recurringNarrative = {
        id: 'narr-recurrence-1',
        projectId: 'p-gate',
        generatedAt: new Date(baseTime + 3 * MS_PER_DAY).toISOString(),
        sentiment: 'negative' as const,
      };
      const verdict = evaluateAppliedPatternWatcher({
        pattern,
        projectSessions: [sessionAtDay(1), sessionAtDay(2)],
        projectNarratives: [recurringNarrative],
        now: baseTime + 4 * MS_PER_DAY,
      });
      expect(verdict.kind).toBe('recurring');
      if (verdict.kind === 'recurring') {
        // The verdict carries enough info for the curator (Rev3-F)
        // to format a RECURRING_AFTER_APPLIED Narrative linking back
        // to the offending narrative.
        expect(verdict.recurrenceNarrativeId).toBe('narr-recurrence-1');
        expect(verdict.recurrenceGeneratedAt).toBe(
          recurringNarrative.generatedAt,
        );
      }
    });

    it('closure path C — open → inconclusive on wall-clock timeout (E5)', () => {
      // Plan §"Three closures": wall-clock timeout emits a low-
      // priority WATCH_INCONCLUSIVE Narrative at low feed priority
      // — not silence. The kernel's job is to emit the verdict;
      // Rev3-F's curator formats the Narrative.
      const verdict = evaluateAppliedPatternWatcher({
        pattern,
        projectSessions: [sessionAtDay(1)],
        projectNarratives: [],
        now: baseTime + (T + 1) * MS_PER_DAY,
      });
      expect(verdict.kind).toBe('inconclusive');
      if (verdict.kind === 'inconclusive') {
        expect(verdict.reason).toBe('wall-clock-timeout');
      }
    });

    it('audit trail — bypass-path Pattern is identifiable by `falsifierStatus`', () => {
      // The plan gate explicitly says: "bypass path produces an
      // auditable Pattern row." Two encoded patterns — one via the
      // default path, one via the override — should be readily
      // distinguishable downstream by the audit table (Rev3-D D3 is
      // narrative-side; future Pattern-side audit consumes the same
      // sentinel via `falsifierStatus === 'skipped-by-user'`).
      const defaultPath = buildPatternFromNarrative(fixtureNarrative(), false);
      const bypassPath = buildPatternFromNarrative(fixtureNarrative(), false, {
        falsifierOverride: true,
      });
      const allPatterns = [defaultPath, bypassPath];
      const bypassed = allPatterns.filter(
        (p) => p.falsifierStatus === 'skipped-by-user',
      );
      expect(bypassed).toHaveLength(1);
      expect(bypassed[0]!.sourceNarrativeId).toBe('narr-gate-1');
    });
  });
});
