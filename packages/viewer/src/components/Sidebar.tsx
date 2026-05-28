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
  /**
   * Phase 4 hosted refocus. Drives whether the CORRECTIONS entry is
   * rendered at all. The corrections panel is a dead end on a hosted
   * static build with no corrections.json, no applied-improvements
   * ledger, and no `/api/mine-corrections` endpoint — surfacing the
   * sidebar item would route a first-time visitor into an empty
   * surface with no path forward. Hide it. Defaults to `true` so
   * existing local-dev callers + tests keep the previous behavior.
   */
  correctionsAvailable?: boolean;
}

interface NavItem {
  mode: Mode;
  label: string;
  short: string;
  /**
   * One-line tooltip shown on hover + as the long-form aria-label so
   * sighted + SR users get a "what does this mode do?" cue without
   * having to click in. Each mode label by itself
   * (EFFECTIVENESS / INSIGHTS / DECISIONS / TRENDS) is opaque to a
   * cold visitor; the tooltip carries the one-sentence framing the
   * cold visitor needs.
   */
  tooltip: string;
}

interface NavGroup {
  group: 'FIX RULES' | 'BROWSE' | 'ANALYTICS' | 'EXPORT';
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
//   ANALYTICS  → Projects, Topics — descriptive surfaces that answer
//                "what's in my corpus", collapsed by default so they
//                don't crowd the workshop. (Phase 3 cut the
//                ANALYSIS / constellation entry — duplicates and zombie
//                projects didn't earn their slot in the rail — and the
//                COST entry — cost analytics doesn't drive a patch
//                decision so it didn't earn one either.)
//
// `detail` is intentionally missing — it's a drill-in surface reached by
// clicking a session card, not a top-level mode.
const NAV: readonly NavGroup[] = [
  {
    // CHAT joins the FIX RULES group because asking the corpus for its
    // own patterns / opportunities IS a practice-correction primitive —
    // distinct from the BROWSE group (which navigates the corpus by
    // hand) and the ANALYTICS group (descriptive roll-ups). Placing it
    // leftmost in the rail also surfaces the "ask your archive" verb
    // first on every fresh load.
    group: 'FIX RULES',
    items: [
      {
        mode: 'chat',
        label: 'CHAT',
        short: 'CHT',
        tooltip: 'Ask the corpus a question about your own sessions',
      },
      {
        mode: 'corrections',
        label: 'CORRECTIONS',
        short: 'COR',
        tooltip:
          'Patterns mined from moments where you pushed back on the assistant',
      },
      {
        mode: 'practice',
        label: 'PRACTICE',
        short: 'PRC',
        tooltip: 'Ranked list of what to look at right now — the curator feed',
      },
      // Stream J — DECISIONS + TRUST live under FIX RULES because they
      // both surface "what should I change about how I'm working with
      // the assistant" — the same workshop loop CORRECTIONS owns.
      {
        mode: 'decisions',
        label: 'DECISIONS',
        short: 'DEC',
        tooltip:
          'Decisions you made in past sessions, joined to the outcome they led to',
      },
      {
        mode: 'trust',
        label: 'TRUST',
        short: 'TRU',
        tooltip: 'Claim-verification audit — how often does the assistant misrepresent?',
      },
    ],
  },
  {
    group: 'BROWSE',
    items: [
      {
        mode: 'command',
        label: 'SESSIONS',
        short: 'SES',
        tooltip: 'Full grid of every session in the corpus, filterable by project',
      },
    ],
  },
  {
    group: 'ANALYTICS',
    items: [
      // Outcome-substrate Phase 1 surfaces. EFFECTIVENESS surfaces the
      // weekly composite-score trajectory; INSIGHTS collects the three
      // descriptive-contrast cards (config-window snapshots, knowledge-
      // debt clusters, reflexive matched-pair). They live in ANALYTICS
      // because they're descriptive roll-ups — they don't drive a patch
      // decision (which is what the FIX RULES group is for).
      {
        mode: 'effectiveness',
        label: 'EFFECTIVENESS',
        short: 'EFF',
        tooltip: 'Weekly composite-score trajectory — is your collaboration improving?',
      },
      {
        mode: 'insights',
        label: 'INSIGHTS',
        short: 'INS',
        tooltip:
          'Config-change impact + recurring debt + reflexive matched-pair cards',
      },
      // Stream J — TRENDS rolls up project trajectory + archetypes +
      // surface comparison + skill curves; same descriptive-roll-up
      // shape as EFFECTIVENESS / INSIGHTS.
      {
        mode: 'trends',
        label: 'TRENDS',
        short: 'TRN',
        tooltip:
          'Per-project trajectories, workflow archetypes, and skill-curve trends',
      },
      {
        mode: 'projects',
        label: 'PROJECTS',
        short: 'PRJ',
        tooltip: 'All projects detected in the corpus + their session counts',
      },
      {
        mode: 'topics',
        label: 'TOPICS',
        short: 'TOP',
        tooltip:
          'Emergent topics discovered from conversation content (cross-project themes)',
      },
    ],
  },
  {
    // Stream J #7 — EXPORT is its own top-level entry near the end:
    // it's an action (generate artifacts), not a content surface, so it
    // gets its own one-item group rather than slotting into ANALYTICS.
    group: 'EXPORT',
    items: [
      {
        mode: 'export',
        label: 'EXPORT',
        short: 'EXP',
        tooltip: 'Generate per-session post-mortems + knowledge-debt markdown',
      },
    ],
  },
];

// Horizontal-variant pill order is independent of the vertical groups
// so collapse-state never hides primary nav on mobile. Order mirrors
// the FIX RULES → BROWSE → ANALYTICS reading order from the vertical
// rail so muscle memory carries across viewports.
const HORIZONTAL_PILL_ORDER: readonly NavItem[] = NAV.flatMap((g) => g.items);

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
  correctionsAvailable = true,
}: SidebarProps) {
  // Phase 4 — filter the CORRECTIONS entry out of the nav model when
  // there's nothing to show. PRACTICE remains under FIX RULES so the
  // group still has a member; if the host wants to hide it too, that
  // belongs in a follow-up. Done at the model level so both vertical
  // and horizontal variants see the same filtered set without per-
  // variant branching at the render site.
  const filterCorrections = (item: NavItem): boolean =>
    correctionsAvailable || item.mode !== 'corrections';
  const navGroups: readonly NavGroup[] = NAV.map((g) => ({
    group: g.group,
    items: g.items.filter(filterCorrections),
  }));
  const horizontalPills: readonly NavItem[] =
    HORIZONTAL_PILL_ORDER.filter(filterCorrections);
  if (variant === 'horizontal') {
    return (
      <nav className="lcars-sidebar lcars-sidebar--horizontal" aria-label="primary">
        {/*
          Dropped role="tablist". The children are role="button" with
          aria-current="page" (a navigation pattern, not a tabs pattern);
          ARIA composition required role="tab" children to be valid. The
          surrounding <nav aria-label="primary"> already provides the
          landmark; the <ul> is structural.
        */}
        <ul className="lcars-sidebar__pill-bar">
          {horizontalPills.map((item) => {
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
                  aria-label={`mode ${item.label} — ${item.tooltip}`}
                  title={item.tooltip}
                  style={style}
                  onClick={() => onSelectMode(item.mode)}
                  onKeyDown={(e) => onActivate(e, () => onSelectMode(item.mode))}
                >
                  <span className="lcars-sidebar__pill-short" aria-hidden="true">
                    {item.short}
                  </span>
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
                <span className="lcars-sidebar__pill-short" aria-hidden="true">
                  {DATA_ITEM_SHORT}
                </span>
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
      {navGroups.map((g) => {
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
                      aria-label={`mode ${item.label} — ${item.tooltip}`}
                      title={item.tooltip}
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
