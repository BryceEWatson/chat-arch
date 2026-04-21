import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import type { FilterState } from '../types.js';
import { SourcePill } from './SourcePill.js';
import { onActivate } from '../util/a11y.js';

/**
 * Filter controls that live directly above the scrolling content area
 * — source pills, zero-turn toggle, and project pills. Previously these
 * sat inside the UpperPanel which made the relationship "what's this
 * filter affecting" less obvious. Co-locating them with the content
 * they scope (right above the session grid) keeps the cause-and-effect
 * visible.
 */

export interface FilterBarProps {
  manifest: SessionManifest;
  sourceFilter: FilterState;
  onToggleSource: (src: UnifiedSessionEntry['source']) => void;
  onClearFilters: () => void;
  projectFilter: ReadonlySet<string>;
  onToggleProject: (projectId: string) => void;
  unknownProjectActive: boolean;
  onToggleUnknownProject: () => void;
  showEmpty: boolean;
  onToggleShowEmpty: () => void;
  /** Filtered session list — drives the derived project-pill counts. */
  filtered: readonly UnifiedSessionEntry[];
  /**
   * When true, semantic analysis is streaming labels into the list.
   * FilterBar uses this to pin any currently-selected pill into the
   * visible "top" row regardless of rank (otherwise a pill the user
   * clicked could fall off the top-8 cutoff as other labels overtake
   * it, orphaning the filter state on a pill that's no longer visible).
   * Also paints the pill row with a subtle "live" treatment.
   */
  streaming?: boolean;
  /**
   * "Focus" pulse from the ANALYSIS-tab's LABELS / TOPICS cards. When
   * the user clicks those cards we scroll-into-view the matching pill
   * row(s) and briefly highlight them so the navigation is
   * unmistakable. `key` changes per click so repeated clicks re-trigger
   * the pulse even when the target is the same row. `target='labels'`
   * flashes both PROJECTS and TOPICS simultaneously — labels come from
   * both classifier branches, so pulsing only PROJECTS misrepresents
   * the scope.
   */
  filterFocus?: { target: 'projects' | 'topics' | 'labels'; key: number };
}

const SOURCES: readonly UnifiedSessionEntry['source'][] = [
  'cloud',
  'cowork',
  'cli-direct',
  'cli-desktop',
];

interface ProjectPill {
  id: string;
  count: number;
}

interface PillBucket {
  top: ProjectPill[];
  rest: ProjectPill[];
}

/**
 * Bucket sorted pills into `top` (visible immediately) and `rest`
 * (collapsed behind a "+N more" control). Pinned pills always land in
 * `top` regardless of rank — important during a live semantic streaming
 * pass where counts climb and the user mustn't lose sight of a filter
 * they explicitly engaged. Within each bucket, sort order from `sorted`
 * is preserved so the visual rank reflects the count rank.
 */
function splitWithCap(
  sorted: readonly ProjectPill[],
  pinnedIds: ReadonlySet<string>,
  cap: number,
): PillBucket {
  const pinned = sorted.filter((p) => pinnedIds.has(p.id));
  const unpinned = sorted.filter((p) => !pinnedIds.has(p.id));
  const remainingSlots = Math.max(0, cap - pinned.length);
  return {
    top: [...pinned, ...unpinned.slice(0, remainingSlots)],
    rest: unpinned.slice(remainingSlots),
  };
}

/**
 * Partition pills into Projects and Topics — two **independent**
 * dimensions on each session. A session with `project = "py-coder"`
 * and `topic = "~performance-tuning"` contributes 1 to py-coder's
 * project pill AND 1 to the ~performance-tuning topic pill. The
 * intuition: projects are authoritative names (CLI cwd, title regex,
 * or high-confidence classifier match); topics are the classifier's
 * emergent-cluster view of the same corpus; both views are useful
 * and should cross-filter.
 *
 * Counting rules:
 *   - Projects row + UNKNOWN partition the session set on `s.project`:
 *     every session contributes exactly one unit to either a named-
 *     project pill or UNKNOWN. Row sum (including UNKNOWN) === input
 *     length.
 *   - Topics row counts `s.topic`. Sessions without `s.topic` don't
 *     appear in the topics row at all. Topic row sum ≤ input length
 *     (with equality iff every session is in an emergent cluster).
 *
 * Topics get a slightly larger top-row cap (12 vs 8) because there are
 * usually more of them and they're often what the user is exploring.
 */
function computeFilterPills(
  sessions: readonly UnifiedSessionEntry[],
  pinnedIds: ReadonlySet<string> = new Set(),
): {
  projects: PillBucket;
  topics: PillBucket;
  unknownCount: number;
} {
  const projectCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  let unknown = 0;
  for (const s of sessions) {
    if (s.project) projectCounts.set(s.project, (projectCounts.get(s.project) ?? 0) + 1);
    else unknown += 1;
    if (s.topic) topicCounts.set(s.topic, (topicCounts.get(s.topic) ?? 0) + 1);
  }
  const projectsSorted = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count }));
  const topicsSorted = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count }));

  if (process.env.NODE_ENV !== 'production') {
    // Sanity: projects row + UNKNOWN must partition the input (each
    // session contributes once on the project axis). If this fires,
    // there's a drift between the enrichment merge and the chip
    // counter — catch it loudly instead of silently rendering numbers
    // that don't add up to VISIBLE.
    const projectSum = unknown + projectsSorted.reduce((a, p) => a + p.count, 0);
    if (projectSum !== sessions.length) {
      console.warn(
        `FilterBar: project-row sum ${projectSum} ≠ ${sessions.length} sessions ` +
          `(named=${projectsSorted.reduce((a, p) => a + p.count, 0)}, unknown=${unknown})`,
      );
    }
  }

  return {
    projects: splitWithCap(projectsSorted, pinnedIds, 8),
    topics: splitWithCap(topicsSorted, pinnedIds, 12),
    unknownCount: unknown,
  };
}

export function FilterBar({
  manifest,
  sourceFilter,
  onToggleSource,
  onClearFilters,
  projectFilter,
  onToggleProject,
  unknownProjectActive,
  onToggleUnknownProject,
  showEmpty,
  onToggleShowEmpty,
  filtered,
  streaming = false,
  filterFocus,
}: FilterBarProps) {
  const filterPills = useMemo(
    () => computeFilterPills(filtered, projectFilter),
    [filtered, projectFilter],
  );
  const zeroTurnCount = useMemo(
    () => manifest.sessions.filter((s) => s.userTurns === 0).length,
    [manifest.sessions],
  );
  // Both pill rows (projects, topics) cap their visible top to keep the
  // default state compact, with a "+N more" control to expand the long
  // tail inline. Independent expanded state per row so the user can
  // reveal one without the other — most often they'll want to expand
  // topics (the long-tail bucket) without churning the projects row.
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [topicsExpanded, setTopicsExpanded] = useState(false);
  const visibleProjects = [
    ...filterPills.projects.top,
    ...(projectsExpanded ? filterPills.projects.rest : []),
  ];
  const visibleTopics = [
    ...filterPills.topics.top,
    ...(topicsExpanded ? filterPills.topics.rest : []),
  ];

  // Focus-pulse plumbing for the ANALYSIS-tab navigation. Each row
  // (projects / topics) gets a ref; when `filterFocus.key` changes we
  // scroll the matching row into view and toggle `data-focused` for
  // ~1.5s so CSS can paint a brief glow. Using the `key` ensures the
  // same target can retrigger the effect on repeat clicks.
  const projectsRowRef = useRef<HTMLDivElement>(null);
  const topicsRowRef = useRef<HTMLDivElement>(null);
  // Track each row's focus independently so 'labels' can pulse both
  // rows concurrently. 'projects' or 'topics' alone lights just one row.
  const [focusedProjects, setFocusedProjects] = useState(false);
  const [focusedTopics, setFocusedTopics] = useState(false);
  useEffect(() => {
    if (!filterFocus) return;
    const wantProjects = filterFocus.target === 'projects' || filterFocus.target === 'labels';
    const wantTopics = filterFocus.target === 'topics' || filterFocus.target === 'labels';
    // Scroll the first relevant row into view. When both are requested
    // we aim at the projects row since it's the earlier of the two;
    // the pulse on the topics row below will still be visible.
    const ref = wantProjects && projectsRowRef.current
      ? projectsRowRef
      : wantTopics && topicsRowRef.current
        ? topicsRowRef
        : null;
    if (ref?.current) {
      try {
        ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {
        // Older browsers without smooth-scroll support fall back silently.
      }
    }
    if (wantProjects) setFocusedProjects(true);
    if (wantTopics) setFocusedTopics(true);
    const timer = window.setTimeout(() => {
      setFocusedProjects(false);
      setFocusedTopics(false);
    }, 2200);
    return () => window.clearTimeout(timer);
    // Depend on `key` so repeated clicks retrigger; `target` is captured
    // by closure on each run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFocus?.key, filterFocus?.target]);

  return (
    <section className="lcars-filter-bar" aria-label="filter controls">
      <div
        className="lcars-filter-bar__pills lcars-filter-bar__pills--source"
        role="toolbar"
        aria-label="source filter"
      >
        <div
          className={`lcars-source-pill lcars-source-pill--all${
            sourceFilter.size === 0 ? ' lcars-source-pill--active' : ''
          }`}
          role="button"
          tabIndex={0}
          aria-pressed={sourceFilter.size === 0}
          aria-label="show all sources"
          onClick={onClearFilters}
          onKeyDown={(e) => onActivate(e, onClearFilters)}
        >
          <span className="lcars-source-pill__badge" aria-hidden="true">
            A
          </span>
          <span className="lcars-source-pill__label">ALL</span>
        </div>
        {SOURCES.map((src) => (
          <SourcePill
            key={src}
            source={src}
            count={manifest.counts[src]}
            active={sourceFilter.has(src)}
            onToggle={() => onToggleSource(src)}
          />
        ))}
        <span
          role="button"
          tabIndex={0}
          className={`lcars-zero-turn-toggle${showEmpty ? ' lcars-zero-turn-toggle--active' : ''}`}
          aria-pressed={showEmpty}
          aria-label={`${showEmpty ? 'hide' : 'show'} ${zeroTurnCount} zero-turn sessions`}
          onClick={onToggleShowEmpty}
          onKeyDown={(e) => onActivate(e, onToggleShowEmpty)}
        >
          <span className="lcars-source-pill__badge" aria-hidden="true">
            Ø
          </span>
          <span className="lcars-source-pill__label">{showEmpty ? 'HIDE' : 'SHOW'} EMPTY</span>
          <span className="lcars-source-pill__count">{zeroTurnCount}</span>
        </span>
      </div>
      <div
        ref={projectsRowRef}
        className={
          `lcars-filter-bar__pills lcars-filter-bar__pills--project` +
          (streaming ? ' lcars-filter-bar__pills--streaming' : '') +
          (focusedProjects ? ' lcars-filter-bar__pills--focused' : '')
        }
        role="toolbar"
        aria-label="project filter"
        aria-busy={streaming || undefined}
      >
        <span className="lcars-filter-bar__row-label" aria-hidden="true">
          PROJECTS
        </span>
        {visibleProjects.map((p) => {
          const active = projectFilter.has(p.id);
          return (
            <span
              key={p.id}
              role="button"
              tabIndex={0}
              className={
                `lcars-project-pill` + (active ? ' lcars-project-pill--active' : '')
              }
              aria-pressed={active}
              aria-label={`toggle project ${p.id} (${p.count} sessions)`}
              title={p.id}
              onClick={() => onToggleProject(p.id)}
              onKeyDown={(e) => onActivate(e, () => onToggleProject(p.id))}
            >
              <span className="lcars-project-pill__label">{p.id}</span>
              <span className="lcars-project-pill__count">{p.count}</span>
            </span>
          );
        })}
        {/* Hide the UNKNOWN pill when it would show `0` AND the user
           * isn't already filtered into the UNKNOWN view. With cross-
           * filtering active, topic filters routinely zero out the
           * visible UNKNOWN count, and rendering "UNKNOWN 0" in that
           * state reads as a misleading dead affordance. We keep the
           * pill visible while active so the user can always un-click
           * it even if their current filter combination happens to
           * match zero UNKNOWN sessions. */}
        {(filterPills.unknownCount > 0 || unknownProjectActive) && (
          <span
            role="button"
            tabIndex={0}
            className={`lcars-project-pill lcars-project-pill--unknown${unknownProjectActive ? ' lcars-project-pill--active' : ''}`}
            aria-pressed={unknownProjectActive}
            aria-label={`toggle UNKNOWN project filter (${filterPills.unknownCount} sessions)`}
            onClick={onToggleUnknownProject}
            onKeyDown={(e) => onActivate(e, onToggleUnknownProject)}
          >
            UNKNOWN <span className="lcars-project-pill__count">{filterPills.unknownCount}</span>
          </span>
        )}
        {filterPills.projects.rest.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            className="lcars-project-pill lcars-project-pill--rest"
            aria-expanded={projectsExpanded}
            aria-label={
              projectsExpanded
                ? `collapse ${filterPills.projects.rest.length} more projects`
                : `show ${filterPills.projects.rest.length} more projects`
            }
            title={
              projectsExpanded
                ? 'click to collapse'
                : filterPills.projects.rest.map((p) => `${p.id} (${p.count})`).join(', ')
            }
            onClick={() => setProjectsExpanded((v) => !v)}
            onKeyDown={(e) => onActivate(e, () => setProjectsExpanded((v) => !v))}
          >
            {projectsExpanded ? `− collapse` : `+${filterPills.projects.rest.length} more`}
          </span>
        )}
      </div>
      {/* Topics row — only render when the discovery pass actually
        * surfaced topics, so users without semantic-analysis runs see
        * just the projects row (no awkward empty section). The
        * streaming class still applies during a live run because new
        * topics arrive on this row. */}
      {(filterPills.topics.top.length > 0 || filterPills.topics.rest.length > 0) && (
        <div
          ref={topicsRowRef}
          className={
            `lcars-filter-bar__pills lcars-filter-bar__pills--topic` +
            (streaming ? ' lcars-filter-bar__pills--streaming' : '') +
            (focusedTopics ? ' lcars-filter-bar__pills--focused' : '')
          }
          role="toolbar"
          aria-label="topic filter"
          aria-busy={streaming || undefined}
        >
          <span className="lcars-filter-bar__row-label" aria-hidden="true">
            TOPICS
          </span>
          {visibleTopics.map((p) => {
            const active = projectFilter.has(p.id);
            // Topic id is `~${label}` — strip the prefix for display
            // since the row label already communicates "this row is
            // topics". Keeps the pill text focused on the actual
            // theme rather than visually doubling the marker.
            const display = p.id.startsWith('~') ? p.id.slice(1) : p.id;
            return (
              <span
                key={p.id}
                role="button"
                tabIndex={0}
                className={
                  `lcars-project-pill lcars-project-pill--emergent` +
                  (active ? ' lcars-project-pill--active' : '')
                }
                aria-pressed={active}
                aria-label={`toggle emergent topic ${p.id} (${p.count} sessions discovered by clustering)`}
                title={`${display} — emergent topic discovered from conversation content (${p.count} sessions).`}
                onClick={() => onToggleProject(p.id)}
                onKeyDown={(e) => onActivate(e, () => onToggleProject(p.id))}
              >
                <span className="lcars-project-pill__label">{display}</span>
                <span className="lcars-project-pill__count">{p.count}</span>
              </span>
            );
          })}
          {filterPills.topics.rest.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              className="lcars-project-pill lcars-project-pill--rest"
              aria-expanded={topicsExpanded}
              aria-label={
                topicsExpanded
                  ? `collapse ${filterPills.topics.rest.length} more topics`
                  : `show ${filterPills.topics.rest.length} more topics`
              }
              title={
                topicsExpanded
                  ? 'click to collapse'
                  : filterPills.topics.rest.map((p) => `${p.id.replace(/^~/, '')} (${p.count})`).join(', ')
              }
              onClick={() => setTopicsExpanded((v) => !v)}
              onKeyDown={(e) => onActivate(e, () => setTopicsExpanded((v) => !v))}
            >
              {topicsExpanded ? `− collapse` : `+${filterPills.topics.rest.length} more`}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
