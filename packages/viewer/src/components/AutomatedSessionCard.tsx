import type { CollapsedSessionRow } from '@chat-arch/analysis';
import { SOURCE_COLOR } from '../types.js';
import { formatRelative } from '../util/time.js';
import { onActivate } from '../util/a11y.js';
import { stripMarkdown } from '../util/stripMarkdown.js';
import { SourcePill } from './SourcePill.js';

/** Discriminated to the automated arm so the props are exhaustive. */
type AutomatedRow = Extract<CollapsedSessionRow, { kind: 'automated' }>;

export interface AutomatedSessionCardProps {
  /** The collapsed automated group to render. */
  row: AutomatedRow;
  /** Open the representative member's detail view. */
  onSelect: (id: string) => void;
  /** Now, for relative-time formatting (matches SessionCard). */
  now?: number;
}

const NA = '—';

function formatCost(n: number | null): string {
  if (n === null) return NA;
  return `$${n.toFixed(2)}`;
}

/**
 * Card for a COLLAPSED automated-session group — N near-identical
 * templated runs in one project folded into a single row. Visually
 * distinct from a normal {@link SessionCard}: an "AUTOMATED" tag, the
 * template label as the title, a "×{instanceCount}" badge, and the
 * AGGREGATE cost across the group. Clicking opens the representative
 * (most-recently-updated) member — we deliberately do NOT build an
 * expand-members UI (the whole point is to de-pollute the grid).
 */
export function AutomatedSessionCard({ row, onSelect, now }: AutomatedSessionCardProps) {
  const rep = row.representative;
  const borderColor = SOURCE_COLOR[rep.source];
  const relTime = formatRelative(row.updatedAt, now);
  // Exact cost when present, else the summed rate-table estimate (the
  // automated cli-direct runs that dominate carry estimate only). Mirrors
  // the KPI's exact-or-estimate accounting so the card agrees with it.
  const costIsExact = row.totalCostUsd !== null;
  const costValue = costIsExact ? row.totalCostUsd : row.costEstimatedUsd;
  const costKnown = costValue !== null && costValue !== undefined;
  const cost = formatCost(costValue ?? null);
  const costDisplay = costKnown && !costIsExact ? `${cost} est` : cost;
  const projectLabel = row.project ?? 'UNKNOWN';

  // The representative's preview/title give the group a human-readable
  // face without claiming to summarize all members.
  const preview =
    rep.preview === null
      ? '(templated run — no user-turn text)'
      : stripMarkdown(rep.preview).slice(0, 240);

  const cardAriaLabel =
    `open automated group: ${row.label}, ${row.instanceCount} runs in project ` +
    `${projectLabel}, aggregate cost ${costKnown ? costDisplay : 'unknown'}, ${relTime}`;

  return (
    <div
      className="lcars-session-card lcars-session-card--automated"
      data-source={rep.source}
      data-template={row.automationTemplateId}
      style={{ ['--source-color' as string]: borderColor } as React.CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={cardAriaLabel}
      onClick={() => onSelect(rep.id)}
      onKeyDown={(e) => onActivate(e, () => onSelect(rep.id))}
    >
      <div className="lcars-session-card__row lcars-session-card__row--top">
        <SourcePill source={rep.source} active readonly />
        <span className="lcars-session-card__project" aria-hidden="true">
          <span aria-hidden="true">↳ </span>
          {projectLabel}
        </span>
        <time className="lcars-session-card__time">{relTime}</time>
        <div className="lcars-session-card__chips">
          <span className="lcars-chip lcars-chip--automated" aria-hidden="true">
            AUTOMATED
          </span>
          <span
            className="lcars-chip lcars-chip--instance-count"
            aria-label={`${row.instanceCount} runs collapsed`}
          >
            ×{row.instanceCount.toLocaleString()}
          </span>
        </div>
      </div>
      <div className="lcars-session-card__title" title={row.label}>
        {row.label}
      </div>
      <div className="lcars-session-card__preview">{preview}</div>
      <dl className="lcars-session-card__meta">
        <div className="lcars-session-card__meta-cell">
          <dt>RUNS</dt>
          <dd>
            <span aria-hidden="true">{row.instanceCount.toLocaleString()}</span>
            <span className="sr-only">
              {' '}
              {row.instanceCount} collapsed automated run{row.instanceCount === 1 ? '' : 's'}
            </span>
          </dd>
        </div>
        <div className="lcars-session-card__meta-cell">
          <dt>COST</dt>
          <dd
            title={
              !costKnown
                ? 'No cost signal across the group'
                : `Aggregate ${costIsExact ? '' : 'estimated '}cost across ${row.instanceCount} runs: ${costDisplay}`
            }
          >
            <span aria-hidden="true">{costKnown ? costDisplay : cost}</span>
            <span className="sr-only">
              {' '}
              {!costKnown
                ? 'aggregate cost unknown'
                : `aggregate ${costIsExact ? '' : 'estimated '}cost ${costDisplay} across ${row.instanceCount} runs`}
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}
