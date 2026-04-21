import { useEffect, useRef } from 'react';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { CostStackedBar } from '../cost/CostStackedBar.js';
import { CostByModel } from '../cost/CostByModel.js';
import { CostByProject } from '../cost/CostByProject.js';
import { ExpensiveSessions } from '../cost/ExpensiveSessions.js';
import { LocalAnalyzerEmpty } from '../LocalAnalyzerEmpty.js';

/**
 * COST mode (Decision 19 / `[R-D19]`) — 4 sections + Phase 7 stub.
 *
 * Sections are stacked top-to-bottom:
 *   (a) COST PER MONTH — stacked bar (exact + estimate)
 *   (b) BY MODEL — table
 *   (c) BY PROJECT — top-8 table + "+N OTHER" fold-row
 *   (d) TOP 20 EXPENSIVE SESSIONS — dense table; optional tool filter
 *
 * KPI navigation (`[R-D19]` new behavior): when entered via a KPI click
 * in UpperPanel, the originating section gets a 2s highlight ring.
 * Direct-nav from sidebar passes `kpiEntry = null` → no highlight.
 *
 * Phase 7 stub: `COST · DIAGNOSED` empty-state below section (d). When
 * `cost-diagnoses.json` is present in a future Phase 7 run, the view
 * flips to real content — the empty state has the same visual weight
 * as the other sections so the user can scan it for existence.
 */

export type CostKpiSection = 'stacked-bar' | 'by-model' | 'by-project' | 'top-20';

export interface CostModeProps {
  sessions: readonly UnifiedSessionEntry[];
  /**
   * When the user arrived via a KPI click in UpperPanel, this names
   * the originating section. Drives the 2s highlight ring.
   * `null` means direct-nav (sidebar click) — no highlight.
   */
  kpiEntry: CostKpiSection | null;
  /** Optional tool filter applied to the top-20 table (TOP TOOL KPI path). */
  toolFilter?: string;
  /** Drill-in handler passed to the expensive-sessions table. */
  onSelect: (id: string) => void;
  /** True when cost-diagnoses.json is present (Phase 7 unlocks the stub). */
  costDiagnosedPresent?: boolean;
}

/**
 * 2s highlight ring. Implemented by adding a class for one render that a
 * CSS `@keyframes` removes via `animation-fill-mode: forwards`. We also
 * scroll the originating section into view on entry.
 */
function useScrollToKpiSection(
  kpiEntry: CostKpiSection | null,
  refs: Record<CostKpiSection, React.RefObject<HTMLDivElement>>,
) {
  useEffect(() => {
    if (!kpiEntry) return;
    const el = refs[kpiEntry].current;
    if (!el) return;
    // Delay one frame so the container is laid out.
    const id = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(id);
  }, [kpiEntry, refs]);
}

export function CostMode({
  sessions,
  kpiEntry,
  toolFilter,
  onSelect,
  costDiagnosedPresent = false,
}: CostModeProps) {
  const stackedRef = useRef<HTMLDivElement>(null);
  const byModelRef = useRef<HTMLDivElement>(null);
  const byProjectRef = useRef<HTMLDivElement>(null);
  const top20Ref = useRef<HTMLDivElement>(null);

  useScrollToKpiSection(kpiEntry, {
    'stacked-bar': stackedRef,
    'by-model': byModelRef,
    'by-project': byProjectRef,
    'top-20': top20Ref,
  });

  // When every visible session is from a claude.ai Privacy Export, cost data
  // is structurally unavailable (no token counts, no model identity, no cache
  // signal — see the SessionCard COST tooltip for the full caveat). Rather
  // than render four empty cost panels, surface a single honest notice so
  // the user knows why and what unlocks real numbers.
  const allCloud = sessions.length > 0 && sessions.every((s) => s.source === 'cloud');

  return (
    <div className="lcars-cost-mode" aria-label="cost analysis">
      {allCloud && (
        <div className="lcars-cost-cloud-notice" role="note">
          <strong>CLOUD-ONLY DATA.</strong> claude.ai Privacy Exports don&apos;t include token
          counts or model identity, so cost isn&apos;t recoverable for these conversations. Run
          the CLI exporter on local sessions (Claude Code, Cowork, Claude Desktop) for measured
          cost.
        </div>
      )}
      <div ref={stackedRef}>
        <CostStackedBar sessions={sessions} highlight={kpiEntry === 'stacked-bar'} />
      </div>
      <div className="lcars-cost-grid">
        <div ref={byModelRef}>
          <CostByModel sessions={sessions} highlight={kpiEntry === 'by-model'} />
        </div>
        <div ref={byProjectRef}>
          <CostByProject sessions={sessions} highlight={kpiEntry === 'by-project'} />
        </div>
      </div>
      <div ref={top20Ref}>
        <ExpensiveSessions
          sessions={sessions}
          {...(toolFilter !== undefined ? { toolFilter } : {})}
          onSelect={onSelect}
          highlight={kpiEntry === 'top-20'}
        />
      </div>
      {!costDiagnosedPresent && (
        <LocalAnalyzerEmpty
          title="COST · DIAGNOSED"
          estCostUsd={2.5}
          sessionCount={sessions.length}
          preview="What this would show: LLM-written per-session diagnoses (why this session cost so much — compaction overhead, runaway retries, model misfit), plus a corrected cost per session when the rate-table estimate misses compactions."
        />
      )}
    </div>
  );
}
