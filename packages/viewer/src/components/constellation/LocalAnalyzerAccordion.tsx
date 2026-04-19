import { useEffect, useState } from 'react';
import type { TierFileState } from '../../data/analysisFetch.js';
import { LocalAnalyzerEmpty } from '../LocalAnalyzerEmpty.js';
import { onActivate } from '../../util/a11y.js';

/**
 * Collapsed accordion wrapping the three Phase-7 tier-2 empty states
 * (`[R-D20]`).
 *
 * Decision 20 (revised) replaced three consecutive LocalAnalyzerEmpty
 * sections with ONE collapsible `[+] UNLOCK WITH LOCAL ANALYSIS`
 * accordion, closed by default. This prevents the "half-built page"
 * misread from review §4.4.3 (`2 filled + 3 holes` flipped to
 * `2 filled + 1 collapsed opportunity`).
 *
 * Auto-expand behavior: if ANY tier-2 file is present (even one of the
 * three wrapped here — SEMANTIC CLUSTERS, RE-SOLVED PROBLEMS, or
 * ABANDONMENT DIAGNOSIS), the accordion starts open. Sub-sections for
 * still-absent files continue to show the empty state; sub-sections
 * for now-present files would render real content (Phase 7 work).
 */

export interface LocalAnalyzerAccordionProps {
  /** From `AnalysisState.tierFiles` — keyed by reserved filename. */
  tierFiles: Record<string, TierFileState>;
  /** Session count from the manifest — feeds CTA text. */
  sessionCount: number;
}

/**
 * Which of the tier-2 files belong inside THIS accordion (the three
 * CONSTELLATION sub-sections). `cost-diagnoses.json` lives inside COST
 * mode, `handoffs.json` and `skill-seeds.json` are future placements
 * not yet wired into the UI — they still contribute to the TierIndicator
 * pill count but don't auto-expand this accordion.
 */
const ACCORDION_FILES = [
  'duplicates.semantic.json',
  'reloops.json',
  'zombies.diagnosed.json',
] as const;

function anyPresent(tierFiles: Record<string, TierFileState>, files: readonly string[]): boolean {
  return files.some((f) => tierFiles[f]?.present === true);
}

export function LocalAnalyzerAccordion({ tierFiles, sessionCount }: LocalAnalyzerAccordionProps) {
  const autoOpen = anyPresent(tierFiles, ACCORDION_FILES);
  const [open, setOpen] = useState<boolean>(autoOpen);

  // Re-sync when tierFiles changes — e.g. Phase 7 just ran and a file
  // showed up. Without this the user's manual collapse persists past
  // a state refresh, which is fine, but first-render should auto-open.
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  return (
    <section
      className={`lcars-accordion${open ? ' lcars-accordion--open' : ''}`}
      aria-label="unlock with local analysis"
    >
      <div
        className="lcars-accordion__header"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls="lcars-accordion-body"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => onActivate(e, () => setOpen((v) => !v))}
      >
        <span className="lcars-accordion__caret" aria-hidden="true">
          {open ? '[−]' : '[+]'}
        </span>
        <span className="lcars-accordion__title">UNLOCK WITH LOCAL ANALYSIS</span>
        <span className="lcars-accordion__cta">
          Install chat-arch-analyzer skill to unlock 3 additional pattern views
        </span>
      </div>
      {open && (
        <div
          id="lcars-accordion-body"
          className="lcars-accordion__body"
          role="region"
          aria-label="local-analysis sub-sections"
        >
          <LocalAnalyzerEmpty
            title="SEMANTIC CLUSTERS"
            estCostUsd={2.5}
            sessionCount={sessionCount}
            preview="What this would show: near-duplicate prompts grouped by semantic similarity — catches the variations an exact-hash detector misses."
          />
          <LocalAnalyzerEmpty
            title="RE-SOLVED PROBLEMS"
            estCostUsd={1.8}
            sessionCount={sessionCount}
            preview="What this would show: sessions where you re-solved a problem you'd already solved before — pairs of 'asked the same question three months apart' with links between them."
          />
          <LocalAnalyzerEmpty
            title="ABANDONMENT DIAGNOSIS"
            estCostUsd={2.2}
            sessionCount={sessionCount}
            preview="What this would show: LLM-written reasons a project went zombie — 'hit a compatibility wall with Gemini 2.5 upgrade' rather than just 'dormant 60+ days'."
          />
        </div>
      )}
    </section>
  );
}
