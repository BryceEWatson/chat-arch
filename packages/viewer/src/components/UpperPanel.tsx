import { useMemo } from 'react';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import type { FilterState, UploadedCloudData } from '../types.js';
import { SOURCE_LABEL } from '../types.js';
import { SourcePill } from './SourcePill.js';
import { Sparkline } from './Sparkline.js';
import { UploadPanel } from './UploadPanel.js';
import { SourceAttribution } from './SourceAttribution.js';
import { formatShortDate, minTimestamp, maxTimestamp } from '../util/time.js';
import { onActivate } from '../util/a11y.js';
import type { CostKpiSection } from './modes/CostMode.js';

export interface UpperPanelProps {
  manifest: SessionManifest;
  filtered: readonly UnifiedSessionEntry[];
  sourceFilter: FilterState;
  onToggleSource: (src: UnifiedSessionEntry['source']) => void;
  onClearFilters: () => void;
  /** Hide sparkline at Tier C mobile. */
  showSparkline?: boolean;
  /** When an uploaded ZIP is active, drives the UNLOAD affordance. */
  uploadActive?: boolean;
  /** Filename + size label for the active upload, shown with UNLOAD. */
  uploadLabel?: string;
  /** Invoked on UNLOAD click. */
  onUnload?: () => void;
  /** Fired after a successful upload parse. */
  onUpload?: (data: UploadedCloudData) => void;

  /** KPI click -> COST mode with section highlight (`[R-D9]` / `[R-D19]`). */
  onKpiClick: (section: CostKpiSection, toolFilter?: string) => void;
  /** Currently selected projects (multi-select). Empty = show all. */
  projectFilter: ReadonlySet<string>;
  /** Toggle a single project in/out of the filter set. */
  onToggleProject: (projectId: string) => void;
  /** UNKNOWN pill — filters to sessions with no resolved project. */
  unknownProjectActive: boolean;
  onToggleUnknownProject: () => void;
  /** Whether the zero-turn toggle is on (SHOW EMPTY). */
  showEmpty: boolean;
  onToggleShowEmpty: () => void;
  /**
   * Tier-2 analysis indicator (Phase 7). Previously lived in the top
   * bar; relocated here beside the stats so the top bar can give its
   * prime left-cluster real estate to the Upload Cloud / Scan Local
   * data-source buttons. Optional so existing tests without
   * analysisState wiring still render cleanly.
   */
  tierIndicatorSlot?: React.ReactNode;
}

const SOURCES: readonly UnifiedSessionEntry['source'][] = [
  'cloud',
  'cowork',
  'cli-direct',
  'cli-desktop',
];

function dateRange(sessions: readonly UnifiedSessionEntry[]): string {
  const mins = sessions.map((s) => s.updatedAt);
  const min = minTimestamp(mins);
  const max = maxTimestamp(mins);
  if (min === null || max === null) return '—';
  return `${formatShortDate(min)} → ${formatShortDate(max)}`;
}

/**
 * Format a USD value for the KPI strip. `0` → `$0.00`, otherwise 2-dec.
 * Abbreviates ≥1k to `$1.2k` so the pill stays readable at desktop.
 */
function formatKpiUsd(n: number): string {
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface Kpis {
  exactCostUsd: number;
  estimateCostUsd: number;
  hasEstimate: boolean;
  outputTokens: number;
  topTool: { name: string; count: number } | null;
  topProject: { name: string; count: number } | null;
  projectTaggedCount: number;
  totalSessions: number;
}

function computeKpis(sessions: readonly UnifiedSessionEntry[]): Kpis {
  let exactCost = 0;
  let estimateCost = 0;
  let outputTok = 0;
  const toolCounts = new Map<string, number>();
  const projectCounts = new Map<string, number>();
  let projectTagged = 0;

  for (const s of sessions) {
    if (s.totalCostUsd !== null) exactCost += s.totalCostUsd;
    else if (typeof s.costEstimatedUsd === 'number') estimateCost += s.costEstimatedUsd;
    if (s.tokenTotals) outputTok += s.tokenTotals.output;
    if (s.topTools) {
      for (const [name, count] of Object.entries(s.topTools)) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
      }
    }
    if (s.project) {
      projectTagged += 1;
      projectCounts.set(s.project, (projectCounts.get(s.project) ?? 0) + 1);
    }
  }

  const topTool = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topProject = [...projectCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    exactCostUsd: exactCost,
    estimateCostUsd: estimateCost,
    hasEstimate: estimateCost > 0,
    outputTokens: outputTok,
    topTool: topTool ? { name: topTool[0], count: topTool[1] } : null,
    topProject: topProject ? { name: topProject[0], count: topProject[1] } : null,
    projectTaggedCount: projectTagged,
    totalSessions: sessions.length,
  };
}

interface ProjectPill {
  id: string;
  count: number;
}

function computeProjectPills(sessions: readonly UnifiedSessionEntry[]): {
  top: ProjectPill[];
  rest: ProjectPill[];
  unknownCount: number;
} {
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const s of sessions) {
    if (s.project) counts.set(s.project, (counts.get(s.project) ?? 0) + 1);
    else unknown += 1;
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ id, count }));
  return {
    top: sorted.slice(0, 8),
    rest: sorted.slice(8),
    unknownCount: unknown,
  };
}

export function UpperPanel({
  manifest,
  filtered,
  sourceFilter,
  onToggleSource,
  onClearFilters,
  showSparkline = true,
  uploadActive = false,
  uploadLabel,
  onUnload,
  onUpload,
  onKpiClick,
  projectFilter,
  onToggleProject,
  unknownProjectActive,
  onToggleUnknownProject,
  showEmpty,
  onToggleShowEmpty,
  tierIndicatorSlot,
}: UpperPanelProps) {
  const total = manifest.sessions.length;
  const visible = filtered.length;
  const range = dateRange(filtered);
  const kpis = useMemo(() => computeKpis(filtered), [filtered]);
  const projectPills = useMemo(() => computeProjectPills(filtered), [filtered]);

  // Zero-turn count is computed against the full manifest so the toggle
  // label doesn't mutate when filters change (R19 F19.10: 15 zero-turn
  // sessions total — stable baseline).
  const zeroTurnCount = useMemo(
    () => manifest.sessions.filter((s) => s.userTurns === 0).length,
    [manifest.sessions],
  );

  // Coverage disclosure: <30% of visible sessions have a resolved project.
  const projectCoverageLow =
    kpis.totalSessions > 0 && kpis.projectTaggedCount / kpis.totalSessions < 0.3;

  return (
    <section className="lcars-upper-panel" aria-label="manifest summary">
      <div className="lcars-upper-panel__stats">
        <div className="lcars-upper-panel__stat">
          <span className="lcars-upper-panel__stat-label">VISIBLE</span>
          <span className="lcars-upper-panel__stat-value">
            {visible}
            <span className="lcars-upper-panel__stat-total"> / {total}</span>
          </span>
        </div>
        <div className="lcars-upper-panel__stat">
          <span className="lcars-upper-panel__stat-label">RANGE</span>
          <span className="lcars-upper-panel__stat-value">{range}</span>
        </div>
        {uploadActive && uploadLabel && onUnload && (
          <div className="lcars-upper-panel__upload-chip">
            <span className="lcars-upper-panel__upload-chip-label" title={uploadLabel}>
              UPLOADED: {uploadLabel}
            </span>
            <span
              role="button"
              tabIndex={0}
              className="lcars-upper-panel__unload"
              aria-label="unload uploaded ZIP"
              onClick={onUnload}
              onKeyDown={(e) => onActivate(e, onUnload)}
            >
              UNLOAD ZIP
            </span>
          </div>
        )}
        {tierIndicatorSlot && (
          <div className="lcars-upper-panel__tier-slot">{tierIndicatorSlot}</div>
        )}
      </div>

      {/* KPI strip (Decision 9 / `[R-D9]`) — four teasers that drill into
          COST mode. All four are clickable; each lands on the matching
          section with a 2s highlight ring (COST mode side). */}
      <div className="lcars-kpi-strip" role="toolbar" aria-label="cost KPIs">
        <div
          className="lcars-kpi"
          role="button"
          tabIndex={0}
          aria-label={`total cost $${kpis.exactCostUsd.toFixed(2)} exact plus $${kpis.estimateCostUsd.toFixed(2)} estimate; click to open cost per month`}
          onClick={() => onKpiClick('stacked-bar')}
          onKeyDown={(e) => onActivate(e, () => onKpiClick('stacked-bar'))}
        >
          <span className="lcars-kpi__label">COST</span>
          <span className="lcars-kpi__value">
            {formatKpiUsd(kpis.exactCostUsd)} + {formatKpiUsd(kpis.estimateCostUsd)} est
            {kpis.hasEstimate && <SourceAttribution kind="estimate" />}
          </span>
        </div>
        <div
          className="lcars-kpi"
          role="button"
          tabIndex={0}
          aria-label={`output tokens ${formatTokens(kpis.outputTokens)}; click to open by model`}
          onClick={() => onKpiClick('by-model')}
          onKeyDown={(e) => onActivate(e, () => onKpiClick('by-model'))}
        >
          <span className="lcars-kpi__label">TOKENS</span>
          <span className="lcars-kpi__value">{formatTokens(kpis.outputTokens)}</span>
        </div>
        <div
          className="lcars-kpi"
          role="button"
          tabIndex={0}
          aria-label={`top tool ${kpis.topTool?.name ?? 'none'}; click to filter top-20 by this tool`}
          onClick={() => onKpiClick('top-20', kpis.topTool?.name)}
          onKeyDown={(e) => onActivate(e, () => onKpiClick('top-20', kpis.topTool?.name))}
        >
          <span className="lcars-kpi__label">TOP TOOL</span>
          <span className="lcars-kpi__value">{kpis.topTool ? kpis.topTool.name : '—'}</span>
        </div>
        <div
          className="lcars-kpi"
          role="button"
          tabIndex={0}
          aria-label={`top project ${kpis.topProject?.name ?? 'none'}; click to open by project`}
          onClick={() => onKpiClick('by-project')}
          onKeyDown={(e) => onActivate(e, () => onKpiClick('by-project'))}
        >
          <span className="lcars-kpi__label">TOP PROJECT</span>
          <span className="lcars-kpi__value">
            {kpis.topProject ? kpis.topProject.name : '—'}
            {projectCoverageLow && kpis.topProject && (
              <span className="lcars-kpi__coverage">
                {' '}
                ({kpis.projectTaggedCount} of {kpis.totalSessions} tagged)
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Filter pills (source + zero-turn + project) moved to the
          FilterBar component, which renders directly above the
          mode-area content — the user's mental model is "filter
          what's below", so co-locating them is clearer. */}

      {showSparkline && (
        <div
          className="lcars-upper-panel__sparkline-wrap"
          aria-label={`sparkline for ${SOURCES.map((s) => SOURCE_LABEL[s]).join(' + ')}`}
        >
          <Sparkline allSessions={manifest.sessions} visibleSessions={filtered} />
        </div>
      )}
    </section>
  );
}
