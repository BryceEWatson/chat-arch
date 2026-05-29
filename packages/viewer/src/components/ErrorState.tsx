export interface ErrorStateProps {
  title?: string;
  detail: string;
  onRetry?: () => void;
  /**
   * When `true`, the component renders as `role="alert"` (assertive
   * live region). Default `false` — uses `role="status"` (polite) so
   * recoverable per-mode errors don't interrupt SR users mid-sentence.
   * The top-level ErrorBoundary opts in by passing `assertive` for
   * fatal render failures (R12 F12.1).
   */
  assertive?: boolean;
}

export function ErrorState({
  title = 'TRANSMISSION ERROR',
  detail,
  onRetry,
  assertive = false,
}: ErrorStateProps) {
  return (
    // role="alert" implies aria-live="assertive" which interrupts current
    // SR speech — appropriate for unrecoverable boundary failures but
    // over-aggressive for per-mode sidecar-missing or transient fetch
    // errors. role="status" (polite) waits for a pause; callers opt in
    // to alert via `assertive`.
    <section className="lcars-error-state" role={assertive ? 'alert' : 'status'}>
      <h2 className="lcars-error-state__title">{title}</h2>
      <p className="lcars-error-state__detail">{detail}</p>
      {onRetry && (
        <button type="button" className="lcars-error-state__retry" onClick={onRetry}>
          RETRY
        </button>
      )}
    </section>
  );
}
