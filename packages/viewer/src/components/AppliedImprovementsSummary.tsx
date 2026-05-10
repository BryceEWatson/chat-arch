import { useMemo, useState } from 'react';
import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  CorrectionPattern,
  CorrectionsFile,
} from '@chat-arch/schema';
import { formatRelativeUnit } from '../util/time.js';

/**
 * Phase 2b workshop surface — "Since you patched" summary.
 *
 * Hosted at the top of CorrectionsPanel as a synthesis header, NOT a
 * standalone mode. Renders only when the user has at least one entry
 * in `applied-improvements.json` — so first-time users (no APPLY
 * clicks) see the existing CoverageMeter + Buckets surface untouched,
 * and returning users see a workshop-style "what's holding, what's
 * recurring, when did I last patch" recap above the fold.
 *
 * Pure presentational: all derivations happen from props inside this
 * component. The host owns merge semantics (CorrectionsPanel runs
 * `mergeAppliedImprovements` before passing `corrections` here, so
 * `pattern.recurringPostApplication` reflects the current ledger).
 */

const MS_DAY = 86_400_000;
const STALE_THRESHOLD_DAYS = 30;
/**
 * Floor for "plausible apply timestamp". A corrupt entry with
 * `appliedAt: 1` (or any value below this floor) would otherwise
 * pin maxAppliedAt to the unix epoch and produce nonsense headlines
 * like "SINCE YOU PATCHED 20148D AGO". 2000-01-01 is well before any
 * Claude product existed; anything earlier is unambiguously bad
 * data and gets ignored when computing the headline / stale chip.
 * (We keep this loose rather than tying it to the apply-pipeline
 * ship date so older fixture data — Nov-2023 timestamps in the test
 * suite — still renders correctly.)
 */
const MIN_REASONABLE_EPOCH = 946_684_800_000; // 2000-01-01T00:00:00Z

export interface AppliedImprovementsSummaryProps {
  /** The applied-improvements ledger. `null` -> hidden. */
  applied: AppliedImprovementsFile | null;
  /**
   * The post-merge corrections file (CorrectionsPanel runs the merge
   * before passing it down). Used to count which patterns flipped
   * RECURRING after their applied event. `null` is tolerated; the
   * recurring count falls back to 0.
   */
  corrections: CorrectionsFile | null;
  /**
   * `manifest.generatedAt` from the host. Drives the stale-warning
   * chip — when the index hasn't been refreshed in >30 days past the
   * most recent apply, recurring counts are unreliable.
   */
  manifestGeneratedAt: number | null;
  /**
   * Click-through handler. The summary calls this with a patternId
   * when the user clicks a timeline row; CorrectionsPanel responds by
   * scrolling to and highlighting the matching CorrectionPatternCard.
   */
  onSelectPattern: (patternId: string) => void;
  /**
   * Optional rescan trigger. When provided, the stale-index warning
   * renders as an actionable button that fires this callback (so Maya
   * can click it directly instead of hunting for UPDATE LOCAL in the
   * chrome). When omitted (e.g. hosted/static build with no rescan
   * endpoint), the warning falls back to a non-interactive `<span>`
   * with the same copy.
   */
  onRefreshIndex?: () => void;
}

interface TimelineRow {
  entry: AppliedImprovement;
  bucket: 'HOLDING' | 'RECURRING' | 'GONE';
}

/**
 * Build the timeline rows. Each ledger entry is paired with the live
 * pattern's `recurringPostApplication` flag so the badge reflects the
 * post-merge classification:
 *   - HOLDING   — pattern still in corrections.json, not recurring
 *   - RECURRING — pattern still there but flipped recurring-after-apply
 *   - GONE      — pattern not in current corrections.json (re-mine on
 *                 a smaller window dropped it; entry preserved here)
 */
function buildRows(
  applied: AppliedImprovementsFile,
  patternsById: Map<string, CorrectionPattern>,
): TimelineRow[] {
  const rows: TimelineRow[] = applied.entries.map((entry) => {
    const p = patternsById.get(entry.patternId);
    let bucket: TimelineRow['bucket'];
    if (!p) bucket = 'GONE';
    else if (p.recurringPostApplication) bucket = 'RECURRING';
    else bucket = 'HOLDING';
    return { entry, bucket };
  });
  // Most-recent first — the user wants "what did I just patch" at the
  // top, not chronological order.
  rows.sort((a, b) => b.entry.appliedAt - a.entry.appliedAt);
  return rows;
}

const TARGET_LABEL: Record<string, string> = {
  'global-claude-md': 'GLOBAL CLAUDE.MD',
  'project-claude-md': 'PROJECT CLAUDE.MD',
  'settings-hook': 'SETTINGS HOOK',
  skill: 'SKILL',
  agent: 'AGENT',
  command: 'COMMAND',
  'prompt-snippet': 'PROMPT SNIPPET',
};

export function AppliedImprovementsSummary({
  applied,
  corrections,
  manifestGeneratedAt,
  onSelectPattern,
  onRefreshIndex,
}: AppliedImprovementsSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  // Pattern lookup for the timeline. Memoized — corrections.patterns
  // can be 50+ entries on a mature corpus and this map is rebuilt
  // every render otherwise.
  const patternsById = useMemo(() => {
    const m = new Map<string, CorrectionPattern>();
    for (const p of corrections?.patterns ?? []) m.set(p.id, p);
    return m;
  }, [corrections?.patterns]);

  // Stats derived from props. Same memoization story — the recurring
  // count walks the entire ledger × pattern set in the worst case.
  const stats = useMemo(() => {
    if (!applied || applied.entries.length === 0) {
      return { applied: 0, recurring: 0, holding: 0, gone: 0, maxAppliedAt: 0 };
    }
    let maxAppliedAt = 0;
    // De-dupe by patternId for the recurring/holding split — multiple
    // ledger entries on the same pattern (different upgrade targets)
    // shouldn't double-count. The "Applied" tally stays as raw entry
    // count because that's the user's mental model: "I clicked APPLY
    // N times".
    const patternIds = new Set<string>();
    for (const entry of applied.entries) {
      // Ignore obviously-corrupt timestamps when computing the
      // headline anchor. Without this guard a single bad entry with
      // `appliedAt: 1` pins the headline to "20148D AGO" and the
      // stale-chip math reads wrong too.
      if (
        entry.appliedAt >= MIN_REASONABLE_EPOCH &&
        entry.appliedAt > maxAppliedAt
      ) {
        maxAppliedAt = entry.appliedAt;
      }
      patternIds.add(entry.patternId);
    }
    let recurring = 0;
    let gone = 0;
    for (const id of patternIds) {
      const p = patternsById.get(id);
      if (!p) {
        // Pattern in the apply ledger but missing from the current
        // corrections.json — the timeline still renders a GONE row,
        // but it does NOT count as "still holding" (the original
        // implementation lumped these into HOLDING, conflating "lost
        // track of pattern" with "rule is sticking").
        gone += 1;
      } else if (p.recurringPostApplication) {
        recurring += 1;
      }
    }
    const distinctApplied = patternIds.size;
    const holding = Math.max(0, distinctApplied - recurring - gone);
    return {
      applied: applied.entries.length,
      recurring,
      holding,
      gone,
      maxAppliedAt,
    };
  }, [applied, patternsById]);

  const timelineRows = useMemo(() => {
    if (!applied || applied.entries.length === 0) return [] as TimelineRow[];
    return buildRows(applied, patternsById);
  }, [applied, patternsById]);

  // Hidden when there's no ledger — first-time users see the existing
  // panel surface untouched. Spec requires: applied===null OR
  // entries.length===0 → return null.
  if (!applied || applied.entries.length === 0) return null;

  // When every entry's appliedAt was implausible (corrupt ledger), we
  // skip the relative timestamp rather than render gibberish like
  // "20148D AGO". Headline degrades gracefully to just the verb.
  const headlineRelative =
    stats.maxAppliedAt >= MIN_REASONABLE_EPOCH
      ? formatRelativeUnit(stats.maxAppliedAt)
      : '';
  const headlineUpper = headlineRelative.toUpperCase();

  // Stale-index detection: when the manifest hasn't been refreshed in
  // the 30 days following the most recent apply, the recurring count
  // here is an undercount — new violations could have arrived but the
  // corpus hasn't been re-indexed to surface them. Spec: "manifest is
  // older than maxAppliedAt + 30 days". Equivalent: at least 30 days
  // of post-apply observation are missing from the index.
  const indexIsStale =
    typeof manifestGeneratedAt === 'number' &&
    Number.isFinite(manifestGeneratedAt) &&
    stats.maxAppliedAt > 0 &&
    manifestGeneratedAt < stats.maxAppliedAt + STALE_THRESHOLD_DAYS * MS_DAY &&
    // Don't fire the warning until enough wall-clock time has actually
    // elapsed for stale-ness to matter — if you applied 5 minutes ago,
    // an unrefreshed manifest is the expected state, not a problem.
    Date.now() - stats.maxAppliedAt > STALE_THRESHOLD_DAYS * MS_DAY;

  return (
    <section
      className="lcars-applied-summary"
      aria-label="since you patched"
    >
      <header className="lcars-applied-summary__header">
        <h3 className="lcars-applied-summary__headline">
          {headlineUpper ? `SINCE YOU PATCHED ${headlineUpper}` : 'SINCE YOU PATCHED'}
        </h3>
        {indexIsStale && (onRefreshIndex ? (
          // Actionable variant — Maya can fix the warning by clicking
          // it directly. The arrow glyph telegraphs "this does
          // something"; the chrome's UPDATE LOCAL button is a longer
          // hunt.
          <button
            type="button"
            className="lcars-applied-summary__stale lcars-applied-summary__stale--button"
            aria-label="index is stale — click to refresh"
            title="Refresh the corpus so recurring counts include new violations."
            onClick={onRefreshIndex}
          >
            INDEX IS STALE — RUN UPDATE LOCAL TO CHECK FOR NEW VIOLATIONS
            <span className="lcars-applied-summary__stale-arrow" aria-hidden="true"> →</span>
          </button>
        ) : (
          // Phase 4 P0.5: when no `onRefreshIndex` is wired, the host is
          // either the hosted static build (no `/api/rescan`) or a
          // caller that simply hasn't plumbed the callback. UPDATE
          // LOCAL doesn't exist on hosted, so the copy must point the
          // visitor at the install path instead of a non-existent
          // button.
          <span
            className="lcars-applied-summary__stale"
            role="status"
            aria-label="index is stale"
            title="Install chat-arch locally to refresh the corpus before trusting recurring counts."
          >
            INDEX IS STALE — INSTALL CHAT-ARCH LOCALLY TO REFRESH
          </span>
        ))}
      </header>

      <ul className="lcars-applied-summary__stats" role="list">
        <li className="lcars-applied-summary__stat">
          <span className="lcars-applied-summary__stat-value">{stats.applied}</span>
          <span className="lcars-applied-summary__stat-label">APPLIED</span>
        </li>
        <li className="lcars-applied-summary__stat lcars-applied-summary__stat--holding">
          <span className="lcars-applied-summary__stat-value">{stats.holding}</span>
          <span className="lcars-applied-summary__stat-label">HOLDING</span>
        </li>
        <li className="lcars-applied-summary__stat lcars-applied-summary__stat--recurring">
          <span className="lcars-applied-summary__stat-value">{stats.recurring}</span>
          <span className="lcars-applied-summary__stat-label">RECURRING</span>
        </li>
      </ul>

      <button
        type="button"
        className="lcars-applied-summary__toggle"
        aria-expanded={expanded}
        aria-controls="lcars-applied-summary-timeline"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'HIDE PATCH LEDGER' : 'VIEW PATCH LEDGER'}
        <span className="lcars-applied-summary__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <ul
          id="lcars-applied-summary-timeline"
          className="lcars-applied-summary__timeline"
          role="list"
        >
          {timelineRows.map((row) => {
            const { entry, bucket } = row;
            const targetLabel =
              TARGET_LABEL[entry.proposedUpgrade.target] ??
              entry.proposedUpgrade.target.toUpperCase();
            const when = formatRelativeUnit(entry.appliedAt);
            return (
              <li key={entry.id} className="lcars-applied-summary__row">
                <button
                  type="button"
                  className="lcars-applied-summary__row-btn"
                  onClick={() => onSelectPattern(entry.patternId)}
                  aria-label={`open pattern ${entry.ruleSummary}`}
                  title="Jump to this pattern's card"
                >
                  <span className="lcars-applied-summary__row-when">{when}</span>
                  <span className="lcars-applied-summary__row-rule">
                    {entry.ruleSummary}
                  </span>
                  <span className="lcars-applied-summary__row-target">
                    <span className="lcars-applied-summary__row-target-kind">
                      {targetLabel}
                    </span>
                    <code className="lcars-applied-summary__row-target-path">
                      {entry.proposedUpgrade.targetPath}
                    </code>
                  </span>
                  <span
                    className={`lcars-applied-summary__row-bucket lcars-applied-summary__row-bucket--${bucket.toLowerCase()}`}
                  >
                    {bucket}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
