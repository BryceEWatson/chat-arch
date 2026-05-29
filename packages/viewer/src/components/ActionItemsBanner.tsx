/**
 * Wave 6 #4 — post-scan action-items banner.
 * Wave 7 P1 #5 — delta-since-last-visit + jargon translation.
 * Redesign (2026-05) — de-conflated layout: "counts lead, examples
 * support".
 *
 * The banner used to fuse three jobs into one line — a global
 * "N new since {date}" headline, a "Top 3 this week" curated band,
 * and a backlog list — and the wiring crossed wires: the headline
 * count came from one bucket while its "since {date}" anchor came
 * from another, "Top 3" promised three items but the source could
 * only ever yield two, and the same total appeared twice. The
 * redesign separates the two regions cleanly:
 *
 *   1. Action rows (lead). One row per non-zero / non-suppressed
 *      bucket: "<count> <friendly label>" + an HONEST per-row delta
 *      ("N new since {date}" / "no new since {date}") where the count
 *      and the date describe the SAME bucket + a destination cue.
 *      No global headline number — the count and its date never
 *      come from different buckets again.
 *   2. "Worth a look" examples (support). Concrete representatives
 *      (knowledge-debt cluster, ITS contrast) the parent pre-computes.
 *      Renders however many exist (0-2); no "Top 3" over-promise.
 *
 * Persistence: per-key cursors in `localStorage` under
 * `chat-arch.action-items-cursor`. Each cursor records the
 * `lastSeenAt` timestamp + the count seen at that time; on render we
 * compare the current count against the count at lastSeenAt to decide
 * what's new for THAT bucket.
 *
 * Suppression rules:
 *   - When viewing DECISIONS, hide the "decisions awaiting classification" item.
 *   - When viewing INSIGHTS, hide the knowledge-debt + ITS items.
 *   - When viewing TRUST, hide the trust item.
 *   - When every item is zero or suppressed and there are no examples,
 *     the whole banner hides.
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

/** "Worth a look" representative item — drives the examples strip. */
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
   * "Worth a look" representatives. Pre-computed by the parent since it
   * already has access to the sidecar data. Optional; when absent the
   * examples strip is omitted.
   */
  topItems?: readonly TopItem[];
  /** Now-ms; defaults to `Date.now()` (tests override for determinism). */
  now?: number;
}

interface ListItem {
  kind: ActionItemKind;
  count: number;
  /** "{count} {friendly}" — always the real total for this bucket. */
  primaryLabel: string;
  /**
   * Honest per-row delta. "" when the bucket has never been seen (the
   * count itself is the news); else "N new since {rel}" or
   * "no new since {rel}". Count and date always describe THIS bucket.
   */
  deltaLabel: string;
  /** Short uppercase destination cue ("Review" / "Insights" / "Trust"). */
  destLabel: string;
  mode: Mode;
}

const FRIENDLY: Record<ActionItemKind, string> = {
  decisions: 'decisions awaiting classification',
  'knowledge-debt': 'recurring questions worth turning into rules',
  its: 'config changes worth reviewing',
  'trust-miscalibration': 'mis-calibration flag fired on the 2×2',
};
const NAV_MODE: Record<ActionItemKind, Mode> = {
  decisions: 'decisions',
  'knowledge-debt': 'insights',
  its: 'insights',
  'trust-miscalibration': 'trust',
};
const DEST_LABEL: Record<ActionItemKind, string> = {
  decisions: 'Review',
  'knowledge-debt': 'Insights',
  its: 'Insights',
  'trust-miscalibration': 'Trust',
};

function buildItems(
  counts: Record<ActionItemKind, number>,
  cursor: CursorState,
  now: number,
): ListItem[] {
  const out: ListItem[] = [];
  for (const kindStr of Object.keys(counts)) {
    const kind = kindStr as ActionItemKind;
    const count = counts[kind];
    if (count <= 0) continue;
    const seen = cursor[kind];
    const seenCount = seen?.countAtSeen ?? 0;
    const newCount = Math.max(0, count - seenCount);
    // Delta only when we have a prior cursor to anchor "since {date}"
    // against — otherwise the count itself is the news.
    let deltaLabel = '';
    if (seen) {
      const rel = formatRelative(seen.lastSeenAt, now);
      deltaLabel =
        newCount > 0 ? `${newCount} new since ${rel}` : `no new since ${rel}`;
    }
    out.push({
      kind,
      count,
      primaryLabel: `${count} ${FRIENDLY[kind]}`,
      deltaLabel,
      destLabel: DEST_LABEL[kind],
      mode: NAV_MODE[kind],
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
    // Examples click maps to the same kind as the list item — update the
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
          <strong>Needs attention</strong>
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
              {item.deltaLabel && (
                <span
                  className="lcars-action-items__delta"
                  data-testid={`action-items-delta-${item.kind}`}
                >
                  {item.deltaLabel}
                </span>
              )}
              <span className="lcars-action-items__dest" aria-hidden="true">
                {item.destLabel} →
              </span>
            </li>
          ))}
        </ul>
      )}
      {topItems.length > 0 && (
        <div
          className="lcars-action-items__examples"
          aria-label="worth a look"
          data-testid="action-items-examples"
        >
          <span className="lcars-action-items__examples-label">
            Worth a look
          </span>
          <ul className="lcars-action-items__examples-list" role="list">
            {topItems.map((t, i) => (
              <li key={`${t.kind}-${i}`} className="lcars-action-items__examples-item">
                <button
                  type="button"
                  className="lcars-action-items__examples-link"
                  onClick={() => onTopClick(t)}
                  title={t.detail ?? t.headline}
                  data-testid={`action-items-examples-link-${i}`}
                >
                  {t.headline}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
