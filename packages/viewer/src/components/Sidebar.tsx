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
}

interface NavItem {
  mode: Mode;
  label: string;
  short: string;
}

interface NavGroup {
  group: 'BROWSE' | 'INSIGHTS';
  items: readonly NavItem[];
}

// Two-tier IA:
//   BROWSE   → Sessions          (the v1 grid surface)
//   INSIGHTS → Analysis, Cost    (aggregate / pattern surfaces)
//
// v2 spec §5.3 / decision D6a: TIMELINE is no longer a top-level surface;
// it's absorbed into SESSIONS as an in-surface view toggle. The internal
// `command` mode id is preserved for code stability — only the user-
// facing label flips to SESSIONS so the sidebar matches the spec naming.
//
// `detail` is intentionally missing — it's a drill-in surface reached by
// clicking a session card, not a top-level mode. `constellation` is the
// deep-dive analysis workspace; we surface it under the "ANALYSIS" label
// (keeping the internal mode id stable avoids a cross-codebase rename).
const NAV: readonly NavGroup[] = [
  {
    group: 'BROWSE',
    items: [
      // v2 spec §5.1: PROJECTS sits above SESSIONS in BROWSE — narratives
      // live on projects, so PROJECTS is where users land for insights
      // about how their work is going. SESSIONS is the v1 grid.
      { mode: 'projects', label: 'PROJECTS', short: 'PRJ' },
      { mode: 'topics', label: 'TOPICS', short: 'TOP' },
      { mode: 'command', label: 'SESSIONS', short: 'SES' },
    ],
  },
  {
    group: 'INSIGHTS',
    items: [
      // v2 spec §5.4 / D6b+D6c: PRACTICE leads INSIGHTS — it's the
      // primary audit surface and absorbs CONSTELLATION's "value
      // leaks" outputs + COST's outlier surfacing. The standalone
      // CONSTELLATION + COST entries remain accessible for deep-dives
      // until a follow-up phase consolidates their surfaces into
      // PRACTICE / per-project panels.
      { mode: 'practice', label: 'PRACTICE', short: 'PRC' },
      { mode: 'corrections', label: 'CORRECTIONS', short: 'COR' },
      { mode: 'constellation', label: 'ANALYSIS', short: 'ANL' },
      { mode: 'cost', label: 'COST', short: 'CST' },
    ],
  },
];

const ALL_ITEMS: readonly NavItem[] = NAV.flatMap((g) => g.items);

// DATA item is rendered separately from the mode-driven nav: it's a
// panel trigger, not a content surface, so it doesn't slot into the
// `Mode` enum or the BROWSE/INSIGHTS groupings. The accent borrows the
// destructive peach used by the existing data-source chip cluster.
const DATA_ITEM_LABEL = 'DATA';
const DATA_ITEM_SHORT = 'DAT';
const DATA_ITEM_COLOR = 'var(--lcars-peach)';

export function Sidebar({
  mode,
  onSelectMode,
  onOpenDataPanel,
  dataPanelOpen = false,
  variant = 'vertical',
}: SidebarProps) {
  if (variant === 'horizontal') {
    return (
      <nav className="lcars-sidebar lcars-sidebar--horizontal" aria-label="primary">
        <ul className="lcars-sidebar__pill-bar" role="tablist">
          {ALL_ITEMS.map((item) => {
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
      {NAV.map((g) => (
        <div key={g.group} className="lcars-sidebar__group">
          <div className="lcars-sidebar__group-label" aria-hidden="true">
            {g.group}
          </div>
          <ul className="lcars-sidebar__list">
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
      ))}
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
