import { useMemo, useState } from 'react';
import type { UnifiedSessionEntry, Narrative } from '@chat-arch/schema';
import { SessionCard } from '../SessionCard.js';
import { EmptyState } from '../EmptyState.js';
import { onActivate } from '../../util/a11y.js';
import type { SessionDuplicateInfo } from '../../data/mergeDuplicates.js';

export interface CommandModeProps {
  sessions: readonly UnifiedSessionEntry[];
  onSelect: (id: string) => void;
  /** Per-session duplicate index from `buildSessionDuplicateIndex`. */
  sessionDupIndex?: Map<string, SessionDuplicateInfo>;
  /** Set of project ids classified `zombie` — drives the ZOMBIE chip. */
  zombieProjectIds?: ReadonlySet<string>;
  /**
   * DUP-chip click handler. Informational only post-Phase-3 (the
   * CONSTELLATION drill-in target was cut); callback retained for
   * future reuse and exercised by SessionCard unit tests.
   */
  onDuplicateChipClick?: (clusterId: string, sessionId: string) => void;
  /**
   * ZOMBIE-chip click handler. Informational only post-Phase-3;
   * callback retained for future reuse and exercised by SessionCard
   * unit tests.
   */
  onZombieChipClick?: (sessionId: string) => void;
  /**
   * Ids of sessions whose `project` came from the Phase 3 semantic
   * classifier rather than the string matcher / CLI data. SessionCard
   * renders these with a `~` prefix so users can tell an inferred label
   * from a ground-truth one.
   */
  semanticSessionIds?: ReadonlySet<string>;
  /** v2 Phase 5: topic display names per session — drives topic chips. */
  topicsBySession?: ReadonlyMap<string, readonly string[]>;
  /** v2 Phase 5: narrative attachments per session — drives the narrative chip. */
  narrativesBySession?: ReadonlyMap<string, readonly Narrative[]>;
}

const PAGE_SIZE = 50;

export function CommandMode({
  sessions,
  onSelect,
  sessionDupIndex,
  zombieProjectIds,
  onDuplicateChipClick,
  onZombieChipClick,
  semanticSessionIds,
  topicsBySession,
  narrativesBySession,
}: CommandModeProps) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const now = useMemo(() => Date.now(), []);

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="NO MATCHES"
        message="No sessions match the current filters. Clear search or toggle source pills."
      />
    );
  }

  const slice = sessions.slice(0, visible);
  const canLoadMore = visible < sessions.length;

  return (
    <div className="lcars-command-mode">
      <div className="lcars-command-mode__grid" role="list">
        {slice.map((s) => {
          const dup = sessionDupIndex?.get(s.id);
          const isZombie = !!(s.project && zombieProjectIds?.has(s.project));
          const isSemanticProject = !!semanticSessionIds?.has(s.id);
          const topics = topicsBySession?.get(s.id);
          const narratives = narrativesBySession?.get(s.id);
          return (
            <div role="listitem" key={`${s.source}:${s.id}`}>
              <SessionCard
                session={s}
                onSelect={onSelect}
                now={now}
                {...(dup ? { duplicateInfo: dup } : {})}
                isZombieProject={isZombie}
                isSemanticProject={isSemanticProject}
                {...(topics && topics.length > 0 ? { topics } : {})}
                {...(narratives && narratives.length > 0 ? { narratives } : {})}
                {...(onDuplicateChipClick ? { onDuplicateChipClick } : {})}
                {...(onZombieChipClick ? { onZombieChipClick } : {})}
              />
            </div>
          );
        })}
      </div>
      {canLoadMore && (
        <div className="lcars-command-mode__more">
          <div
            role="button"
            tabIndex={0}
            className="lcars-command-mode__more-btn"
            aria-label={`show 50 more (${sessions.length - visible} remaining)`}
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            onKeyDown={(e) => onActivate(e, () => setVisible((v) => v + PAGE_SIZE))}
          >
            SHOW 50 MORE ({sessions.length - visible} REMAINING)
          </div>
        </div>
      )}
    </div>
  );
}
