import { useMemo, useState } from 'react';
import { THRESHOLDS } from '@chat-arch/analysis';
import { SidecarEmptyState } from '../SidecarEmptyState.js';
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
  /** Wave 7 P1 #4 — wire empty-state CTA to the data panel. */
  onOpenDataPanel?: () => void;
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
        aria-label="no series data available"
      >
        —
      </span>
    );
  }
  if (values.length === 1) {
    // Render a centered dot rather than a polyline for the n=1 case.
    // stroke/fill set to currentColor so the dot inherits the parent
    // foreground; the missing .lcars-trends__* CSS block (iter-5 F71)
    // makes this the only color hook the SVG has until styles land.
    return (
      <svg
        className={'lcars-trends__spark' + (className ? ' ' + className : '')}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel ? `${ariaLabel}: single point, value ${values[0]?.toFixed(2)}` : 'single point'}
      >
        <circle cx={width / 2} cy={height / 2} r="2" fill="currentColor" />
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
  // Enriched aria-label: data-bearing summary so SR users hear the
  // shape of the series, not just the caller's name. (iter-4 F68)
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const enrichedLabel =
    ariaLabel !== undefined
      ? `${ariaLabel}: ${values.length} points, ${first.toFixed(2)} to ${last.toFixed(2)}, range ${min.toFixed(2)}-${max.toFixed(2)}`
      : 'trend';
  return (
    <svg
      className={'lcars-trends__spark' + (className ? ' ' + className : '')}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={enrichedLabel}
    >
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={points} />
    </svg>
  );
}

export function TrendsMode({
  trajectories,
  archetypes,
  surfaceComparison,
  skillCurves,
  onSelectSession,
  onOpenDataPanel,
}: TrendsModeProps) {
  const anyDataLoaded =
    trajectories !== null ||
    archetypes !== null ||
    surfaceComparison !== null ||
    skillCurves !== null;

  if (!anyDataLoaded) {
    return (
      <SidecarEmptyState
        title="NO TRENDS DATA"
        detail="TRENDS reads analysis/project-trajectories.json, archetypes.json, surface-comparison.json, skill-curves.json. Open DATA → SCAN LOCAL to populate them."
        {...(onOpenDataPanel ? { onOpenDataPanel } : {})}
        testId="trends-empty"
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
        aria-labelledby="trends-trajectory-h"
      >
        <h3 id="trends-trajectory-h" className="lcars-trends__section-title">PROJECT TRAJECTORY</h3>
        <p className="lcars-trends__empty">No project trajectories available.</p>
      </section>
    );
  }
  return (
    <section className="lcars-trends__section" aria-labelledby="trends-trajectory-h">
      <h3 id="trends-trajectory-h" className="lcars-trends__section-title">PROJECT TRAJECTORY</h3>
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
      <section className="lcars-trends__section" aria-labelledby="trends-archetypes-h">
        <h3 id="trends-archetypes-h" className="lcars-trends__section-title">WORKFLOW ARCHETYPES</h3>
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
                    aria-label={`open session ${sid}`}
                  >
                    ▸ {sid.slice(0, 16)}
                  </button>
                ) : (
                  <span title={sid} aria-label={`session ${sid}`}>{sid.slice(0, 16)}</span>
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
        aria-labelledby="trends-surface-h"
      >
        <h3 id="trends-surface-h" className="lcars-trends__section-title">CROSS-SURFACE COMPARISON</h3>
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
      >
        <caption className="lcars-sr-only">
          Source × archetype heatmap. Rows: source. Columns: archetype.
          Cell percentages are good-share with Wilson confidence intervals.
          Cells marked with an asterisk are significant after Holm-Bonferroni
          adjustment at α={surfaceComparison.familyAlpha}.
        </caption>
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
                // Bar-glyph secondary encoding so the magnitude-by-shade
                // signal survives grayscale + protanopia. (iter-4 F70)
                const BAR_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
                const barGlyph = BAR_GLYPHS[Math.min(7, Math.floor(shade * 8))]!;
                // Bright-cell text-color flip — at shade > 0.5 the cell
                // bg composites to ~rgb(95,164,95); sunflower text on
                // that is ~2.04:1 (fails AA). Black text on the same
                // bg is ~11:1. (iter-4 F63)
                const textColor = !greyed && shade > 0.5 ? '#0a0a0a' : undefined;
                // Cell aria-label carries full good/n/CI breakdown so
                // SR + keyboard users get parity with the mouse-hover
                // title attribute. (iter-4 F69)
                const cellAriaLabel = greyed
                  ? `${src} ${a}: n=${cell.n}, below display threshold of ${minN}`
                  : `${src} ${a}: ${cell.good} of ${cell.n} good (${Math.round(cell.pHat * 100)}%), Wilson CI ${cell.ci.low.toFixed(2)} to ${cell.ci.high.toFixed(2)}${isSig ? ', significant after Holm-Bonferroni' : ''}`;
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
                    style={textColor ? { backgroundColor: bg, color: textColor } : { backgroundColor: bg }}
                    title={
                      greyed
                        ? `n=${cell.n} < ${minN}`
                        : `${cell.good}/${cell.n} good · CI [${cell.ci.low.toFixed(2)}, ${cell.ci.high.toFixed(2)}]`
                    }
                    aria-label={cellAriaLabel}
                  >
                    {greyed ? (
                      <span>n={cell.n}</span>
                    ) : (
                      <>
                        <span aria-hidden="true" className="lcars-trends__bar-glyph">{barGlyph}</span>
                        {' '}
                        {Math.round(cell.pHat * 100)}%
                        {isSig && (
                          <sup
                            className="lcars-trends__sig-mark"
                            aria-hidden="true"
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
    blurb:
      'Ask-rate weeks per active session declining over the observed window.',
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
      'Ask-rate at-or-above corpus median, no decline over the observed window.',
  },
];

function SkillCurvesSection({ skillCurves }: SkillCurvesSectionProps) {
  if (skillCurves === null || skillCurves.results.length === 0) {
    return (
      <section className="lcars-trends__section" aria-labelledby="trends-skills-h">
        <h3 id="trends-skills-h" className="lcars-trends__section-title">SKILL CURVES</h3>
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
      <p
        className="lcars-trends__caption lcars-trends__caption--note"
        data-testid="skill-curves-q-caption"
      >
        q = BH-FDR adjusted p (α={THRESHOLDS.skillCurve.bhFdrAlpha})
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
                // Per-week ask counts, now shipped on the result by the
                // skill-curves builder. Guarded with `?? []` because a
                // skill-curves.json emitted by a pre-fix exporter has no
                // `points` field; that falls back to the empty placeholder,
                // the prior behavior. Empty also when the topic truly had no
                // points.
                const series: readonly number[] = (r.points ?? []).map((p) => p.askCount);
                return (
                  <li key={r.topicId} className="lcars-trends__skill-row">
                    <span
                      className="lcars-trends__skill-label"
                      title={r.topicId}
                    >
                      {r.label ?? r.topicId}
                    </span>
                    {/*
                      No ariaLabel — TinySpark with empty values
                      announces "no series data available". The caller
                      previously passed `${name} skill curve` here,
                      which falsely promised a chart since builder
                      doesn't ship the points array. (iter-4 F67)
                    */}
                    <TinySpark values={series} />
                    <span className="lcars-trends__skill-meta">
                      askPerActive={r.askPerActiveSession.toFixed(2)} · weeks=
                      {r.weeksPresent} · q={r.pValueAdjusted.toFixed(3)}
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
