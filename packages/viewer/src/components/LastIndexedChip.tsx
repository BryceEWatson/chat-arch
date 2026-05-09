/**
 * LastIndexedChip — TopBar info chip showing how stale the on-disk
 * manifest is. Mirrors the EARTHDATE chip's visual treatment but is
 * derived from `manifest.generatedAt` instead of "today" so a returning
 * user can see at a glance whether they're looking at fresh data or a
 * snapshot from weeks ago.
 *
 * Stale threshold (>30 days) flips the chip to the peach warning
 * palette and surfaces a CTA in the tooltip that points at UPDATE
 * LOCAL — the chip is informational only; the action lives in the
 * DATA panel where rescans actually run.
 *
 * Returns null when `generatedAt` is null (no manifest yet) so the
 * chip silently disappears in pre-data states rather than rendering
 * a placeholder the user has to interpret.
 */
export interface LastIndexedChipProps {
  /** ms-since-epoch from manifest.generatedAt; null → no chip. */
  generatedAt: number | null;
  /** Injectable "now" for deterministic tests; defaults to `Date.now()`. */
  now?: number;
}

const MS_PER_DAY = 86_400_000;
const STALE_DAYS_THRESHOLD = 30;

export function LastIndexedChip({ generatedAt, now }: LastIndexedChipProps) {
  if (generatedAt == null) return null;
  const ref = now ?? Date.now();
  const days = Math.floor((ref - generatedAt) / MS_PER_DAY);
  const label = days < 1 ? 'INDEXED TODAY' : `INDEXED ${days}d AGO`;
  const isStale = days > STALE_DAYS_THRESHOLD;
  const iso = new Date(generatedAt).toISOString();
  const tooltip = `${iso}\nRun UPDATE LOCAL to refresh`;
  return (
    <div
      className="lcars-top-bar__indexed"
      data-stale={isStale ? '' : undefined}
      title={tooltip}
      aria-label={`last indexed ${days < 1 ? 'today' : `${days} days ago`}`}
    >
      <span className="lcars-top-bar__indexed-value">{label}</span>
    </div>
  );
}
