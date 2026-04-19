import { useMemo } from 'react';
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

function computeProjectPills(sessions: readonly UnifiedSessionEntry[]): {
  top: ProjectPill[];
  rest: ProjectPill[];
  unknownCount: number;
} {
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const s of sessions) {
    if (s.project) counts.set(s.project, (counts.get(s.project) ?? 0) + 1);
    else unknown += 1;
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count }));
  return {
    top: sorted.slice(0, 8),
    rest: sorted.slice(8),
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
}: FilterBarProps) {
  const projectPills = useMemo(() => computeProjectPills(filtered), [filtered]);
  const zeroTurnCount = useMemo(
    () => manifest.sessions.filter((s) => s.userTurns === 0).length,
    [manifest.sessions],
  );

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
        className="lcars-filter-bar__pills lcars-filter-bar__pills--project"
        role="toolbar"
        aria-label="project filter"
      >
        {projectPills.top.map((p) => {
          const active = projectFilter.has(p.id);
          return (
            <span
              key={p.id}
              role="button"
              tabIndex={0}
              className={`lcars-project-pill${active ? ' lcars-project-pill--active' : ''}`}
              aria-pressed={active}
              aria-label={`toggle project ${p.id} (${p.count} sessions)`}
              onClick={() => onToggleProject(p.id)}
              onKeyDown={(e) => onActivate(e, () => onToggleProject(p.id))}
            >
              {p.id} <span className="lcars-project-pill__count">{p.count}</span>
            </span>
          );
        })}
        <span
          role="button"
          tabIndex={0}
          className={`lcars-project-pill lcars-project-pill--unknown${unknownProjectActive ? ' lcars-project-pill--active' : ''}`}
          aria-pressed={unknownProjectActive}
          aria-label={`toggle UNKNOWN project filter (${projectPills.unknownCount} sessions)`}
          onClick={onToggleUnknownProject}
          onKeyDown={(e) => onActivate(e, onToggleUnknownProject)}
        >
          UNKNOWN <span className="lcars-project-pill__count">{projectPills.unknownCount}</span>
        </span>
        {projectPills.rest.length > 0 && (
          <span
            className="lcars-project-pill lcars-project-pill--rest"
            title={projectPills.rest.map((p) => `${p.id} (${p.count})`).join(', ')}
          >
            +{projectPills.rest.length} more
          </span>
        )}
      </div>
    </section>
  );
}
