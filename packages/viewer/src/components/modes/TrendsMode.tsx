import { useMemo, useState } from 'react';
import { THRESHOLDS } from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';
import type {
  ArchetypesFile,
  ProjectTrajectoriesFile,
  ProjectTrajectoryEntry,
  SkillCurvesFile,
  SurfaceCell,
  SurfaceComparisonFile,
  TrajectoryClassification,
} from '../../data/trendsLoader.js';

/**
 * Stream J #5 — TRENDS surface.
 *
 * Four sub-sections, each a section of the same Mode:
 *
 *   1. PROJECT TRAJECTORY — per-project sparkline + classification pill.
 *   2. WORKFLOW ARCHETYPES — list of centroids; click filters the
 *      Trends sessions list to that archetype.
 *   3. CROSS-SURFACE COMPARISON — matrix heatmap (source × archetype);
 *      cells with n < `THRESHOLDS.display.minNForRate` are greyed.
 *      Cells flagged from Holm-Bonferroni-significant pairs carry an
 *      indicator chip.
 *   4. SKILL CURVES — per-topic sparkline grouped by classification.
 *      BH-FDR adjusted p surfaced inline.
 *
 * All copy is descriptive — "correlates with", "overrepresented among" —
 * never "predicts" / "causes".
 */

export interface TrendsModeProps {
  trajectories: ProjectTrajectoriesFile | null;
  archetypes: ArchetypesFile | null;
  surfaceComparison: SurfaceComparisonFile | null;
  skillCurves: SkillCurvesFile | null;
  /** Optional click-through for sessions assigned to a centroid. */
  onSelectSession?: (id: string) => void;
}

const CLASSIFICATION_LABEL: Record<TrajectoryClassification, string> = {
  accelerating: 'ACCELERATING',
  flat: 'FLAT',
  stalling: 'STALLING',
  'stalled-finished': 'STALLED — FINISHED',
};

const CLASSIFICATION_TONE: Record<TrajectoryClassification, string> = {
  accelerating: 'positive',
  flat: 'neutral',
  stalling: 'negative',
  'stalled-finished': 'neutral',
};

/** Tiny inline sparkline. Not the shared <Sparkline /> — that one is
 *  source-stacked weekly buckets and far heavier than what trends needs.
 *  Here we just want a 1-line min/max-normalized polyline. */
interface TinySparkProps {
  values: readonly number[];
  width?: number;
  height?: number;
  ariaLabel?: string;
  /** Optional className to control stroke color via CSS. */
  className?: string;
}

function TinySpark({
  values,
  width = 100,
  height = 24,
  ariaLabel,
  className,
}: TinySparkProps) {
  if (values.length === 0) {
    return (
      <span
        className={'lcars-trends__spark lcars-trends__spark--empty' + (className ? ' ' + className : '')}
        aria-label={ariaLabel ?? 'no data'}
      >
        —
      </span>
    );
  }
  if (values.length === 1) {
    // Render a centered dot rather than a polyline for the n=1 case.
    return (
      <svg
        className={'lcars-trends__spark' + (className ? ' ' + className : '')}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel ?? 'single point'}
      >
        <circle cx={width / 2} cy={height / 2} r="2" />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - 2 - ((v - min) / range) * (height - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className={'lcars-trends__spark' + (className ? ' ' + className : '')}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? 'trend'}
    >
      <polyline fill="none" strokeWidth="1.5" points={points} />
    </svg>
  );
}

export function TrendsMode({
  trajectories,
  archetypes,
  surfaceComparison,
  skillCurves,
  onSelectSession,
}: TrendsModeProps) {
  const anyDataLoaded =
    trajectories !== null ||
    archetypes !== null ||
    surfaceComparison !== null ||
    skillCurves !== null;

  if (!anyDataLoaded) {
    return (
      <EmptyState
        title="NO TRENDS DATA"
        message="TRENDS reads analysis/project-trajectories.json, archetypes.json, surface-comparison.json, skill-curves.json. Run the exporter to generate them."
      />
    );
  }

  return (
    <div className="lcars-trends" aria-label="trends">
      <header className="lcars-trends__header">
        <h2 className="lcars-trends__title">TRENDS</h2>
        <p className="lcars-trends__lead">
          Four roll-ups over your archive: project trajectories, workflow archetypes,
          cross-surface comparison, and skill curves. Findings are descriptive — they
          surface correlations, never causal claims.
        </p>
      </header>

      <ProjectTrajectorySection trajectories={trajectories} />
      <ArchetypesSection
        archetypes={archetypes}
        {...(onSelectSession ? { onSelectSession } : {})}
      />
      <SurfaceComparisonSection surfaceComparison={surfaceComparison} />
      <SkillCurvesSection skillCurves={skillCurves} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section 1: PROJECT TRAJECTORY
// ─────────────────────────────────────────────────────────────────────

interface ProjectTrajectorySectionProps {
  trajectories: ProjectTrajectoriesFile | null;
}

function ProjectTrajectorySection({
  trajectories,
}: ProjectTrajectorySectionProps) {
  if (trajectories === null || trajectories.projects.length === 0) {
    return (
      <section
        className="lcars-trends__section"
        aria-label="project trajectory"
      >
        <h3 className="lcars-trends__section-title">PROJECT TRAJECTORY</h3>
        <p className="lcars-trends__empty">No project trajectories available.</p>
      </section>
    );
  }
  return (
    <section className="lcars-trends__section" aria-label="project trajectory">
      <h3 className="lcars-trends__section-title">PROJECT TRAJECTORY</h3>
      <ul className="lcars-trends__project-list" role="list">
        {trajectories.projects.map((p) => (
          <ProjectTrajectoryRow key={p.projectId} project={p} />
        ))}
      </ul>
    </section>
  );
}

interface ProjectTrajectoryRowProps {
  project: ProjectTrajectoryEntry;
}

function ProjectTrajectoryRow({ project }: ProjectTrajectoryRowProps) {
  const classification: TrajectoryClassification =
    project.bootstrapStatus === 'series-too-short' ? 'flat' : project.classification;
  // Workaround for the "insufficient" label requirement — the trajectory
  // schema collapses too-short series to "flat" upstream, so we surface
  // an additional inline note rather than introducing a fifth label.
  const insufficient = project.bootstrapStatus === 'series-too-short';
  return (
    <li className="lcars-trends__project-row" data-classification={classification}>
      <span className="lcars-trends__project-name" title={project.projectId}>
        {project.projectName}
      </span>
      <TinySpark
        values={project.series}
        ariaLabel={`${project.projectName} rolling-window outcome series`}
      />
      <span
        className={`lcars-trends__pill lcars-trends__pill--${CLASSIFICATION_TONE[classification]}`}
        title={
          project.ci !== null
            ? `slope ${(project.slope ?? 0).toFixed(3)} · CI [${project.ci.low.toFixed(3)}, ${project.ci.high.toFixed(3)}]`
            : 'series too short for bootstrap'
        }
      >
        {insufficient ? 'INSUFFICIENT' : CLASSIFICATION_LABEL[classification]}
      </span>
      <span className="lcars-trends__project-meta">
        n={project.totalSessions} · 30d={project.recentSessions}
      </span>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section 2: WORKFLOW ARCHETYPES
// ─────────────────────────────────────────────────────────────────────

interface ArchetypesSectionProps {
  archetypes: ArchetypesFile | null;
  onSelectSession?: (id: string) => void;
}

function ArchetypesSection({
  archetypes,
  onSelectSession,
}: ArchetypesSectionProps) {
  const [filterArchetypeId, setFilterArchetypeId] = useState<string | null>(null);

  const sessionsByArchetype = useMemo(() => {
    const m = new Map<string, string[]>();
    if (archetypes === null) return m;
    for (const [sid, aid] of Object.entries(archetypes.assignments)) {
      if (typeof aid !== 'string') continue;
      const arr = m.get(aid);
      if (arr) arr.push(sid);
      else m.set(aid, [sid]);
    }
    return m;
  }, [archetypes]);

  if (archetypes === null || archetypes.centroids.length === 0) {
    return (
      <section className="lcars-trends__section" aria-label="workflow archetypes">
        <h3 className="lcars-trends__section-title">WORKFLOW ARCHETYPES</h3>
        <p className="lcars-trends__empty">
          No archetypes available — run the archetypes builder.
        </p>
      </section>
    );
  }

  const filteredSessions =
    filterArchetypeId !== null
      ? sessionsByArchetype.get(filterArchetypeId) ?? []
      : [];

  return (
    <section className="lcars-trends__section" aria-label="workflow archetypes">
      <h3 className="lcars-trends__section-title">WORKFLOW ARCHETYPES</h3>
      <p className="lcars-trends__caption">
        k={archetypes.chosenK} · silhouette={archetypes.silhouette.toFixed(3)} ·
        version={archetypes.archetypeVersion}
      </p>
      <ul className="lcars-trends__centroid-list" role="list">
        {archetypes.centroids.map((c) => {
          const active = filterArchetypeId === c.archetypeId;
          return (
            <li key={c.archetypeId}>
              <button
                type="button"
                className={
                  'lcars-trends__centroid' +
                  (active ? ' lcars-trends__centroid--active' : '')
                }
                onClick={() =>
                  setFilterArchetypeId(active ? null : c.archetypeId)
                }
                aria-pressed={active}
                data-archetype-id={c.archetypeId}
              >
                <span className="lcars-trends__centroid-id">
                  {c.archetypeId.toUpperCase()}
                </span>
                <span className="lcars-trends__centroid-count">
                  {c.sessionCount} sessions
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {filterArchetypeId !== null && (
        <div
          className="lcars-trends__archetype-sessions"
          aria-label={`sessions in ${filterArchetypeId}`}
        >
          <p className="lcars-trends__caption">
            {filteredSessions.length} session
            {filteredSessions.length === 1 ? '' : 's'} in{' '}
            {filterArchetypeId.toUpperCase()}
          </p>
          <ul className="lcars-trends__session-list" role="list">
            {filteredSessions.slice(0, 50).map((sid) => (
              <li key={sid}>
                {onSelectSession ? (
                  <button
                    type="button"
                    className="lcars-trends__session-link"
                    onClick={() => onSelectSession(sid)}
                    title={sid}
                  >
                    ▸ {sid.slice(0, 16)}
                  </button>
                ) : (
                  <span title={sid}>{sid.slice(0, 16)}</span>
                )}
              </li>
            ))}
          </ul>
          {filteredSessions.length > 50 && (
            <p className="lcars-trends__caption">
              showing first 50 of {filteredSessions.length}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section 3: CROSS-SURFACE COMPARISON (matrix heatmap)
// ─────────────────────────────────────────────────────────────────────

interface SurfaceComparisonSectionProps {
  surfaceComparison: SurfaceComparisonFile | null;
}

function SurfaceComparisonSection({
  surfaceComparison,
}: SurfaceComparisonSectionProps) {
  if (surfaceComparison === null || surfaceComparison.cells.length === 0) {
    return (
      <section
        className="lcars-trends__section"
        aria-label="cross-surface comparison"
      >
        <h3 className="lcars-trends__section-title">CROSS-SURFACE COMPARISON</h3>
        <p className="lcars-trends__empty">
          No cross-surface comparison available.
        </p>
      </section>
    );
  }

  // Build axes.
  const sources = new Set<string>();
  const archetypes = new Set<string>();
  const byKey = new Map<string, SurfaceCell>();
  for (const cell of surfaceComparison.cells) {
    sources.add(cell.source);
    archetypes.add(cell.archetypeId);
    byKey.set(cell.key, cell);
  }
  const sortedSources = [...sources].sort();
  const sortedArchetypes = [...archetypes].sort();

  // Significant cell keys: collected from any pair where `significant`
  // is true. A cell is "involved in a significant pair" if it appears
  // as either side.
  const significantCellKeys = new Set<string>();
  for (const p of surfaceComparison.pairwise) {
    if (!p.significant) continue;
    significantCellKeys.add(p.a);
    significantCellKeys.add(p.b);
  }

  const minN = THRESHOLDS.display.minNForRate;

  return (
    <section
      className="lcars-trends__section"
      aria-label="cross-surface comparison"
    >
      <h3 className="lcars-trends__section-title">CROSS-SURFACE COMPARISON</h3>
      <p className="lcars-trends__caption">
        Holm-Bonferroni adjusted at α={surfaceComparison.familyAlpha}. Cells with
        n &lt; {minN} are greyed. Heatmap shade scales with good-share.
      </p>
      <table
        className="lcars-trends__matrix"
        role="table"
        aria-label="source × archetype heatmap"
      >
        <thead>
          <tr>
            <th scope="col" />
            {sortedArchetypes.map((a) => (
              <th key={a} scope="col">
                {a.replace(/^archetype-/, '').toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedSources.map((src) => (
            <tr key={src}>
              <th scope="row">{src.toUpperCase()}</th>
              {sortedArchetypes.map((a) => {
                const key = `${src}|${a}`;
                const cell = byKey.get(key);
                if (cell === undefined) {
                  return (
                    <td
                      key={a}
                      className="lcars-trends__matrix-cell lcars-trends__matrix-cell--empty"
                      data-cell={key}
                      data-testid={`heatmap-empty-${key}`}
                    >
                      —
                    </td>
                  );
                }
                const greyed = !cell.meetsDisplayN;
                const isSig = significantCellKeys.has(key);
                const shade = greyed
                  ? 0
                  : Math.max(0, Math.min(1, cell.pHat));
                const bg = greyed
                  ? 'var(--lcars-cell-grey, #555)'
                  : `rgba(127, 219, 127, ${0.15 + shade * 0.6})`;
                return (
                  <td
                    key={a}
                    className={
                      'lcars-trends__matrix-cell' +
                      (greyed ? ' lcars-trends__matrix-cell--greyed' : '') +
                      (isSig ? ' lcars-trends__matrix-cell--significant' : '')
                    }
                    data-cell={key}
                    data-testid={
                      greyed
                        ? `heatmap-greyed-${key}`
                        : `heatmap-cell-${key}`
                    }
                    data-significant={isSig ? 'true' : undefined}
                    style={{ backgroundColor: bg }}
                    title={
                      greyed
                        ? `n=${cell.n} < ${minN}`
                        : `${cell.good}/${cell.n} good · CI [${cell.ci.low.toFixed(2)}, ${cell.ci.high.toFixed(2)}]`
                    }
                  >
                    {greyed ? (
                      <span aria-label="insufficient n">n={cell.n}</span>
                    ) : (
                      <>
                        {Math.round(cell.pHat * 100)}%
                        {isSig && (
                          <sup
                            className="lcars-trends__sig-mark"
                            aria-label="significant after Holm-Bonferroni"
                          >
                            *
                          </sup>
                        )}
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Section 4: SKILL CURVES
// ─────────────────────────────────────────────────────────────────────

interface SkillCurvesSectionProps {
  skillCurves: SkillCurvesFile | null;
}

const SKILL_GROUPS: ReadonlyArray<{
  classification: 'Learning' | 'Steady' | 'Stuck-dependent';
  label: string;
  tone: 'positive' | 'neutral' | 'negative';
  blurb: string;
}> = [
  {
    classification: 'Learning',
    label: 'LEARNING',
    tone: 'positive',
    blurb: 'Ask-rate trending down — overrepresented among topics being internalized.',
  },
  {
    classification: 'Steady',
    label: 'STEADY',
    tone: 'neutral',
    blurb: 'No significant trend in ask-rate.',
  },
  {
    classification: 'Stuck-dependent',
    label: 'STUCK-DEPENDENT',
    tone: 'negative',
    blurb:
      'Ask-rate at-or-above corpus median with no decline — correlates with topics not being integrated.',
  },
];

function SkillCurvesSection({ skillCurves }: SkillCurvesSectionProps) {
  if (skillCurves === null || skillCurves.results.length === 0) {
    return (
      <section className="lcars-trends__section" aria-label="skill curves">
        <h3 className="lcars-trends__section-title">SKILL CURVES</h3>
        <p className="lcars-trends__empty">
          No skill curves available — run the skill-curves builder.
        </p>
      </section>
    );
  }
  return (
    <section className="lcars-trends__section" aria-label="skill curves">
      <h3 className="lcars-trends__section-title">SKILL CURVES</h3>
      <p className="lcars-trends__caption">
        BH-FDR α={skillCurves.bhFdrAlpha} · min weeks present=
        {skillCurves.minWeeksPresent}
      </p>
      {SKILL_GROUPS.map((g) => {
        const rows = skillCurves.results.filter(
          (r) => r.classification === g.classification,
        );
        if (rows.length === 0) return null;
        return (
          <div
            key={g.classification}
            className={`lcars-trends__skill-group lcars-trends__skill-group--${g.tone}`}
            data-classification={g.classification}
          >
            <header className="lcars-trends__skill-group-header">
              <h4 className="lcars-trends__skill-group-title">{g.label}</h4>
              <span className="lcars-trends__skill-group-blurb">{g.blurb}</span>
            </header>
            <ul className="lcars-trends__skill-list" role="list">
              {rows.map((r) => {
                const series: readonly number[] = []; // builder doesn't ship the points array
                // back into SkillCurveResult — only the summary stats.
                // The 0-length list collapses TinySpark into the empty
                // placeholder, which is the honest rendering. A future
                // builder pass can ship the points if we want
                // per-topic sparklines.
                return (
                  <li key={r.topicId} className="lcars-trends__skill-row">
                    <span
                      className="lcars-trends__skill-label"
                      title={r.topicId}
                    >
                      {r.label ?? r.topicId}
                    </span>
                    <TinySpark
                      values={series}
                      ariaLabel={`${r.label ?? r.topicId} skill curve`}
                    />
                    <span className="lcars-trends__skill-meta">
                      askPerActive={r.askPerActiveSession.toFixed(2)} · weeks=
                      {r.weeksPresent} · p̂={r.pValueAdjusted.toFixed(3)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
