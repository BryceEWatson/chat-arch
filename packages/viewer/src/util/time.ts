/**
 * Relative-time formatter and weekly-bucket helpers.
 *
 * No date-fns, no dayjs (plan decision 17). Thresholds per plan §17:
 *   <2h       -> "Nm ago" / "Nh ago"
 *   <3d       -> "Nd ago"
 *   same year -> "Mmm D"   (e.g. "Apr 2")
 *   else      -> "YYYY-MM-DD"
 */

const MS_MIN = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Format `timestamp` relative to `now`. Pure; safe under jsdom. */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  if (diff < 0) {
    // Future timestamps — fall through to absolute date.
    return formatAbsolute(timestamp, now);
  }
  if (diff < 2 * MS_HOUR) {
    if (diff < MS_HOUR) {
      const mins = Math.max(1, Math.floor(diff / MS_MIN));
      return `${mins}m ago`;
    }
    const hours = Math.floor(diff / MS_HOUR);
    return `${hours}h ago`;
  }
  if (diff < 3 * MS_DAY) {
    const days = Math.max(1, Math.floor(diff / MS_DAY));
    return `${days}d ago`;
  }
  return formatAbsolute(timestamp, now);
}

function formatAbsolute(ts: number, now: number): string {
  const d = new Date(ts);
  const nowD = new Date(now);
  if (d.getUTCFullYear() === nowD.getUTCFullYear()) {
    return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Min across a list of timestamps. Returns null when empty. */
export function minTimestamp(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let m = values[0] as number;
  for (const v of values) if (v < m) m = v;
  return m;
}

/** Max across a list of timestamps. Returns null when empty. */
export function maxTimestamp(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let m = values[0] as number;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** Floor `ts` to the start of its Sunday-00:00 UTC week. */
export function weekStart(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}

/** Human-friendly short date `MMM D` / `YYYY-MM-DD` (same rules as relative fallback). */
export function formatShortDate(ts: number, reference: number = Date.now()): string {
  return formatAbsolute(ts, reference);
}

export const TIME_CONST = { MS_MIN, MS_HOUR, MS_DAY };
