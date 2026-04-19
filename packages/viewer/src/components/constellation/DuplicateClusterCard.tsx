import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { SourceAttribution } from '../SourceAttribution.js';
import { SOURCE_COLOR } from '../../types.js';
import type { MergedDuplicateCluster } from '../../data/mergeDuplicates.js';
import { onActivate } from '../../util/a11y.js';

/**
 * Cluster card for CONSTELLATION's EXACT DUPLICATES section (Decision 20).
 *
 * Renders the sample text, session count, source-attribution suffix
 * (`· exact`, `· semantic`, `· exact+semantic` per Decision 14 / 18),
 * and a list of member sessions as mini-rows that drill into DetailMode.
 *
 * `highlight` is the auto-scroll target for chip navigation (Q11): when
 * a user clicked `DUP · exact (N)` on a SessionCard, the originating
 * cluster card gets a ring + `scrollIntoView`.
 */

export interface DuplicateClusterCardProps {
  cluster: MergedDuplicateCluster;
  /** Map sessionId -> manifest entry (so we can show title/source). */
  sessionsById: Map<string, UnifiedSessionEntry>;
  /** When true, render with a highlight ring + expose `data-highlight`. */
  highlight?: boolean;
  /** Drill-in handler — opens DetailMode for the chosen session. */
  onSelect: (id: string) => void;
  /**
   * When `highlight` is true, the enclosing accordion auto-scrolls this
   * card into view. We forward a ref so the parent can imperatively
   * scroll without an ID hash.
   */
  scrollRef?: React.Ref<HTMLElement>;
  /** AC20: the session the user clicked `DUP` on. Marks that member. */
  originSessionId?: string | null;
  /** Truthy for ~3s after chip nav; drives the fade-out on the marker. */
  originActive?: boolean;
  /** Forwarded ref to the originating <li> for scrollIntoView targeting. */
  originMemberRef?: React.Ref<HTMLLIElement>;
}

function kindSummary(kind: MergedDuplicateCluster['kind']): React.ReactNode {
  // Lowercase inside the attribution label per Decision 18 examples.
  return <SourceAttribution kind={kind} />;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function DuplicateClusterCard({
  cluster,
  sessionsById,
  highlight = false,
  onSelect,
  scrollRef,
  originSessionId = null,
  originActive = false,
  originMemberRef,
}: DuplicateClusterCardProps) {
  const members = cluster.sessionIds
    .map((id) => sessionsById.get(id))
    .filter((s): s is UnifiedSessionEntry => s !== undefined);

  return (
    <article
      ref={scrollRef}
      className={`lcars-dup-cluster${highlight ? ' lcars-dup-cluster--highlight' : ''}`}
      aria-label={`duplicate cluster, ${cluster.sessionIds.length} sessions`}
      data-cluster-id={cluster.id}
    >
      <header className="lcars-dup-cluster__header">
        <span className="lcars-dup-cluster__badge">
          DUP ({cluster.sessionIds.length}){kindSummary(cluster.kind)}
        </span>
        <span className="lcars-dup-cluster__hash" title={cluster.hash}>
          {cluster.id}
        </span>
      </header>
      <p className="lcars-dup-cluster__sample">“{truncate(cluster.sampleText, 220)}”</p>
      <ul className="lcars-dup-cluster__members" role="list">
        {members.map((s) => {
          const isOrigin = originSessionId !== null && s.id === originSessionId;
          const originCls = isOrigin && originActive ? ' lcars-dup-cluster__member--origin' : '';
          return (
            <li
              key={`${s.source}:${s.id}`}
              className={`lcars-dup-cluster__member${originCls}`}
              {...(isOrigin && originMemberRef ? { ref: originMemberRef } : {})}
              {...(isOrigin ? { 'data-origin': 'true' } : {})}
            >
              <span
                role="button"
                tabIndex={0}
                className="lcars-dup-cluster__member-link"
                style={
                  { ['--source-color' as string]: SOURCE_COLOR[s.source] } as React.CSSProperties
                }
                onClick={() => onSelect(s.id)}
                onKeyDown={(e) => onActivate(e, () => onSelect(s.id))}
                aria-label={`open ${s.title || 'Untitled session'}${isOrigin ? ' (originating session)' : ''}`}
              >
                <span className="lcars-dup-cluster__member-title">
                  {s.title || 'Untitled session'}
                </span>
              </span>
            </li>
          );
        })}
        {members.length === 0 && (
          <li className="lcars-dup-cluster__member-empty">
            (members not found in current manifest)
          </li>
        )}
      </ul>
    </article>
  );
}
