/**
 * Wave 7 P1 #4 — shared empty-state for the outcome-substrate modes.
 *
 * Before Wave 7 each of the six new modes (EFFECTIVENESS, INSIGHTS,
 * DECISIONS, TRUST, TRENDS, EXPORT) shipped its own empty copy
 * pointing at a CLI command — `pnpm exporter run start`. The QA
 * personas hit a wall: first-time and fatigued-returning users have
 * no idea what that means in context. They want a button.
 *
 * This component renders a uniform "no data yet" surface with an
 * inline OPEN DATA PANEL button. Modes pass `onOpenDataPanel` from
 * the host — the host (`ChatArchViewer`) already manages the
 * `dataPanelOpen` state used by the sidebar's DATA pill, so we
 * route through the same prop.
 */

export interface SidecarEmptyStateProps {
  /** Section title — e.g. "NO EFFECTIVENESS DATA". */
  title: string;
  /**
   * Mode-specific one-liner explaining what the sidecar populates
   * once the user runs SCAN LOCAL. Renders below the headline.
   */
  detail?: string;
  /**
   * Click handler for the inline OPEN DATA PANEL button. When
   * omitted the button is suppressed (some host contexts — embedded
   * tests, hosted demo — don't expose a data-panel toggle).
   */
  onOpenDataPanel?: () => void;
  /** Optional testid suffix so per-mode tests can disambiguate. */
  testId?: string;
}

const STANDARD_BODY =
  'No data yet. Open DATA → SCAN LOCAL to populate.';

export function SidecarEmptyState({
  title,
  detail,
  onOpenDataPanel,
  testId,
}: SidecarEmptyStateProps) {
  return (
    // Dropped role="status" + aria-live="polite": the section wraps a
    // <h2> + paragraph + button (CTA) — too large for "status message",
    // and polite re-announce on every mode swap reads the entire panel
    // aloud. Heading nav surfaces the <h2> already.
    <section
      className="lcars-empty-state lcars-empty-state--sidecar"
      data-testid={testId ?? 'sidecar-empty-state'}
    >
      <h2 className="lcars-empty-state__title">{title}</h2>
      <p className="lcars-empty-state__message">{STANDARD_BODY}</p>
      {detail !== undefined && detail.length > 0 && (
        <p className="lcars-empty-state__message lcars-empty-state__message--muted">
          {detail}
        </p>
      )}
      {onOpenDataPanel !== undefined && (
        <button
          type="button"
          className="lcars-empty-state__cta"
          onClick={onOpenDataPanel}
          data-testid="open-data-panel-cta"
        >
          OPEN DATA PANEL
        </button>
      )}
    </section>
  );
}
