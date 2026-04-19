export interface DetailMissingProps {
  reason?: string;
}

export function DetailMissing({ reason }: DetailMissingProps) {
  return (
    <section className="lcars-detail-missing" role="status">
      <h2 className="lcars-detail-missing__title">NO TRANSCRIPT</h2>
      <p className="lcars-detail-missing__reason">
        This session has no drill-in body available.
        {reason ? ` (${reason})` : ''}
      </p>
    </section>
  );
}
