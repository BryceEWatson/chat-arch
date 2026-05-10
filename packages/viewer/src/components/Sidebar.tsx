import type { Mode } from '../types.js';
import { MODE_COLOR } from '../types.js';
import { onActivate } from '../util/a11y.js';
import { RepoLink } from './RepoLink.js';

export type SidebarVariant = 'vertical' | 'horizontal';

export interface SidebarProps {
  mode: Mode;
  onSelectMode: (m: Mode) => void;
  /**
   * v2 spec §6 / decision D4: an additional sidebar item that opens the
   * DATA panel (UPLOAD CLOUD / SCAN LOCAL / DELETE ALL). Optional so
   * tests and embeddings without a host data layer can still render the
   * sidebar in isolation.
   */
  onOpenDataPanel?: () => void;
  /** True when the data panel is currently open — flips the DATA item's aria-pressed. */
  dataPanelOpen?: boolean;
  /**
   * `vertical` (default) — the full-desktop / tablet double-elbow sidebar.
   * `horizontal` — Tier C mobile layout: a scrollable pill bar that takes
   * over the sidebar role below 600px.
   */
  variant?: SidebarVariant;
  /**
   * Phase 2a: ANALYTICS is collapsible — defaults to collapsed so the
   * primary refocus surfaces (CORRECTIONS / PRACTICE / SESSIONS) sit
   * above the fold. Optional so embeddings without persisted state
   * still render at default-collapsed.
   */
  analyticsCollapsed?: boolean;
  onToggleAnalyticsCollapsed?: () => void;
}

interface NavItem {
  mode: Mode;
  label: string;
  short: string;
}

interface NavGroup {
  group: 'FIX RULES' | 'BROWSE' | 'ANALYTICS';
  items: readonly NavItem[];
}

// Phase 2a refocus IA: three-tier IA aligned to the new "audit your
// practice" framing.
//   FIX RULES  → Corrections, Practice — where the user goes to act
//                on their own behavior changes. (Earlier label was
//                "WORKSHOP"; the eval flagged it as too abstract for
//                first-time users — "FIX RULES" announces the loop's
//                outcome verb-first.)
//   BROWSE     → Sessions — the v1 grid surface, kept lightweight.
//   ANALYTICS  → Projects, Topics, Cost — descriptive surfaces that
//                answer "what's in my corpus", collapsed by default so
//                they don't crowd the workshop. (Phase 3 cut the
//                ANALYSIS / constellation entry — duplicates and zombie
//                projects didn't earn their slot in the rail.)
//
// `detail` is intentionally missing — it's a drill-in surface reached by
// clicking a session card, not a top-level mode.
const NAV: readonly NavGroup[] = [
  {
    group: 'FIX RULES',
    items: [
      { mode: 'corrections', label: 'CORRECTIONS', short: 'COR' },
      { mode: 'practice', label: 'PRACTICE', short: 'PRC' },
    ],
  },
  {
    group: 'BROWSE',
    items: [{ mode: 'command', label: 'SESSIONS', short: 'SES' }],
  },
  {
    group: 'ANALYTICS',
    items: [
      { mode: 'projects', label: 'PROJECTS', short: 'PRJ' },
      { mode: 'topics', label: 'TOPICS', short: 'TOP' },
      { mode: 'cost', label: 'COST', short: 'CST' },
    ],
  },
];

// Horizontal-variant pill order is independent of the vertical groups
// so collapse-state never hides primary nav on mobile. Order mirrors
// the FIX RULES → BROWSE → ANALYTICS reading order from the vertical
// rail so muscle memory carries across viewports.
const HORIZONTAL_PILL_ORDER: readonly NavItem[] = [
  { mode: 'corrections', label: 'CORRECTIONS', short: 'COR' },
  { mode: 'practice', label: 'PRACTICE', short: 'PRC' },
  { mode: 'command', label: 'SESSIONS', short: 'SES' },
  { mode: 'projects', label: 'PROJECTS', short: 'PRJ' },
  { mode: 'topics', label: 'TOPICS', short: 'TOP' },
  { mode: 'cost', label: 'COST', short: 'CST' },
];

// DATA item is rendered separately from the mode-driven nav: it's a
// panel trigger, not a content surface, so it doesn't slot into the
// `Mode` enum or the FIX-RULES/BROWSE/ANALYTICS groupings. The accent
// borrows the destructive peach used by the existing data-source chip
// cluster.
const DATA_ITEM_LABEL = 'DATA';
const DATA_ITEM_SHORT = 'DAT';
const DATA_ITEM_COLOR = 'var(--lcars-peach)';

export function Sidebar({
  mode,
  onSelectMode,
  onOpenDataPanel,
  dataPanelOpen = false,
  variant = 'vertical',
  analyticsCollapsed = false,
  onToggleAnalyticsCollapsed,
}: SidebarProps) {
  if (variant === 'horizontal') {
    return (
      <nav className="lcars-sidebar lcars-sidebar--horizontal" aria-label="primary">
        <ul className="lcars-sidebar__pill-bar" role="tablist">
          {HORIZONTAL_PILL_ORDER.map((item) => {
            const active = item.mode === mode;
            const style = {
              ['--mode-color' as string]: MODE_COLOR[item.mode],
            } as React.CSSProperties;
            return (
              <li key={item.mode}>
                <div
                  className={`lcars-sidebar__pill${active ? ' lcars-sidebar__pill--active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-current={active ? 'page' : undefined}
                  aria-label={`mode ${item.label}`}
                  style={style}
                  onClick={() => onSelectMode(item.mode)}
                  onKeyDown={(e) => onActivate(e, () => onSelectMode(item.mode))}
                >
                  <span className="lcars-sidebar__pill-short">{item.short}</span>
                </div>
              </li>
            );
          })}
          {onOpenDataPanel && (
            <li>
              <div
                className={`lcars-sidebar__pill lcars-sidebar__pill--data${dataPanelOpen ? ' lcars-sidebar__pill--active' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={dataPanelOpen}
                aria-label="open DATA panel"
                style={{ ['--mode-color' as string]: DATA_ITEM_COLOR } as React.CSSProperties}
                onClick={onOpenDataPanel}
                onKeyDown={(e) => onActivate(e, onOpenDataPanel)}
              >
                <span className="lcars-sidebar__pill-short">{DATA_ITEM_SHORT}</span>
              </div>
            </li>
          )}
        </ul>
        {/*
          Mobile also needs a way to reach the repo. Without this the
          trust claim ("view source to verify") becomes mobile-unreachable
          the moment the user loads data — TrustStrip only renders on
          the empty state. Rendering the chip trailing the pill bar
          keeps it within the same horizontal band the user's thumb is
          already on.
        */}
        <div className="lcars-sidebar__footer lcars-sidebar__footer--horizontal">
          <RepoLink variant="chip" />
        </div>
      </nav>
    );
  }

  return (
    <nav className="lcars-sidebar" aria-label="primary">
      {/*
        Top elbow: butterscotch rectangle with one rounded corner per the
        canonical design-system shape (radius.elbow-lg = 40px desktop,
        radius.elbow = 32px mobile, 36px tablet — see
        design-system/tokens.json + spec.md §4 "Shapes"). v2 keeps only
        the top elbow — the bottom elbow is dropped per spec §10's
        "left-edge-only frame" constraint, so the sidebar's lower edge
        is bare. The earlier single-L SVG with concave quarter-arc was a
        divergence from the design system and has been retired.
      */}
      <div className="lcars-sidebar__elbow lcars-sidebar__elbow--top" aria-hidden="true" />
      {NAV.map((g) => {
        const isAnalytics = g.group === 'ANALYTICS';
        const collapsed = isAnalytics && analyticsCollapsed;
        const groupClass =
          'lcars-sidebar__group' +
          (collapsed ? ' lcars-sidebar__group--collapsed' : '');
        const labelClass =
          'lcars-sidebar__group-label' +
          (isAnalytics && onToggleAnalyticsCollapsed
            ? ' lcars-sidebar__group-label--toggle'
            : '');
        return (
          <div key={g.group} className={groupClass}>
            {isAnalytics && onToggleAnalyticsCollapsed ? (
              <div
                className={labelClass}
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                aria-controls={`lcars-sidebar-list-${g.group.toLowerCase()}`}
                aria-label={`${collapsed ? 'expand' : 'collapse'} ${g.group} group`}
                onClick={onToggleAnalyticsCollapsed}
                onKeyDown={(e) => onActivate(e, onToggleAnalyticsCollapsed)}
              >
                {g.group}
              </div>
            ) : (
              <div className={labelClass} aria-hidden="true">
                {g.group}
              </div>
            )}
            <ul
              className="lcars-sidebar__list"
              id={`lcars-sidebar-list-${g.group.toLowerCase()}`}
            >
              {g.items.map((item) => {
                const active = item.mode === mode;
                const style = {
                  ['--mode-color' as string]: MODE_COLOR[item.mode],
                } as React.CSSProperties;
                // Why role=button on a div here: v7 LCARS iteration found that native
                // <button> UA styles (Firefox on Windows in particular) blew past
                // our LCARS `background-color` and left gray-button chrome visible.
                // The shared onActivate helper keeps keyboard parity with <button>.
                return (
                  <li key={item.mode}>
                    <div
                      className={`lcars-sidebar__item${active ? ' lcars-sidebar__item--active' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-current={active ? 'page' : undefined}
                      aria-label={`mode ${item.label}`}
                      style={style}
                      onClick={() => onSelectMode(item.mode)}
                      onKeyDown={(e) => onActivate(e, () => onSelectMode(item.mode))}
                    >
                      <span className="lcars-sidebar__item-short" aria-hidden="true">
                        {item.short}
                      </span>
                      <span className="lcars-sidebar__item-label">{item.label}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {onOpenDataPanel && (
        <div className="lcars-sidebar__group lcars-sidebar__group--actions">
          <div className="lcars-sidebar__group-label" aria-hidden="true">
            ACTIONS
          </div>
          <ul className="lcars-sidebar__list">
            <li>
              <div
                className={`lcars-sidebar__item lcars-sidebar__item--data${dataPanelOpen ? ' lcars-sidebar__item--active' : ''}`}
                role="button"
                tabIndex={0}
                aria-pressed={dataPanelOpen}
                aria-label="open DATA panel"
                style={{ ['--mode-color' as string]: DATA_ITEM_COLOR } as React.CSSProperties}
                onClick={onOpenDataPanel}
                onKeyDown={(e) => onActivate(e, onOpenDataPanel)}
              >
                <span className="lcars-sidebar__item-short" aria-hidden="true">
                  {DATA_ITEM_SHORT}
                </span>
                <span className="lcars-sidebar__item-label">{DATA_ITEM_LABEL}</span>
              </div>
            </li>
          </ul>
        </div>
      )}
      {/*
        Footer: SOURCE ↗ chip linking to the open-source repo. Lives
        between the last nav group and the bottom elbow so the elbow
        still anchors the rail visually while the link sits in a
        dedicated slot. `mt: auto` on the elbow's existing rule pushes
        both toward the bottom of the rail when the mode list is short.
      */}
      <div className="lcars-sidebar__footer">
        <RepoLink variant="chip" />
      </div>
    </nav>
  );
}
