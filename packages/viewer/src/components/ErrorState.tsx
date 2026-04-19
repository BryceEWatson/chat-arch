export interface ErrorStateProps {
  title?: string;
  detail: string;
  onRetry?: () => void;
}

export function ErrorState({ title = 'TRANSMISSION ERROR', detail, onRetry }: ErrorStateProps) {
  return (
    <section className="lcars-error-state" role="alert">
      <h2 className="lcars-error-state__title">{title}</h2>
      <p className="lcars-error-state__detail">No data yet. {detail}</p>
      {onRetry && (
        <button type="button" className="lcars-error-state__retry" onClick={onRetry}>
          RETRY
        </button>
      )}
    </section>
  );
}
