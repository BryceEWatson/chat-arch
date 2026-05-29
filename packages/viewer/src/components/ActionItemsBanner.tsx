/**
 * Wave 6 #4 — post-scan action-items banner.
 * Wave 7 P1 #5 — delta-since-last-visit + Top-3 prioritization +
 * jargon translation. Major rewrite.
 *
 * The banner answers "what's new since last time I looked, and which
 * three things should I act on this week?" — it no longer dumps a
 * raw 69-item count on the user.
 *
 * Persistence: per-key cursors in `localStorage` under
 * `chat-arch.action-items-cursor`. Each cursor records the
 * `lastSeenAt` timestamp the user last engaged with (banner X
 * dismiss, or click-through to the target mode). On render we
 * compare the current count against the count at lastSeenAt to
 * decide what's new.
 *
 * Top 3 band: when sidecar data is present, the banner ranks one
 * representative from each of three buckets:
 *   - highest-confidence knowledge-debt cluster
 *   - biggest absolute-delta disjoint-CI ITS contrast
 *   - the active mis-calibration trust cell (binary; either it's
 *     fired or it isn't)
 * Deep links route to the relevant mode + (optionally) a hash anchor.
 *
 * Suppression rules:
 *   - When viewing DECISIONS, hide the "decisions awaiting classification" item.
 *   - When viewing INSIGHTS, hide the knowledge-debt + ITS items.
 *   - When viewing TRUST, hide the trust item.
 *   - When every item is zero or suppressed, the whole banner hides.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Mode } from '../types.js';

const CURSOR_STORAGE_KEY = 'chat-arch.action-items-cursor';

type ActionItemKind =
  | 'decisions'
  | 'knowledge-debt'
  | 'its'
  | 'trust-miscalibration';

interface CursorEntry {
  /** Item count seen at the time the cursor was updated. */
  countAtSeen: number;
  /** Unix ms when the cursor was last updated. */
  lastSeenAt: number;
}

type CursorState = Partial<Record<ActionItemKind, CursorEntry>>;

function loadCursor(): CursorState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CURSOR_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as CursorState;
  } catch {
    return {};
  }
}

function saveCursor(state: CursorState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CURSOR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage quota etc — best-effort.
  }
}

function formatRelative(ms: number, now: number): string {
  const delta = Math.max(0, now - ms);
  const day = 86_400_000;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) {
    const m = Math.round(delta / 60_000);
    return `${m} min${m === 1 ? '' : 's'} ago`;
  }
  if (delta < day) {
    const h = Math.round(delta / 3_600_000);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (delta < 7 * day) {
    const d = Math.round(delta / day);
    if (d === 1) return 'yesterday';
    // Weekday name for "Tuesday" style.
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
  }
  if (delta < 28 * day) {
    const w = Math.round(delta / (7 * day));
    return `${w} week${w === 1 ? '' : 's'} ago`;
  }
  return new Date(ms).toLocaleDateString();
}

/** Top-3 representative item — drives the priority band. */
export interface TopItem {
  kind: ActionItemKind;
  /** Short readable headline rendered as the link text. */
  headline: string;
  /** Tooltip / sub-text. */
  detail?: string;
  /** Mode to navigate to on click. */
  mode: Mode;
}

export interface ActionItemsBannerProps {
  /** Count of decisions whose classification is still null. */
  unclassifiedDecisions: number;
  /** Count of knowledge-debt clusters worth surfacing. */
  knowledgeDebtClusters: number;
  /** Count of ITS-contrast rows the user hasn't acknowledged. */
  unacknowledgedItsContrasts: number;
  /**
   * Whether the trust 2x2 has the mis-calibration flag fired. 1 when
   * fired, 0 when not (or when the data isn't loaded). Treated as a
   * count-of-1 affordance for cursor purposes.
   */
  trustMisCalibrationFired?: boolean;
  /** Current active mode — drives suppression of irrelevant items. */
  currentMode: Mode;
  /** Called when the user clicks a banner item. */
  onNavigate: (mode: Mode) => void;
  /**
   * Wave 7 P1 #5 — Top-3 representatives. Pre-computed by the parent
   * since it already has access to the sidecar data. Optional; when
   * absent the priority band is omitted.
   */
  topItems?: readonly TopItem[];
  /** Now-ms; defaults to `Date.now()` (tests override for determinism). */
  now?: number;
}

interface ListItem {
  kind: ActionItemKind;
  count: number;
  /** "N new since {relative}" — the headline. */
  primaryLabel: string;
  /** "show all M (incl. backlog)" subline label. */
  showAllLabel: string;
  /** True when the count is entirely new — UI accent. */
  allNew: boolean;
  /** Backlog (count - new). */
  backlog: number;
  mode: Mode;
}

function buildItems(
  counts: Record<ActionItemKind, number>,
  cursor: CursorState,
  now: number,
): ListItem[] {
  const friendly: Record<ActionItemKind, string> = {
    decisions: 'decisions awaiting classification',
    'knowledge-debt': 'recurring questions worth turning into rules',
    its: 'config changes worth reviewing',
    'trust-miscalibration': 'mis-calibration flag fired on the 2×2',
  };
  const navMode: Record<ActionItemKind, Mode> = {
    decisions: 'decisions',
    'knowledge-debt': 'insights',
    its: 'insights',
    'trust-miscalibration': 'trust',
  };
  const out: ListItem[] = [];
  for (const kindStr of Object.keys(counts)) {
    const kind = kindStr as ActionItemKind;
    const count = counts[kind];
    if (count <= 0) continue;
    const seen = cursor[kind];
    const seenCount = seen?.countAtSeen ?? 0;
    const newCount = Math.max(0, count - seenCount);
    const allNew = seenCount === 0;
    let primary: string;
    if (newCount === 0) {
      // Nothing new since last visit — surface as backlog only.
      primary = `${count} ${friendly[kind]} (no new)`;
    } else if (allNew) {
      primary = `${newCount} ${friendly[kind]}`;
    } else {
      const rel = seen ? formatRelative(seen.lastSeenAt, now) : 'last visit';
      primary = `${newCount} new since ${rel}`;
    }
    const showAllLabel =
      newCount < count
        ? `show all ${count} (incl. backlog)`
        : `show all ${count}`;
    out.push({
      kind,
      count,
      primaryLabel: primary,
      showAllLabel,
      allNew,
      backlog: Math.max(0, count - newCount),
      mode: navMode[kind],
    });
  }
  return out;
}

export function ActionItemsBanner({
  unclassifiedDecisions,
  knowledgeDebtClusters,
  unacknowledgedItsContrasts,
  trustMisCalibrationFired = false,
  currentMode,
  onNavigate,
  topItems = [],
  now = Date.now(),
}: ActionItemsBannerProps) {
  const [cursor, setCursor] = useState<CursorState>(() => loadCursor());
  const [dismissed, setDismissed] = useState<boolean>(false);

  // Reset the dismissed flag when counts change — a new SCAN should
  // pop the banner back even after the user X'd it.
  const countsKey =
    `${unclassifiedDecisions}|${knowledgeDebtClusters}|${unacknowledgedItsContrasts}|${trustMisCalibrationFired ? 1 : 0}`;
  useEffect(() => {
    setDismissed(false);
  }, [countsKey]);

  const counts: Record<ActionItemKind, number> = {
    decisions: currentMode === 'decisions' ? 0 : unclassifiedDecisions,
    'knowledge-debt': currentMode === 'insights' ? 0 : knowledgeDebtClusters,
    its: currentMode === 'insights' ? 0 : unacknowledgedItsContrasts,
    'trust-miscalibration':
      currentMode === 'trust' ? 0 : trustMisCalibrationFired ? 1 : 0,
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `counts` is rebuilt from the four numeric inputs on every render; we key on countsKey to dedupe.
  const items = useMemo(() => buildItems(counts, cursor, now), [countsKey, cursor, now]);

  if (dismissed) return null;
  if (items.length === 0 && topItems.length === 0) return null;

  // Headline new total — drives the lead line.
  const newTotal = items.reduce((sum, it) => {
    const seen = cursor[it.kind];
    const seenCount = seen?.countAtSeen ?? 0;
    return sum + Math.max(0, it.count - seenCount);
  }, 0);
  // Most-recent cursor across the visible kinds — drives "since X" copy.
  const mostRecentCursor = items
    .map((it) => cursor[it.kind]?.lastSeenAt ?? null)
    .filter((v): v is number => v !== null)
    .reduce<number | null>((max, v) => (max === null || v > max ? v : max), null);

  const headline =
    newTotal > 0
      ? mostRecentCursor !== null
        ? `${newTotal} new since ${formatRelative(mostRecentCursor, now)}`
        : `${newTotal} item${newTotal === 1 ? '' : 's'} need${newTotal === 1 ? 's' : ''} your attention`
      : items.length > 0
        ? 'No new items since last visit'
        : 'Top 3 this week';

  const updateCursorFor = (kind: ActionItemKind, count: number) => {
    setCursor((prev) => {
      const next: CursorState = {
        ...prev,
        [kind]: { countAtSeen: count, lastSeenAt: now },
      };
      saveCursor(next);
      return next;
    });
  };

  const onItemClick = (item: ListItem) => {
    updateCursorFor(item.kind, item.count);
    onNavigate(item.mode);
  };
  const onTopClick = (top: TopItem) => {
    // Top-3 click maps to the same kind as the list item — update the
    // matching cursor with whatever current count we know.
    const known = items.find((it) => it.kind === top.kind);
    if (known) updateCursorFor(top.kind, known.count);
    onNavigate(top.mode);
  };
  const onDismiss = () => {
    // X = "I've seen all of this" — sweep every visible kind's cursor.
    for (const it of items) updateCursorFor(it.kind, it.count);
    setDismissed(true);
  };

  return (
    <aside
      className="lcars-action-items"
      aria-label="items needing attention"
      data-testid="action-items-banner"
    >
      <div className="lcars-action-items__head">
        <span className="lcars-action-items__label" data-testid="action-items-headline">
          <strong>{headline}</strong>
        </span>
        <button
          type="button"
          className="lcars-action-items__dismiss"
          aria-label="dismiss action-items banner"
          data-testid="action-items-dismiss"
          onClick={onDismiss}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {topItems.length > 0 && (
        <div
          className="lcars-action-items__top3"
          aria-label="top 3 this week"
          data-testid="action-items-top3"
        >
          <span className="lcars-action-items__top3-label">
            Top 3 this week:
          </span>
          <ul className="lcars-action-items__top3-list" role="list">
            {topItems.slice(0, 3).map((t, i) => (
              <li key={`${t.kind}-${i}`} className="lcars-action-items__top3-item">
                <button
                  type="button"
                  className="lcars-action-items__top3-link"
                  onClick={() => onTopClick(t)}
                  title={t.detail ?? t.headline}
                  data-testid={`action-items-top3-link-${i}`}
                >
                  {t.headline}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {items.length > 0 && (
        <ul className="lcars-action-items__list" role="list">
          {items.map((item) => (
            <li key={item.kind} className="lcars-action-items__item">
              <button
                type="button"
                className="lcars-action-items__link"
                onClick={() => onItemClick(item)}
                data-testid={`action-items-link-${item.kind}`}
              >
                {item.primaryLabel}
              </button>
              {item.backlog > 0 && item.count !== item.backlog && (
                <span
                  className="lcars-action-items__backlog"
                  data-testid={`action-items-backlog-${item.kind}`}
                >
                  · {item.showAllLabel}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
