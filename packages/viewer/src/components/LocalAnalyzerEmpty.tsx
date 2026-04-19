/**
 * Reusable empty state for Phase-7-reserved views (Decision 15, AC17).
 *
 * When a tier-2 analysis file is absent the corresponding view renders
 * one of these instead of silently degrading. The component doubles as
 * documentation — it tells the user:
 *   1. What's missing (title from the parent section).
 *   2. How to unlock it (install the `chat-arch-analyzer` skill +
 *      `pnpm analyze`).
 *   3. What it'd cost against their current manifest.
 *
 * The CTA text format is fixed per `[AC17]`:
 *
 *   `LOCAL ANALYZER REQUIRED — install chat-arch-analyzer skill and
 *    run 'pnpm analyze'. Est. cost ~$X against your current 1,464-session
 *    manifest.`
 *
 * The `$X` is a prop (`estCostUsd`) so COST / ZOMBIE / DUP sections can
 * all use the same component with their own estimates. The session count
 * is also a prop so the component doesn't hardcode today's corpus size.
 *
 * A short `title` + optional `preview` prop lets parent sections add a
 * "what this would show" blurb above the CTA — useful inside the
 * CONSTELLATION accordion (Decision 20) where each sub-section needs
 * specific context before the generic CTA.
 */

export interface LocalAnalyzerEmptyProps {
  /**
   * Section title shown above the CTA. Example: `SEMANTIC CLUSTERS`,
   * `RE-SOLVED PROBLEMS`, `COST · DIAGNOSED`.
   */
  title: string;
  /**
   * Estimated USD cost to run the analyzer against the current manifest.
   * Rendered with two decimals.
   */
  estCostUsd: number;
  /** Number of sessions in the current manifest; shown in the CTA copy. */
  sessionCount: number;
  /**
   * Optional "what this would show" preview copy above the CTA. Keeps
   * the cold-user from parsing the empty state as a broken feature.
   */
  preview?: string;
}

function formatUsd(n: number): string {
  // Two decimals, thousands separators. `0` → `$0.00`.
  const rounded = Math.round(n * 100) / 100;
  return `$${rounded.toFixed(2)}`;
}

function formatSessionCount(n: number): string {
  // Use locale 'en-US' for comma-thousands — matches plan fixture format
  // ("1,464-session manifest").
  return n.toLocaleString('en-US');
}

export function LocalAnalyzerEmpty({
  title,
  estCostUsd,
  sessionCount,
  preview,
}: LocalAnalyzerEmptyProps) {
  const ctaText =
    `LOCAL ANALYZER REQUIRED — install chat-arch-analyzer skill and run 'pnpm analyze'. ` +
    `Est. cost ~${formatUsd(estCostUsd)} against your current ${formatSessionCount(sessionCount)}-session manifest.`;
  return (
    <section
      className="lcars-local-analyzer-empty"
      aria-label={`${title} — local analyzer required`}
    >
      <header className="lcars-local-analyzer-empty__header">
        <h3 className="lcars-local-analyzer-empty__title">{title}</h3>
      </header>
      {preview ? <p className="lcars-local-analyzer-empty__preview">{preview}</p> : null}
      <p className="lcars-local-analyzer-empty__cta">{ctaText}</p>
    </section>
  );
}
