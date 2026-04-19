import { useEffect, useRef } from 'react';
import { onActivate } from '../util/a11y.js';
import { PHASE_7_RESERVED_FILES, type TierFileState } from '../data/analysisFetch.js';

/**
 * Clickable explainer behind the TierIndicator pill (Decision 17 + AC15).
 *
 * Enumerates all six Phase-7-reserved filenames with a present/absent
 * icon and last-generated timestamp when present (`[R-AC14]`). Doubles
 * as the "what does the local analyzer unlock?" onboarding surface.
 *
 * Rendered as a dialog. Closes on:
 *   - Escape
 *   - click outside
 *   - explicit close button
 *
 * No portal — sits inline where TierIndicator renders it. The viewer's
 * LCARS frame is the root, so an overlay inside the top-bar renders
 * correctly above content in the natural stacking context.
 */

export interface TierSheetProps {
  /** Current tier state. Drives the summary line at the top of the sheet. */
  tierStatus: 'browser' | 'browser+local';
  /** N in `CORE + EXTENDED ANALYSIS (N/6)`. Displayed in the sheet header. */
  tierPresentCount: number;
  /** Per-file present/absent + timestamp map from `fetchAnalysisTierStatus`. */
  tierFiles: Record<string, TierFileState>;
  /** Called when the user dismisses the sheet (Esc / close button / backdrop). */
  onClose: () => void;
}

const FILE_DESCRIPTIONS: Record<(typeof PHASE_7_RESERVED_FILES)[number], string> = {
  'duplicates.semantic.json': 'Semantic duplicate clusters (beyond exact match).',
  'zombies.diagnosed.json': 'LLM-classified zombie projects with abandonment cause.',
  'reloops.json': 'Re-solved problems you forgot you already solved.',
  'handoffs.json': 'Handoff-prompt templates extracted from assistant outputs.',
  'cost-diagnoses.json': 'Per-session cost diagnoses (why did this cost so much?).',
  'skill-seeds.json': 'Candidate Claude-Code skills synthesized from your history.',
};

function formatDate(ms: number): string {
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return 'unknown';
    // Locale-independent: YYYY-MM-DD for stable fixtures + no-surprise UX.
    return d.toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

export function TierSheet({ tierStatus, tierPresentCount, tierFiles, onClose }: TierSheetProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Esc-to-close. The viewer's other dialog surfaces handle this the same
  // way (see ChatArchViewer drill-in hash handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const headerCopy =
    tierStatus === 'browser'
      ? 'CORE ANALYSIS — what you see now. Extended analysis is a planned second tier, not yet shipped.'
      : `CORE + EXTENDED ANALYSIS — ${tierPresentCount} of 6 extended views generated.`;

  return (
    <div
      className="lcars-tier-sheet-backdrop"
      role="presentation"
      onClick={(e) => {
        // Only dismiss on clicks directly on the backdrop, not bubbled from
        // sheet children.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={rootRef}
        className="lcars-tier-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Analysis tier details"
      >
        <header className="lcars-tier-sheet__header">
          <h2 className="lcars-tier-sheet__title">ANALYSIS TIERS</h2>
          <div
            className="lcars-tier-sheet__close"
            role="button"
            tabIndex={0}
            aria-label="close tier details"
            onClick={onClose}
            onKeyDown={(e) => onActivate(e, onClose)}
          >
            ×
          </div>
        </header>
        <p className="lcars-tier-sheet__summary">{headerCopy}</p>
        <p className="lcars-tier-sheet__hint">
          The core tier is live — search, filters, cost sparklines, exact-duplicate clusters, and
          zombie-project heuristics all run in-page against your manifest. The extended tier is what
          LLM-assisted analysis over your full transcript corpus would add: semantic similarity, why
          a project stalled, problems you re-solved months apart, reusable prompt templates, cost
          post-mortems, and candidate Claude-Code skills synthesized from your actual usage. Those
          need a local pass because running an LLM over every session isn&apos;t something a browser
          tab should do (cost, privacy, throughput) — but the tool that runs that pass isn&apos;t
          written yet. This sheet is the preview.
        </p>
        <ul className="lcars-tier-sheet__list" aria-label="tier-2 analysis files">
          {PHASE_7_RESERVED_FILES.map((filename) => {
            const state = tierFiles[filename] ?? { present: false };
            const present = state.present;
            return (
              <li
                key={filename}
                className={
                  'lcars-tier-sheet__item ' +
                  (present ? 'lcars-tier-sheet__item--present' : 'lcars-tier-sheet__item--absent')
                }
              >
                <span
                  className="lcars-tier-sheet__icon"
                  aria-label={present ? 'present' : 'absent'}
                >
                  {present ? '✓' : '–'}
                </span>
                <span className="lcars-tier-sheet__filename">{filename}</span>
                <span className="lcars-tier-sheet__desc">{FILE_DESCRIPTIONS[filename]}</span>
                <span className="lcars-tier-sheet__ts">
                  {present && state.generatedAt != null
                    ? formatDate(state.generatedAt)
                    : present
                      ? 'present'
                      : 'coming soon'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
