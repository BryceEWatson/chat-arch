import { useEffect, useMemo, useRef, useState } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import type { TierFileState } from '../../data/analysisFetch.js';
import type { MergedDuplicateCluster } from '../../data/mergeDuplicates.js';
import { DuplicateClusterCard } from '../constellation/DuplicateClusterCard.js';
import { ZombieProjectCard, type ZombieProject } from '../constellation/ZombieProjectCard.js';
import { LocalAnalyzerAccordion } from '../constellation/LocalAnalyzerAccordion.js';

/**
 * CONSTELLATION mode (Decision 20 / `[R-D20]`) — pattern view.
 *
 * Layout (stacked sections, tier-1 on top):
 *   1. `EXACT DUPLICATES (N)` — merged cluster grid
 *   2. `ZOMBIE PROJECTS (N)` — lifecycle sparklines
 *   3. `[+] UNLOCK WITH LOCAL ANALYSIS` — collapsed accordion wrapping
 *      the three Phase-7 sub-sections (SEMANTIC CLUSTERS, RE-SOLVED
 *      PROBLEMS, ABANDONMENT DIAGNOSIS)
 *
 * Chip navigation (Decision 14, Q11): the parent passes
 * `highlightClusterId` / `zombieFilterActive` when the user arrived via
 * a SessionCard chip. The originating cluster card gets a ring and we
 * auto-scroll it into view.
 */

export interface ConstellationModeProps {
  sessions: readonly UnifiedSessionEntry[];
  /** Merged exact+semantic cluster list from `mergeDuplicateClusters`. */
  mergedClusters: readonly MergedDuplicateCluster[];
  /** Parsed `zombies.heuristic.json` projects, or empty when file absent. */
  zombieProjects: readonly ZombieProject[];
  /** `AnalysisState.tierFiles` — drives the accordion auto-open behavior. */
  tierFiles: Record<string, TierFileState>;
  /** Cluster id from a DUP-chip click; highlights + auto-scrolls. */
  highlightClusterId: string | null;
  /** Session id of the originating DUP-chip click. Marks that member
   *  within the highlighted cluster and centers it (AC20). */
  highlightOriginSessionId?: string | null;
  /** When true, zombie section shown at top (ZOMBIE chip navigation). */
  zombieFilterActive: boolean;
  /** Drill-in handler — passes through to nested cards. */
  onSelect: (id: string) => void;
}

export function ConstellationMode({
  sessions,
  mergedClusters,
  zombieProjects,
  tierFiles,
  highlightClusterId,
  highlightOriginSessionId = null,
  zombieFilterActive,
  onSelect,
}: ConstellationModeProps) {
  const sessionsById = useMemo(() => {
    const m = new Map<string, UnifiedSessionEntry>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  // AC20: scroll the originating <li> (member row) into view, not the
  // cluster <article>. Also run a one-shot 3s timer on the origin class so
  // the highlight fades rather than persists forever.
  const originMemberRef = useRef<HTMLLIElement>(null);
  const highlightClusterRef = useRef<HTMLElement>(null);
  const zombieSectionRef = useRef<HTMLDivElement>(null);
  const [originActive, setOriginActive] = useState<boolean>(false);

  useEffect(() => {
    if (!highlightClusterId) {
      setOriginActive(false);
      return;
    }
    setOriginActive(true);
    const rafId = requestAnimationFrame(() => {
      // Prefer the originating <li> if we have one; else fall back to
      // the cluster article (AC19 behavior).
      const target = originMemberRef.current ?? highlightClusterRef.current ?? null;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    const clearId = window.setTimeout(() => setOriginActive(false), 3000);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(clearId);
    };
  }, [highlightClusterId, highlightOriginSessionId]);

  useEffect(() => {
    if (zombieFilterActive && zombieSectionRef.current) {
      const id = requestAnimationFrame(() => {
        zombieSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return () => cancelAnimationFrame(id);
    }
    return;
  }, [zombieFilterActive]);

  // Lifecycle section split: render zombie-classified projects on top,
  // reveal dormant/active behind an on-demand toggle. Header mirrors the
  // split counts so the label cannot contradict the rendered content
  // (UX finding 5a — the "ZOMBIE PROJECTS (285)" label previously
  // claimed 285 zombies when only 1 of 285 was classified `zombie`).
  const lifecycleCounts = useMemo(() => {
    const acc = { active: 0, dormant: 0, zombie: 0 } as Record<
      'active' | 'dormant' | 'zombie',
      number
    >;
    for (const p of zombieProjects) acc[p.classification] += 1;
    return acc;
  }, [zombieProjects]);

  const [showDormant, setShowDormant] = useState<boolean>(false);
  const visibleZombies = useMemo(() => {
    if (zombieFilterActive) {
      return zombieProjects.filter((p) => p.classification === 'zombie');
    }
    if (showDormant) {
      return zombieProjects;
    }
    return zombieProjects.filter((p) => p.classification === 'zombie');
  }, [zombieFilterActive, showDormant, zombieProjects]);

  const lifecycleHeaderCount = `${lifecycleCounts.zombie} zombie · ${lifecycleCounts.dormant} dormant · ${lifecycleCounts.active} active`;

  const dormantPlusActive = lifecycleCounts.dormant + lifecycleCounts.active;

  return (
    <div className="lcars-constellation-mode" aria-label="pattern view">
      <section
        className="lcars-constellation-section"
        aria-label={`exact duplicates (${mergedClusters.length})`}
      >
        <header className="lcars-constellation-section__header">
          <h3 className="lcars-constellation-section__title">
            EXACT DUPLICATES ({mergedClusters.length})
          </h3>
          <span className="lcars-constellation-section__hint">
            sessions with identical normalized first-400-char prefix
          </span>
        </header>
        {mergedClusters.length === 0 ? (
          <div className="lcars-constellation-section__empty">
            No duplicate clusters. Either analysis/duplicates.exact.json is absent, or no session in
            the current manifest shares a prefix.
          </div>
        ) : (
          <div className="lcars-constellation-section__grid">
            {mergedClusters.map((c) => {
              const isHighlight = c.id === highlightClusterId;
              return (
                <DuplicateClusterCard
                  key={c.id}
                  cluster={c}
                  sessionsById={sessionsById}
                  highlight={isHighlight}
                  {...(isHighlight
                    ? {
                        scrollRef: highlightClusterRef,
                        originSessionId: highlightOriginSessionId,
                        originActive: originActive,
                        originMemberRef: originMemberRef,
                      }
                    : {})}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* UX finding 5b: the Phase-7 accordion renders here (directly below
          EXACT DUPLICATES) so cold users encounter it before scrolling
          through the lifecycle section. */}
      <LocalAnalyzerAccordion tierFiles={tierFiles} sessionCount={sessions.length} />

      <div ref={zombieSectionRef}>
        <section
          className="lcars-constellation-section"
          aria-label={`project lifecycle (${zombieProjects.length})`}
        >
          <header className="lcars-constellation-section__header">
            <h3 className="lcars-constellation-section__title">
              PROJECT LIFECYCLE ({lifecycleHeaderCount})
              {zombieFilterActive && (
                <span className="lcars-constellation-section__filter">· FILTERED TO ZOMBIE</span>
              )}
            </h3>
            <span className="lcars-constellation-section__hint">
              zombie = dormant ≥30d AND probe-session signature. Default shows zombie only; toggle
              to reveal dormant + active.
            </span>
          </header>
          {visibleZombies.length === 0 ? (
            <div className="lcars-constellation-section__empty">
              No projects match. Either analysis/zombies.heuristic.json is absent, or no project hit
              the threshold.
            </div>
          ) : (
            <div className="lcars-constellation-section__grid lcars-constellation-section__grid--zombie">
              {visibleZombies.map((p) => (
                <ZombieProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
          {!zombieFilterActive && dormantPlusActive > 0 && (
            <button
              type="button"
              className="lcars-constellation-section__toggle"
              aria-expanded={showDormant}
              onClick={() => setShowDormant((v) => !v)}
            >
              {showDormant
                ? `Hide ${dormantPlusActive} dormant / active projects`
                : `Show ${dormantPlusActive} dormant / active projects`}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
