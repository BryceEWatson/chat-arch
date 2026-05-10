import type { UnifiedSessionEntry, Narrative } from '@chat-arch/schema';
import { SOURCE_COLOR } from '../types.js';
import { formatRelative } from '../util/time.js';
import { onActivate } from '../util/a11y.js';
import { SourcePill } from './SourcePill.js';
import { SourceAttribution } from './SourceAttribution.js';
import type { SessionDuplicateInfo } from '../data/mergeDuplicates.js';

export interface SessionCardProps {
  session: UnifiedSessionEntry;
  onSelect: (id: string) => void;
  /** Now used for relative-time formatting; pass from parent `useMemo(() => Date.now())`. */
  now?: number;
  /**
   * When this session appears in a merged duplicate cluster, the parent
   * passes the info here and we render `DUP (N) · {kind}` chip. Clicking
   * navigates to CONSTELLATION (Decision 14 / Q11).
   */
  duplicateInfo?: SessionDuplicateInfo;
  /**
   * When this session's project is classified zombie by the heuristic
   * classifier, the parent passes `true` and we render the ZOMBIE chip.
   */
  isZombieProject?: boolean;
  /**
   * When `true`, this session's `project` label came from the Phase 3
   * semantic classifier rather than a string match / CLI ground truth.
   * Renders the project chip with a `~` prefix so users know it's an
   * inference. Defaults to `false`.
   */
  isSemanticProject?: boolean;
  /**
   * v2 spec §5.3: topic chips. Each entry is the topic's `displayName`.
   * Renders a row of compact chips below the project label. Empty /
   * undefined renders nothing.
   */
  topics?: readonly string[];
  /**
   * v2 spec §5.3: narrative-attachment chip. When this session is
   * referenced by one or more narratives, render a chip whose color
   * tracks the dominant sentiment. Click opens the project-detail
   * narrative view (Phase 6) — for Phase 5 the chip is informational.
   */
  narratives?: readonly Narrative[];
  /**
   * Navigation handler for chip clicks. Receives the targeted cluster id
   * (for DUP) or `null` (for ZOMBIE — no cluster, just the zombie filter).
   */
  onDuplicateChipClick?: (clusterId: string, sessionId: string) => void;
  onZombieChipClick?: (sessionId: string) => void;
  /**
   * v2 spec §5.3: narrative chip click handler. Receives the first
   * attached narrative's id; the host routes to the project detail
   * page in Phase 6. When unset, the chip renders as a static badge.
   */
  onNarrativeChipClick?: (narrativeId: string, projectId: string) => void;
}

const NA = '—';

function formatCost(n: number | null): string {
  if (n === null) return NA;
  // Meaningful zero is shown as $0.00, not em-dash.
  return `$${n.toFixed(2)}`;
}

function formatTurns(
  userTurns: number | null | undefined,
  assistantTurns: number | null | undefined,
): string {
  const u = userTurns ?? undefined;
  const a = assistantTurns ?? undefined;
  return `${u === undefined ? NA : u}→${a === undefined ? NA : a}`;
}

function topToolsList(topTools: Readonly<Record<string, number>> | undefined): string {
  if (!topTools) return NA;
  const entries = Object.entries(topTools);
  if (entries.length === 0) return NA;
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}×${v}`)
    .join('  ');
}

/**
 * Build a full-list tooltip string for TOOLS. Lists every tool with its
 * count (sorted by count desc, then name asc for stable ordering), plus a
 * "(top 3 shown)" suffix when the visible cell truncates.
 */
function toolsTooltip(topTools: Readonly<Record<string, number>> | undefined): string | undefined {
  if (!topTools) return undefined;
  const entries = Object.entries(topTools);
  if (entries.length === 0) return 'no tool usage recorded';
  const sorted = entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} × ${v}`);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const header = `${entries.length} tool${entries.length === 1 ? '' : 's'} · ${total} total calls`;
  const truncated = entries.length > 3 ? '\n(top 3 shown on the card)' : '';
  return `${header}\n${sorted.join('\n')}${truncated}`;
}

/**
 * Build a breakdown tooltip for COST. Distinguishes exact (CLI logs) from
 * estimate (rate-table inference) and calls out when no cost signal is
 * present so the em-dash isn't silent. Cloud cards don't render the COST
 * cell at all (the claude.ai export carries no cost data — see the render
 * gate below), so this helper only needs to cover CLI sources.
 */
function costTooltip(totalCostUsd: number | null, estimatedUsd: number | null | undefined): string {
  if (totalCostUsd !== null) {
    return `Exact cost from CLI logs: $${totalCostUsd.toFixed(2)}`;
  }
  if (typeof estimatedUsd === 'number') {
    return `Estimated from rate table: $${estimatedUsd.toFixed(2)}\n(no CLI cost data for this session)`;
  }
  return 'No cost signal for this session — neither CLI logs nor an estimate are available.';
}

/** Tooltip for MODEL cells that are em-dash on CLI sources. */
function modelTooltip(model: string | null): string {
  if (model !== null) return model;
  return 'No model recorded';
}

/** Strip the most common markdown syntax from a preview blurb. */
function stripMarkdown(s: string): string {
  return s.replace(/[#*`>]/g, '');
}

export function SessionCard({
  session,
  onSelect,
  now,
  duplicateInfo,
  isZombieProject = false,
  isSemanticProject = false,
  topics,
  narratives,
  onDuplicateChipClick,
  onZombieChipClick,
  onNarrativeChipClick,
}: SessionCardProps) {
  const borderColor = SOURCE_COLOR[session.source];
  const preview = session.preview ?? '(no preview)';
  const title = session.title || 'Untitled session';
  const model = session.model ?? NA;
  const tools = topToolsList(session.topTools);
  const relTime = formatRelative(session.updatedAt, now);

  // Cost attribution — when the session has no exact cost but has an
  // estimate, we label the COST value with `· estimate` per Decision 18.
  // When totalCostUsd is present, we label it `· exact`.
  const hasExact = session.totalCostUsd !== null;
  const hasEstimate = !hasExact && typeof session.costEstimatedUsd === 'number';
  const displayCost = hasExact
    ? formatCost(session.totalCostUsd)
    : hasEstimate
      ? formatCost(session.costEstimatedUsd as number)
      : NA;

  // Chip clicks must NOT trigger the card's open-detail handler. We stop
  // propagation on both mouse and keyboard activation paths.
  const stop = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
  };

  // Render the 4-col meta footer (TURNS / TOOLS / MODEL / COST) as a true
  // `<dl>` grid so each label sits atop its value — the load-bearing
  // structure from the readability pass. Values use tabular-nums for
  // column-aligned digits; model takes the JetBrains Mono + ice override.
  // Cloud sessions come from the claude.ai Privacy Export, which is
  // content-only — no model identity, no token counts, no cost data. Rather
  // than render two permanently-empty cells on every cloud card, we omit
  // them and let the meta grid shrink to TURNS + TOOLS. The CLOUD source
  // pill + the TierSheet blurb + the CostMode banner collectively document
  // the limitation; duplicating "not exported" on every row is noise.
  const isCloud = session.source === 'cloud';

  // v2 spec §5.3: deep-link anchor. The id lets `/sessions#session-{id}`
  // scroll to the card without forcing a route change. Source is part
  // of the React key but NOT the anchor — manifest ids are unique
  // enough to round-trip URLs.
  const anchorId = `session-${session.id}`;

  // Pick the dominant sentiment for the narrative chip's accent color.
  // For Phase 5 we render a single chip even when multiple narratives
  // attach — the chip count badge says how many. Negative wins ties
  // because it's the more actionable signal (corrective-prompt flow
  // per spec §8 vs. encode-as-pattern celebration per §9).
  const narrativeChip = (() => {
    if (!narratives || narratives.length === 0) return null;
    const hasNegative = narratives.some((n) => n.sentiment === 'negative');
    const sentiment: 'negative' | 'positive' = hasNegative ? 'negative' : 'positive';
    const first = narratives[0]!;
    return { sentiment, count: narratives.length, first };
  })();

  return (
    <div
      id={anchorId}
      className="lcars-session-card"
      data-source={session.source}
      style={{ ['--source-color' as string]: borderColor } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`open ${title}`}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => onActivate(e, () => onSelect(session.id))}
    >
      <div className="lcars-session-card__row lcars-session-card__row--top">
        <SourcePill source={session.source} active readonly />
        {session.project &&
          (isSemanticProject ? (
            // Semantic-inferred label: `~` prefix + italic styling so
            // users can distinguish a model-inferred match from the
            // string-match ground truth without a tooltip hover.
            <span
              className="lcars-session-card__project lcars-session-card__project--semantic"
              title={`project (inferred by topic similarity): ${session.project}`}
            >
              ↳ ~{session.project}
            </span>
          ) : (
            <span className="lcars-session-card__project" title={`project: ${session.project}`}>
              ↳ {session.project}
            </span>
          ))}
        <time className="lcars-session-card__time">{relTime}</time>
        {(duplicateInfo || isZombieProject || narrativeChip) && (
          <div className="lcars-session-card__chips">
            {narrativeChip &&
              (onNarrativeChipClick ? (
                <span
                  role="button"
                  tabIndex={0}
                  className={`lcars-chip lcars-chip--narrative lcars-chip--narrative-${narrativeChip.sentiment}`}
                  aria-label={`${narrativeChip.count} narrative${narrativeChip.count === 1 ? '' : 's'} attached (${narrativeChip.sentiment}), click to open project view`}
                  onClick={(e) => {
                    stop(e);
                    onNarrativeChipClick(narrativeChip.first.id, narrativeChip.first.projectId);
                  }}
                  onKeyDown={(e) =>
                    onActivate(e, () => {
                      onNarrativeChipClick(narrativeChip.first.id, narrativeChip.first.projectId);
                    })
                  }
                >
                  NARR ({narrativeChip.count})
                </span>
              ) : (
                <span
                  className={`lcars-chip lcars-chip--narrative lcars-chip--narrative-${narrativeChip.sentiment}`}
                  aria-label={`${narrativeChip.count} narrative${narrativeChip.count === 1 ? '' : 's'} attached (${narrativeChip.sentiment})`}
                  title={narrativeChip.first.title}
                >
                  NARR ({narrativeChip.count})
                </span>
              ))}
            {duplicateInfo &&
              (onDuplicateChipClick ? (
                <span
                  role="button"
                  tabIndex={0}
                  className="lcars-chip lcars-chip--dup"
                  aria-label={`duplicate cluster with ${duplicateInfo.memberCount} sessions`}
                  onClick={(e) => {
                    stop(e);
                    onDuplicateChipClick(duplicateInfo.cluster.id, session.id);
                  }}
                  onKeyDown={(e) =>
                    onActivate(e, () => {
                      onDuplicateChipClick(duplicateInfo.cluster.id, session.id);
                    })
                  }
                >
                  DUP ({duplicateInfo.memberCount})
                  <SourceAttribution kind={duplicateInfo.cluster.kind} />
                </span>
              ) : (
                // Phase 3 cut the constellation drill-in target, so the
                // chip is informational only when no click handler is
                // supplied — keep the badge so the user still sees the
                // duplicate-cluster signal at a glance.
                <span
                  className="lcars-chip lcars-chip--dup"
                  aria-label={`duplicate cluster with ${duplicateInfo.memberCount} sessions`}
                >
                  DUP ({duplicateInfo.memberCount})
                  <SourceAttribution kind={duplicateInfo.cluster.kind} />
                </span>
              ))}
            {isZombieProject &&
              (onZombieChipClick ? (
                <span
                  role="button"
                  tabIndex={0}
                  className="lcars-chip lcars-chip--zombie"
                  aria-label="project classified zombie"
                  onClick={(e) => {
                    stop(e);
                    onZombieChipClick(session.id);
                  }}
                  onKeyDown={(e) => onActivate(e, () => onZombieChipClick(session.id))}
                >
                  ZOMBIE
                  <SourceAttribution kind="heuristic" />
                </span>
              ) : (
                <span className="lcars-chip lcars-chip--zombie" aria-label="project classified zombie">
                  ZOMBIE
                  <SourceAttribution kind="heuristic" />
                </span>
              ))}
          </div>
        )}
      </div>
      {topics && topics.length > 0 && (
        <div
          className="lcars-session-card__topics"
          role="list"
          aria-label="session topics"
        >
          {topics.map((t) => (
            <span
              key={t}
              role="listitem"
              className="lcars-chip lcars-chip--topic"
              title={`topic: ${t}`}
            >
              # {t}
            </span>
          ))}
        </div>
      )}
      <div
        className={`lcars-session-card__title${
          session.titleSource === 'fallback' ? ' lcars-session-card__title--fallback' : ''
        }`}
        title={title}
      >
        {title}
      </div>
      <div
        className={`lcars-session-card__preview${session.preview === null ? ' lcars-session-card__preview--empty' : ''}`}
      >
        {session.preview === null ? preview : stripMarkdown(preview).slice(0, 240)}
      </div>
      <dl className="lcars-session-card__meta">
        <div className="lcars-session-card__meta-cell">
          <dt>TURNS</dt>
          <dd title={`${session.userTurns ?? NA} user → ${session.assistantTurns ?? NA} assistant`}>
            {formatTurns(session.userTurns, session.assistantTurns)}
          </dd>
        </div>
        <div className="lcars-session-card__meta-cell">
          <dt>TOOLS</dt>
          <dd title={toolsTooltip(session.topTools)}>{tools}</dd>
        </div>
        {!isCloud && (
          <>
            <div className="lcars-session-card__meta-cell lcars-session-card__meta-cell--model">
              <dt>MODEL</dt>
              <dd
                className="lcars-session-card__meta--model"
                title={modelTooltip(session.model)}
              >
                {model}
              </dd>
            </div>
            <div className="lcars-session-card__meta-cell">
              <dt>COST</dt>
              <dd title={costTooltip(session.totalCostUsd, session.costEstimatedUsd)}>
                {hasExact ? formatCost(session.totalCostUsd) : displayCost}
                {hasExact ? (
                  <SourceAttribution kind="exact" />
                ) : hasEstimate ? (
                  <SourceAttribution kind="estimate" />
                ) : null}
              </dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );
}
