import type { Mode } from '../types.js';
import { MODE_COLOR } from '../types.js';
import { onActivate } from '../util/a11y.js';

export type SidebarVariant = 'vertical' | 'horizontal';

export interface SidebarProps {
  mode: Mode;
  onSelectMode: (m: Mode) => void;
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

// Two-tier IA (redesign handoff Phase 1):
//   BROWSE   → Command, Timeline   (list-y surfaces)
//   INSIGHTS → Analysis, Cost      (aggregate / pattern surfaces)
//
// `detail` is intentionally missing — it's a drill-in surface reached by
// clicking a session card, not a top-level mode. `constellation` is the
// deep-dive analysis workspace; we surface it under the "ANALYSIS" label
// (keeping the internal mode id stable avoids a cross-codebase rename).
const NAV: readonly NavGroup[] = [
  {
    group: 'BROWSE',
    items: [
      { mode: 'command', label: 'COMMAND', short: 'CMD' },
      { mode: 'timeline', label: 'TIMELINE', short: 'TIM' },
    ],
  },
  {
    group: 'INSIGHTS',
    items: [
      { mode: 'constellation', label: 'ANALYSIS', short: 'ANL' },
      { mode: 'cost', label: 'COST', short: 'CST' },
    ],
  },
];

const ALL_ITEMS: readonly NavItem[] = NAV.flatMap((g) => g.items);

export function Sidebar({ mode, onSelectMode, variant = 'vertical' }: SidebarProps) {
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
        </ul>
      </nav>
    );
  }

  return (
    <nav className="lcars-sidebar" aria-label="primary">
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
      <div className="lcars-sidebar__elbow lcars-sidebar__elbow--bottom" aria-hidden="true" />
    </nav>
  );
}
