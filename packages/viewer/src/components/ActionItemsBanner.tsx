/**
 * Wave 6 #4 — post-scan action-items banner.
 *
 * Renders a thin strip at the top of any non-relevant mode summarizing
 * what awaits the user's attention after a SCAN: unclassified decisions,
 * knowledge-debt clusters, and unacknowledged config-impact contrasts.
 *
 * Suppression rules (each independently):
 *   - When viewing DECISIONS, hide the "unclassified decisions" item.
 *   - When viewing INSIGHTS, hide the knowledge-debt + ITS items.
 *   - When the corresponding count is 0, hide that item.
 *   - When ALL items are zero or suppressed, the whole banner is hidden.
 */

import type { Mode } from '../types.js';

export interface ActionItem {
  key: 'decisions' | 'knowledge-debt' | 'its';
  count: number;
  label: string;
  mode: Mode;
}

export interface ActionItemsBannerProps {
  /** Count of decisions whose classification is still null. */
  unclassifiedDecisions: number;
  /** Count of knowledge-debt clusters worth surfacing. */
  knowledgeDebtClusters: number;
  /** Count of ITS-contrast rows the user hasn't acknowledged. */
  unacknowledgedItsContrasts: number;
  /** Current active mode — drives suppression of irrelevant items. */
  currentMode: Mode;
  /** Called when the user clicks a banner item. */
  onNavigate: (mode: Mode) => void;
}

export function ActionItemsBanner({
  unclassifiedDecisions,
  knowledgeDebtClusters,
  unacknowledgedItsContrasts,
  currentMode,
  onNavigate,
}: ActionItemsBannerProps) {
  const items: ActionItem[] = [];
  if (unclassifiedDecisions > 0 && currentMode !== 'decisions') {
    items.push({
      key: 'decisions',
      count: unclassifiedDecisions,
      label:
        unclassifiedDecisions === 1
          ? '1 unclassified decision'
          : `${unclassifiedDecisions} unclassified decisions`,
      mode: 'decisions',
    });
  }
  if (knowledgeDebtClusters > 0 && currentMode !== 'insights') {
    items.push({
      key: 'knowledge-debt',
      count: knowledgeDebtClusters,
      label:
        knowledgeDebtClusters === 1
          ? '1 knowledge-debt cluster'
          : `${knowledgeDebtClusters} knowledge-debt clusters`,
      mode: 'insights',
    });
  }
  if (unacknowledgedItsContrasts > 0 && currentMode !== 'insights') {
    items.push({
      key: 'its',
      count: unacknowledgedItsContrasts,
      label:
        unacknowledgedItsContrasts === 1
          ? '1 unacknowledged config-impact contrast'
          : `${unacknowledgedItsContrasts} unacknowledged config-impact contrasts`,
      mode: 'insights',
    });
  }

  if (items.length === 0) return null;

  const total =
    unclassifiedDecisions +
    knowledgeDebtClusters +
    unacknowledgedItsContrasts;

  return (
    <aside
      className="lcars-action-items"
      aria-label="items needing attention"
      data-testid="action-items-banner"
    >
      <span className="lcars-action-items__label">
        <strong>{total}</strong>{' '}
        {total === 1 ? 'item needs' : 'items need'} your attention:
      </span>
      <ul className="lcars-action-items__list" role="list">
        {items.map((item) => (
          <li key={item.key} className="lcars-action-items__item">
            <button
              type="button"
              className="lcars-action-items__link"
              onClick={() => onNavigate(item.mode)}
              data-testid={`action-items-link-${item.key}`}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
