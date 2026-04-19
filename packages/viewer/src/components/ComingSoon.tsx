export interface ComingSoonProps {
  mode: string;
}

export function ComingSoon({ mode }: ComingSoonProps) {
  return (
    <section className="lcars-coming-soon" role="status">
      <h2 className="lcars-coming-soon__title">{mode.toUpperCase()}</h2>
      <p className="lcars-coming-soon__body">COMING IN v1.1</p>
    </section>
  );
}
