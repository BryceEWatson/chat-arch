import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TrendsMode } from './TrendsMode.js';
import type {
  ArchetypesFile,
  ProjectTrajectoriesFile,
  SkillCurvesFile,
  SurfaceComparisonFile,
} from '../../data/trendsLoader.js';

/**
 * TrendsMode tests (Stream J #5):
 *   - Renders empty state when no sidecars are present.
 *   - Each sub-section renders when its sidecar is provided.
 *   - Heatmap greys cells with n < display floor.
 *   - Significant-pair cells get a marker.
 *   - Archetype click filters the sessions sub-list.
 */

const minimalTrajectories: ProjectTrajectoriesFile = {
  version: 1,
  generatedAt: 1,
  rollingWindow: 10,
  projects: [
    {
      projectId: 'p1',
      projectName: 'alpha',
      classification: 'accelerating',
      totalSessions: 12,
      recentSessions: 3,
      slope: 0.04,
      ci: { low: 0.01, high: 0.07 },
      blockLength: 3,
      bootstrapStatus: 'ok',
      series: [0.4, 0.5, 0.6],
    },
  ],
};

const archetypes: ArchetypesFile = {
  version: 1,
  generatedAt: 1,
  archetypeVersion: 12345,
  centroids: [
    { archetypeId: 'archetype-0', vector: [0, 0], sessionCount: 25 },
    { archetypeId: 'archetype-1', vector: [1, 1], sessionCount: 20 },
  ],
  assignments: {
    's1': 'archetype-0',
    's2': 'archetype-0',
    's3': 'archetype-1',
  },
  silhouette: 0.2,
  chosenK: 2,
  scannedSessionIds: ['s1', 's2', 's3'],
};

const surface: SurfaceComparisonFile = {
  version: 1,
  generatedAt: 1,
  familyAlpha: 0.05,
  cells: [
    // Below display floor — gets greyed.
    {
      key: 'cloud|archetype-0',
      source: 'cloud',
      archetypeId: 'archetype-0',
      n: 3,
      good: 1,
      pHat: 0.333,
      ci: { low: 0, high: 1 },
      meetsDisplayN: false,
    },
    // Above floor — rendered with shade + significant marker (forced).
    {
      key: 'cli-direct|archetype-1',
      source: 'cli-direct',
      archetypeId: 'archetype-1',
      n: 40,
      good: 20,
      pHat: 0.5,
      ci: { low: 0.34, high: 0.65 },
      meetsDisplayN: true,
    },
    // Above floor — not significant.
    {
      key: 'cli-direct|archetype-0',
      source: 'cli-direct',
      archetypeId: 'archetype-0',
      n: 40,
      good: 12,
      pHat: 0.3,
      ci: { low: 0.17, high: 0.47 },
      meetsDisplayN: true,
    },
  ],
  pairwise: [
    {
      a: 'cli-direct|archetype-1',
      b: 'cli-direct|archetype-0',
      pValue: 0.01,
      pValueAdjusted: 0.04,
      significant: true,
    },
  ],
};

const skillCurves: SkillCurvesFile = {
  version: 1,
  generatedAt: 1,
  minWeeksPresent: 6,
  bhFdrAlpha: 0.1,
  results: [
    {
      topicId: 't1',
      label: 'react hooks',
      classification: 'Learning',
      mannKendallS: -10,
      z: -2.5,
      pValue: 0.01,
      pValueAdjusted: 0.02,
      askPerActiveSession: 0.4,
      weeksPresent: 10,
    },
    {
      topicId: 't2',
      label: 'docker compose',
      classification: 'Stuck-dependent',
      mannKendallS: 1,
      z: 0.5,
      pValue: 0.4,
      pValueAdjusted: 0.4,
      askPerActiveSession: 0.9,
      weeksPresent: 8,
    },
  ],
};

afterEach(() => cleanup());

describe('TrendsMode', () => {
  it('renders the empty state when no sidecars are present', () => {
    render(
      <TrendsMode
        trajectories={null}
        archetypes={null}
        surfaceComparison={null}
        skillCurves={null}
      />,
    );
    expect(screen.getByText('NO TRENDS DATA')).toBeDefined();
  });

  it('renders all four sub-sections when sidecars are present', () => {
    render(
      <TrendsMode
        trajectories={minimalTrajectories}
        archetypes={archetypes}
        surfaceComparison={surface}
        skillCurves={skillCurves}
      />,
    );
    expect(screen.getByRole('heading', { name: 'PROJECT TRAJECTORY' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'WORKFLOW ARCHETYPES' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'CROSS-SURFACE COMPARISON' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'SKILL CURVES' })).toBeDefined();
  });

  it('renders project name + classification pill in the trajectory section', () => {
    render(
      <TrendsMode
        trajectories={minimalTrajectories}
        archetypes={null}
        surfaceComparison={null}
        skillCurves={null}
      />,
    );
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('ACCELERATING')).toBeDefined();
  });

  it('greys heatmap cells with n < display floor', () => {
    render(
      <TrendsMode
        trajectories={null}
        archetypes={null}
        surfaceComparison={surface}
        skillCurves={null}
      />,
    );
    const greyed = screen.getByTestId('heatmap-greyed-cloud|archetype-0');
    expect(greyed).toBeDefined();
    expect(greyed.className).toContain('greyed');
  });

  it('marks significant-pair cells with a significance marker', () => {
    render(
      <TrendsMode
        trajectories={null}
        archetypes={null}
        surfaceComparison={surface}
        skillCurves={null}
      />,
    );
    const sigCell = screen.getByTestId('heatmap-cell-cli-direct|archetype-1');
    expect(sigCell.getAttribute('data-significant')).toBe('true');
  });

  it('filters the archetype session list when a centroid is clicked', () => {
    render(
      <TrendsMode
        trajectories={null}
        archetypes={archetypes}
        surfaceComparison={null}
        skillCurves={null}
        onSelectSession={() => {}}
      />,
    );
    // No session list before click.
    expect(screen.queryByLabelText(/sessions in archetype/)).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: /archetype-0/i, pressed: false }),
    );
    expect(
      screen.getByLabelText(/sessions in archetype-0/i),
    ).toBeDefined();
  });

  it('groups skill curves by classification', () => {
    render(
      <TrendsMode
        trajectories={null}
        archetypes={null}
        surfaceComparison={null}
        skillCurves={skillCurves}
      />,
    );
    expect(screen.getByRole('heading', { name: 'LEARNING' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'STUCK-DEPENDENT' })).toBeDefined();
    expect(screen.getByText('react hooks')).toBeDefined();
    expect(screen.getByText('docker compose')).toBeDefined();
  });
});
