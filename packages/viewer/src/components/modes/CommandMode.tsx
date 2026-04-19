import { useMemo, useState } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
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
  /** DUP-chip navigation → CONSTELLATION mode with cluster highlighted. */
  onDuplicateChipClick?: (clusterId: string, sessionId: string) => void;
  /** ZOMBIE-chip navigation → CONSTELLATION mode filtered to zombies. */
  onZombieChipClick?: (sessionId: string) => void;
}

const PAGE_SIZE = 50;

export function CommandMode({
  sessions,
  onSelect,
  sessionDupIndex,
  zombieProjectIds,
  onDuplicateChipClick,
  onZombieChipClick,
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
          return (
            <div role="listitem" key={`${s.source}:${s.id}`}>
              <SessionCard
                session={s}
                onSelect={onSelect}
                now={now}
                {...(dup ? { duplicateInfo: dup } : {})}
                isZombieProject={isZombie}
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
