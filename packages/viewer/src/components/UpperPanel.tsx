import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import type { FilterState, UploadedCloudData } from '../types.js';
import { SOURCE_LABEL } from '../types.js';
import { Sparkline } from './Sparkline.js';
import { SourceAttribution } from './SourceAttribution.js';
import { formatShortDate, minTimestamp, maxTimestamp } from '../util/time.js';
import { onActivate } from '../util/a11y.js';
import type { CostKpiSection } from './modes/CostMode.js';
import type { ClassifyProgress, SemanticLabelsBundle } from '../data/semanticClassify.js';
import { AnalysisLauncher } from './AnalysisLauncher.js';

export type UpperTab = 'overview' | 'analysis';

/**
 * Counts that drive the ANALYSIS-tab summary cards (redesign Phase 2).
 * Kept as a single prop so the viewer can compute all three from its
 * existing useMemo chain without proliferating prop surface.
 */
export interface AnalysisCounts {
  /** Merged duplicate cluster count (dupes + semantic near-matches). */
  dupClusterCount: number;
  /** Projects classified `zombie` by the heuristic. */
  zombieProjectCount: number;
  /**
   * Distinct emergent topics discovered by the semantic classifier.
   * Zero when analysis hasn't run or produced no clusters.
   */
  emergentTopicCount: number;
  /**
   * Total sessions that received *any* label from the semantic
   * classifier — both classifications to known claude.ai projects and
   * emergent-topic memberships. This matches the "86 labeled" headline
   * the launcher reports and gives the ANALYSIS tab a visible entry
   * point to every label produced, not just the emergent clusters.
   */
  labeledSessionCount: number;
  /**
   * Sessions the semantic classifier matched to a claude.ai project
   * by name (non-emergent subset of `labeledSessionCount`). Surfaced
   * as secondary detail text so the card reads as "86 labels · 85
   * matched to projects, 1 emergent cluster".
   */
  classifiedSessionCount: number;
  /**
   * Distinct claude.ai projects that received at least one classified
   * session. Used in the LABELS card description so users can see
   * how many of their projects were recognized at a glance.
   */
  classifiedProjectCount: number;
}

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

  // ---- Phase 3 semantic analyzer (topic grouping via BGE-small-en-v1.5) ----
  /** Whether the uploaded ZIP carried a parsed projects.json. */
  semanticProjectsAvailable?: boolean;
  /**
   * Number of claude.ai projects parsed from the upload. Surfaced in
   * the AnalysisLauncher's armed-preview STEPS row so users can see
   * "Embed 8 claude.ai projects as centroids" instead of a generic
   * "embed projects" line. Undefined when the upload has no
   * projects.json or the count isn't known yet.
   */
  semanticProjectCount?: number;
  /** Orchestrator status in the viewer. */
  semanticStatus?: 'idle' | 'running' | 'error';
  /** Populated when a classification run has completed. */
  semanticBundle?: SemanticLabelsBundle | null;
  /** Mid-run progress from the embed worker. */
  semanticProgress?: ClassifyProgress | null;
  /** Error from a failed run. */
  semanticError?: string | null;
  /** Invoked when the chip is clicked in its `cta` / `ready` / `error` state. */
  onAnalyzeSemantic?: () => void;

  // ---- Redesign Phase 2: OVERVIEW / ANALYSIS tabs ----
  /**
   * Counts that drive the ANALYSIS-tab summary cards. When absent, the
   * cards render with `0` — the tab stays clickable but shows no
   * urgency badge, which matches the "analysis never ran" state.
   */
  analysisCounts?: AnalysisCounts;
  /** Click handler for the RE-ASKED card → constellation with dup scroll. */
  onOpenDupAnalysis?: () => void;
  /** Click handler for the ZOMBIES card → constellation w/ zombie filter. */
  onOpenZombieAnalysis?: () => void;
  /** Click handler for the TOPICS card → command mode (topics pill row). */
  onOpenTopicAnalysis?: () => void;
  /** Click handler for the LABELS card → command mode (project + topic pills). */
  onOpenLabelsAnalysis?: () => void;
}

const SOURCES: readonly UnifiedSessionEntry['source'][] = [
  'cloud',
  'cowork',
  'cli-direct',
  'cli-desktop',
];

/** Window for the KPI flash animation (matches the CSS keyframes). */
const KPI_FLASH_MS = 600;
/** Debounce so rapid filter toggles don't strobe the KPIs. */
const KPI_FLASH_DEBOUNCE_MS = 550;

/**
 * Compose the LABELS-card description. The caller passes the full
 * `AnalysisCounts` and we surface the breakdown between
 * classified-to-known-projects and emergent-cluster memberships so the
 * card's semantics land without needing a hover tooltip.
 *
 * The card COUNT is the total labeled sessions (both kinds). The
 * description tells the reader how that total splits — "72 matched
 * to 5 projects · 14 pooled into 2 emergent topics". Either half
 * collapses when zero so the copy reads naturally in discover-only
 * runs (no projects.json) and classify-only runs (no emergent pool).
 */
function labelsDescription(counts: AnalysisCounts | undefined): string {
  if (!counts || counts.labeledSessionCount === 0) {
    return 'sessions tagged by the semantic analyzer — matches against your projects and emergent clusters';
  }
  const classified = counts.classifiedSessionCount;
  const emergent = counts.labeledSessionCount - classified;
  const parts: string[] = [];
  if (classified > 0) {
    const projects = counts.classifiedProjectCount;
    parts.push(
      `${classified.toLocaleString()} matched to ${projects} of your claude.ai ${
        projects === 1 ? 'project' : 'projects'
      }`,
    );
  }
  if (emergent > 0) {
    const topics = counts.emergentTopicCount;
    parts.push(
      `${emergent.toLocaleString()} pooled into ${topics} emergent ${
        topics === 1 ? 'topic' : 'topics'
      }`,
    );
  }
  return parts.join(' · ');
}

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

/**
 * Extract the parenthesized size suffix (e.g. "(142.8 MB)") from an upload
 * label produced by `parseCloudZip` (`zipUpload.ts`). Returns the suffix
 * with a leading separator when found, or an empty string otherwise — so
 * callers can concatenate without guarding.
 */
function extractUploadSize(label: string): string {
  const m = label.match(/\(([^()]+)\)\s*$/);
  return m ? `· ${m[1]!}` : '';
}

/**
 * Key that changes when *any* filter input shifts. Used by the KPI-flash
 * effect so it fires once per meaningful settle, not once per keystroke
 * or source toggle.
 */
function filterKey(
  sourceFilter: FilterState,
  projectFilter: ReadonlySet<string>,
  unknownProjectActive: boolean,
  showEmpty: boolean,
): string {
  const srcs = [...sourceFilter].sort().join(',');
  const projs = [...projectFilter].sort().join(',');
  return `${srcs}|${projs}|${unknownProjectActive ? 'u' : ''}|${showEmpty ? 'e' : ''}`;
}

export function UpperPanel({
  manifest,
  filtered,
  showSparkline = true,
  uploadActive = false,
  uploadLabel,
  onUnload,
  onKpiClick,
  sourceFilter,
  projectFilter,
  unknownProjectActive,
  showEmpty,
  tierIndicatorSlot,
  semanticProjectsAvailable = false,
  semanticProjectCount,
  semanticStatus = 'idle',
  semanticBundle = null,
  semanticProgress = null,
  semanticError = null,
  onAnalyzeSemantic,
  analysisCounts,
  onOpenDupAnalysis,
  onOpenZombieAnalysis,
  onOpenTopicAnalysis,
  onOpenLabelsAnalysis,
}: UpperPanelProps) {
  const total = manifest.sessions.length;
  const visible = filtered.length;
  const range = dateRange(filtered);
  const kpis = useMemo(() => computeKpis(filtered), [filtered]);

  /**
   * Cloud session-id set used by the AnalysisLauncher's staleness
   * check — a bundle is stale iff the current set has ids not seen
   * in `bundle.analyzedSessionIds`. Memoized on the manifest's
   * session list so we rebuild only when the corpus actually changes,
   * not on every filter/sort click.
   */
  const currentCloudSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of manifest.sessions) {
      if (s.source === 'cloud') ids.add(s.id);
    }
    return ids;
  }, [manifest.sessions]);

  // Coverage disclosure: <30% of visible sessions have a resolved project.
  const projectCoverageLow =
    kpis.totalSessions > 0 && kpis.projectTaggedCount / kpis.totalSessions < 0.3;

  // Redesign Phase 2: tabs.
  const [tab, setTab] = useState<UpperTab>('overview');

  // Combined urgency badge for the ANALYSIS tab — dupes + zombies.
  // Topics aren't counted here because they don't represent work the
  // user should worry about; they're just a discovery surface.
  const analysisBadgeCount =
    (analysisCounts?.dupClusterCount ?? 0) + (analysisCounts?.zombieProjectCount ?? 0);

  // --- KPI flash on filter settle ---
  //
  // Fires an ice-blue color flash on every KPI card when the filter
  // state has actually changed and stayed changed for 550ms (debounce).
  // The first mount doesn't flash — there's no "before" state, so
  // flashing would be misleading. After mount, any filter change
  // schedules a flash; subsequent changes reset the timer so rapid
  // filter toggles don't strobe.
  const key = filterKey(sourceFilter, projectFilter, unknownProjectActive, showEmpty);
  const [flashKey, setFlashKey] = useState(0);
  const lastKeyRef = useRef<string>(key);
  const flashTimerRef = useRef<number | null>(null);
  const flashClearRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      lastKeyRef.current = key;
      return;
    }
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setFlashKey((n) => n + 1);
      // Clear the flash class after the animation so re-triggering
      // works (CSS animations only replay when the class is removed
      // and re-added — keying on `flashKey` via React takes care of it).
      if (flashClearRef.current !== null) window.clearTimeout(flashClearRef.current);
      flashClearRef.current = window.setTimeout(() => {
        // A self-increment here just lets the class toggle fall off;
        // we don't actually need to remove anything because the class
        // is only applied when `flashKey` differs from `lastRenderedFlashKey`.
      }, KPI_FLASH_MS);
    }, KPI_FLASH_DEBOUNCE_MS);
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, [key]);
  // Cleanup both timers on unmount.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
      if (flashClearRef.current !== null) window.clearTimeout(flashClearRef.current);
    };
  }, []);

  // Rationale for the IA this renders:
  //   Row 1 "stats": data-scope signals — VISIBLE / RANGE describe what's
  //     currently filtered in; the ZIP chip belongs here because it's the
  //     same kind of "what data am I looking at" signal, not a view or
  //     analysis control. Clean left-right split keeps the eye moving
  //     only when something actually changes.
  //   Row 2 "tab bar": centered directly above the body so the tabs sit
  //     *over* what they control. Segmented-control shape, nothing else
  //     competing for the row.
  //   Row 3 "body": OVERVIEW renders KPI strip + sparkline; ANALYSIS
  //     renders the AnalysisLauncher hero + three summary cards + a
  //     compact tier-indicator footer — the state-of-analysis context
  //     all lives in the tab it describes, not in the view-agnostic
  //     stats row.
  return (
    <section className="lcars-upper-panel" aria-label="manifest summary">
      <div className="lcars-upper-panel__stats">
        <div className="lcars-upper-panel__stats-start">
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
        </div>

        {uploadActive && uploadLabel && onUnload && (
          <div className="lcars-upper-panel__stats-end">
            <div className="lcars-upper-panel__upload-chip">
              {/*
                The claude.ai filename is an opaque GUID-timestamp-batch string
                (`data-<uuid>-<ts>-<hash>-batch-<N>.zip`) that carries no user-
                readable information. Render only the parenthesized size we
                append in `zipUpload.ts`; keep the full filename in the title
                tooltip for users who want to verify which ZIP is loaded.
              */}
              <span className="lcars-upper-panel__upload-chip-label" title={uploadLabel}>
                ZIP {extractUploadSize(uploadLabel)}
              </span>
              <span
                role="button"
                tabIndex={0}
                className="lcars-upper-panel__unload"
                aria-label="unload uploaded ZIP"
                onClick={onUnload}
                onKeyDown={(e) => onActivate(e, onUnload)}
              >
                UNLOAD
              </span>
            </div>
          </div>
        )}
      </div>

      <div
        className="lcars-upper-panel__tabs"
        role="tablist"
        aria-label="upper panel view"
      >
        <button
          type="button"
          className={`lcars-upper-panel__tab${tab === 'overview' ? ' lcars-upper-panel__tab--active' : ''}`}
          role="tab"
          aria-selected={tab === 'overview'}
          onClick={() => setTab('overview')}
        >
          OVERVIEW
        </button>
        <button
          type="button"
          className={
            `lcars-upper-panel__tab${tab === 'analysis' ? ' lcars-upper-panel__tab--active' : ''}` +
            (analysisBadgeCount > 0 ? ' lcars-upper-panel__tab--flag' : '')
          }
          role="tab"
          aria-selected={tab === 'analysis'}
          onClick={() => setTab('analysis')}
          title="duplicates, zombies, topic clusters"
        >
          ANALYSIS
          <span className="lcars-upper-panel__tab-badge">{analysisBadgeCount}</span>
        </button>
      </div>

      {tab === 'overview' ? (
        <div className="lcars-upper-panel__body lcars-upper-panel__body--overview">
          {/* KPI strip (Decision 9 / `[R-D9]`) — four teasers that drill into
              COST mode. All four are clickable; each lands on the matching
              section with a 2s highlight ring (COST mode side). */}
          <div
            className="lcars-kpi-strip"
            role="toolbar"
            aria-label="cost KPIs"
            data-flash={flashKey}
            key={flashKey}
          >
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

          {showSparkline && (
            <div
              className="lcars-upper-panel__sparkline-wrap"
              aria-label={`sparkline for ${SOURCES.map((s) => SOURCE_LABEL[s]).join(' + ')}`}
            >
              <Sparkline allSessions={manifest.sessions} visibleSessions={filtered} />
            </div>
          )}
        </div>
      ) : (
        <div
          className="lcars-upper-panel__body lcars-upper-panel__body--analysis"
          role="tabpanel"
        >
          {/*
            Hero launcher — the primary action for this tab. Sits directly
            under the tab bar so users can actually see (and not miss) the
            affordance that kicks off local analysis. First click arms a
            preview step; second click on RUN ANALYSIS is what actually
            starts the pipeline. When analysis is already complete the
            launcher shrinks to a compact summary with a modest re-run
            option; when it's stale (new ZIP) it renders in warning colors
            with a prominent RE-ANALYZE.
          */}
          {uploadActive && onAnalyzeSemantic && (
            <AnalysisLauncher
              projectsAvailable={semanticProjectsAvailable}
              status={semanticStatus}
              bundle={semanticBundle}
              progress={semanticProgress}
              errorMessage={semanticError}
              totalEligibleSessions={manifest.counts.cloud}
              currentSessionIds={currentCloudSessionIds}
              {...(uploadLabel ? { sourceLabel: uploadLabel } : {})}
              {...(typeof semanticProjectCount === 'number'
                ? { projectCount: semanticProjectCount }
                : {})}
              onAnalyze={onAnalyzeSemantic}
            />
          )}
          <div className="lcars-upper-panel__analysis-cards">
            <AnalysisSummaryCard
              variant="dup"
              title="RE-ASKED"
              count={analysisCounts?.dupClusterCount ?? 0}
              description="prompts asked more than once — likely lost answers"
              onOpen={onOpenDupAnalysis}
            />
            <AnalysisSummaryCard
              variant="zombie"
              title="ZOMBIES"
              count={analysisCounts?.zombieProjectCount ?? 0}
              description="projects that died after a burst — archive or revive"
              onOpen={onOpenZombieAnalysis}
            />
            {/*
              LABELS + TOPICS both surface as pill rows in the
              FilterBar directly below the upper panel — which is
              always visible in command mode regardless of the
              upper-panel tab. The parent handler scrolls + pulses the
              relevant row so the user sees the answer move into view
              without us forcing the ANALYSIS tab back to OVERVIEW
              (which reads as the UI "bouncing them away" from the
              summary they were looking at).
            */}
            <AnalysisSummaryCard
              variant="classified"
              title="INFERRED"
              count={analysisCounts?.labeledSessionCount ?? 0}
              description={labelsDescription(analysisCounts)}
              onOpen={onOpenLabelsAnalysis}
            />
            <AnalysisSummaryCard
              variant="topic"
              title="TOPICS"
              count={analysisCounts?.emergentTopicCount ?? 0}
              description="emergent clusters from semantic analysis"
              onOpen={onOpenTopicAnalysis}
            />
          </div>
          {/*
            Tier indicator (CORE ANALYSIS · EXTENDED) stays in a
            modest footer slot — it's reference info about which
            sidecar files are loaded, not an action. Subordinate to
            the launcher + summary cards above.
          */}
          {tierIndicatorSlot && (
            <div className="lcars-upper-panel__analysis-footer" aria-label="analysis file status">
              <div className="lcars-upper-panel__tier-slot">{tierIndicatorSlot}</div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface AnalysisSummaryCardProps {
  variant: 'dup' | 'zombie' | 'topic' | 'classified';
  title: string;
  count: number;
  description: string;
  onOpen?: (() => void) | undefined;
}

function AnalysisSummaryCard({
  variant,
  title,
  count,
  description,
  onOpen,
}: AnalysisSummaryCardProps) {
  const clickable = !!onOpen && count > 0;
  return (
    <div
      className={
        `lcars-analysis-card lcars-analysis-card--${variant}` +
        (clickable ? '' : ' lcars-analysis-card--inert')
      }
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `open ${title.toLowerCase()} (${count})` : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? (e) => onActivate(e, onOpen!) : undefined}
    >
      <div className="lcars-analysis-card__head">
        <span className="lcars-analysis-card__title">{title}</span>
        <span className="lcars-analysis-card__count">{count}</span>
      </div>
      <div className="lcars-analysis-card__desc">{description}</div>
      {clickable && <span className="lcars-analysis-card__cta">OPEN ›</span>}
      {!clickable && count === 0 && (
        <span className="lcars-analysis-card__cta lcars-analysis-card__cta--muted">—</span>
      )}
    </div>
  );
}
