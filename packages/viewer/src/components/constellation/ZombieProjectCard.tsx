import { SourceAttribution } from '../SourceAttribution.js';
import { formatShortDate } from '../../util/time.js';

/**
 * One zombie-project row for CONSTELLATION (Decision 20, tier-1).
 *
 * Payload shape matches `analysis/zombies.heuristic.json` as spec'd in
 * the plan's Schema contract. We only depend on a minimal structural
 * subset so viewer code stays decoupled from the exporter's TS type.
 */

export interface ZombieProject {
  id: string;
  displayName: string;
  sessionCount: number;
  firstActiveAt: number;
  lastActiveAt: number;
  daysSinceLast: number;
  classification: 'active' | 'dormant' | 'zombie';
  probeSessionIds: readonly string[];
  burstWindows: ReadonlyArray<{ start: number; end: number; count: number }>;
  inferenceSource: 'project_field' | 'cwd_basename' | 'title_keyword';
}

export interface ZombieProjectCardProps {
  project: ZombieProject;
}

/**
 * Minimalist lifecycle "sparkline": a series of squares, one per burst
 * window, sized by count. Gives a feel for "bursts with gaps between"
 * which is the probe-gap signature the classifier keys on.
 */
function BurstSparkline({ bursts }: { bursts: ZombieProjectCardProps['project']['burstWindows'] }) {
  if (bursts.length === 0) return null;
  const maxCount = bursts.reduce((a, b) => Math.max(a, b.count), 1);
  return (
    <div className="lcars-zombie-card__sparkline" aria-hidden="true">
      {bursts.map((b, i) => {
        const size = Math.round(6 + (b.count / maxCount) * 14);
        return (
          <span
            key={i}
            className="lcars-zombie-card__burst"
            style={{ width: `${size}px`, height: `${size}px` }}
            title={`${b.count} sessions from ${formatShortDate(b.start)} to ${formatShortDate(b.end)}`}
          />
        );
      })}
    </div>
  );
}

export function ZombieProjectCard({ project }: ZombieProjectCardProps) {
  return (
    <article
      className={`lcars-zombie-card lcars-zombie-card--${project.classification}`}
      aria-label={`zombie project ${project.displayName}, ${project.classification}`}
    >
      <header className="lcars-zombie-card__header">
        <h4 className="lcars-zombie-card__name">{project.displayName}</h4>
        <span className="lcars-zombie-card__class">
          {project.classification.toUpperCase()}
          <SourceAttribution kind="heuristic" />
        </span>
      </header>
      <div className="lcars-zombie-card__stats">
        <span>
          <dt>SESSIONS</dt>
          <dd>{project.sessionCount}</dd>
        </span>
        <span>
          <dt>LAST</dt>
          <dd>{formatShortDate(project.lastActiveAt)}</dd>
        </span>
        <span>
          <dt>DAYS AGO</dt>
          <dd>{project.daysSinceLast}</dd>
        </span>
        <span>
          <dt>PROBES</dt>
          <dd>{project.probeSessionIds.length}</dd>
        </span>
      </div>
      <BurstSparkline bursts={project.burstWindows} />
      <footer className="lcars-zombie-card__footer">
        source: {project.inferenceSource.replace(/_/g, ' ')}
      </footer>
    </article>
  );
}
