import { useEffect, useState } from 'react';
import type { ClassifyProgress, SemanticLabelsBundle } from '../data/semanticClassify.js';

/**
 * Hero launcher for the local semantic-analysis pipeline. Sits directly
 * under the ANALYSIS tab bar as the primary affordance for starting,
 * re-running, or inspecting the state of topic inference.
 *
 * Clicking the primary action never fires the pipeline directly — it
 * arms a preview step that lays out exactly what's about to happen
 * (scope, device, download cost, rough runtime). A second click on
 * RUN ANALYSIS is what actually starts the work. That protects users
 * from the "I clicked once and now my laptop fan is running for 3
 * minutes" surprise.
 *
 * Render states:
 *
 *   - `running`      — pipeline in flight; show phase + %.
 *   - `error`        — last run failed; single RETRY button, error below.
 *   - `armed`        — user clicked the primary button; show preview
 *                      list and RUN / CANCEL buttons. Clears on
 *                      `status` transition to `running`.
 *   - idle + stale   — bundle exists but a fresh upload exceeds it;
 *                      warning banner, RE-ANALYZE primary.
 *   - idle + complete — bundle covers everything; compact summary,
 *                      modest RE-RUN secondary.
 *   - idle + empty   — no bundle yet; primary ANALYZE CTA.
 */

export interface AnalysisLauncherProps {
  /** Whether the current upload carries a projects.json (classify vs cluster mode). */
  projectsAvailable: boolean;
  /** Current orchestrator status. */
  status: 'idle' | 'running' | 'error';
  /** Completed labels bundle, or `null` when analysis hasn't run. */
  bundle: SemanticLabelsBundle | null;
  /** Mid-run progress from the worker. */
  progress: ClassifyProgress | null;
  /** Last-run error message, populated when `status === 'error'`. */
  errorMessage: string | null;
  /**
   * Number of cloud sessions currently eligible for embedding. Used for
   * coverage math (analyzed vs eligible) and the CTA scope copy
   * ("ANALYZE 1,041 CONVERSATIONS").
   */
  totalEligibleSessions: number;
  /**
   * Short source label for the armed-preview scope row. Typically the
   * uploaded ZIP's filename + size (e.g., "final.zip (27.6 MB)") so
   * the user can confirm which upload they're about to analyze. Omit
   * when no ZIP is active — the row collapses to the generic copy.
   */
  sourceLabel?: string;
  /**
   * Number of claude.ai projects parsed from the upload's `projects.json`.
   * Drives the "classify" step copy in the armed preview ("Embed 8
   * claude.ai projects as centroids"). Only used when
   * `projectsAvailable === true`.
   */
  projectCount?: number;
  /**
   * Fires the pipeline. The launcher handles its own confirmation step
   * — the parent only ever sees the final "run now" intent.
   */
  onAnalyze: () => void;
}

/**
 * Embedding classifier defaults — threshold τ and margin — copied from
 * the viewer's `runSemanticAnalysis` call site. Surfaced in the armed
 * preview so users know *how* the classify step draws its decisions.
 */
const DEFAULT_THRESHOLD = 0.4;
const DEFAULT_MARGIN = 0.02;

function formatPhaseLabel(p: ClassifyProgress): string {
  switch (p.phase) {
    case 'downloading model':
      return 'DOWNLOADING MODEL';
    case 'embedding projects':
      return 'EMBEDDING PROJECTS';
    case 'embedding sessions':
      return 'EMBEDDING SESSIONS';
    case 'classifying':
      return 'CLASSIFYING';
    case 'finding emergent topics':
      return 'FINDING EMERGENT TOPICS';
    case 'clustering':
      return 'CLUSTERING';
    default:
      return 'ANALYZING';
  }
}

function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? singular : plural;
}

export function AnalysisLauncher({
  projectsAvailable,
  status,
  bundle,
  progress,
  errorMessage,
  totalEligibleSessions,
  sourceLabel,
  projectCount,
  onAnalyze,
}: AnalysisLauncherProps) {
  const [armed, setArmed] = useState(false);

  // Auto-disarm when a run starts — the confirmation step served its
  // purpose the moment `onAnalyze` fired. Without this, the preview
  // panel would awkwardly linger visible while the progress readout
  // tried to render inside it.
  useEffect(() => {
    if (status === 'running') setArmed(false);
  }, [status]);

  // Coverage math drives the heading for the non-armed idle states.
  let analyzedCount = 0;
  let inferredCount = 0;
  let abstainedCount = 0;
  if (bundle) {
    for (const label of bundle.labels.values()) {
      if (label.projectId !== null) inferredCount += 1;
      else abstainedCount += 1;
    }
    analyzedCount = bundle.labels.size;
  }
  const coverageGap = bundle ? Math.max(0, totalEligibleSessions - analyzedCount) : 0;
  const isStale = !!bundle && coverageGap > 0;
  const isComplete = !!bundle && coverageGap === 0;

  // --- running ---
  if (status === 'running') {
    const phaseLabel = progress ? formatPhaseLabel(progress) : 'ANALYZING';
    const pct = progress && progress.fraction !== null ? Math.round(progress.fraction * 100) : null;
    return (
      <section className="lcars-analysis-launcher lcars-analysis-launcher--running" aria-label="analysis running">
        <div className="lcars-analysis-launcher__heading">
          <span className="lcars-analysis-launcher__spinner" aria-hidden="true" />
          <div className="lcars-analysis-launcher__title-group">
            <span className="lcars-analysis-launcher__title">RUNNING</span>
            <span className="lcars-analysis-launcher__subtitle" role="status" aria-live="polite">
              {phaseLabel}
              {pct !== null && <span aria-hidden="true"> · {pct}%</span>}
            </span>
          </div>
        </div>
        {pct !== null && (
          <div className="lcars-analysis-launcher__progress" aria-hidden="true">
            <div
              className="lcars-analysis-launcher__progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </section>
    );
  }

  // --- error ---
  if (status === 'error') {
    return (
      <section className="lcars-analysis-launcher lcars-analysis-launcher--error" aria-label="analysis failed">
        <div className="lcars-analysis-launcher__heading">
          <div className="lcars-analysis-launcher__title-group">
            <span className="lcars-analysis-launcher__title">ANALYSIS FAILED</span>
            {errorMessage && (
              <span className="lcars-analysis-launcher__subtitle" title={errorMessage}>
                {errorMessage}
              </span>
            )}
          </div>
        </div>
        <div className="lcars-analysis-launcher__actions">
          <button
            type="button"
            className="lcars-analysis-launcher__btn lcars-analysis-launcher__btn--primary"
            onClick={() => setArmed(true)}
          >
            RETRY
          </button>
        </div>
      </section>
    );
  }

  // --- armed: preview before actually running ---
  if (armed) {
    const ctaCount = totalEligibleSessions.toLocaleString();
    const ctaNoun = pluralize(totalEligibleSessions, 'conversation');
    const modeDescription = projectsAvailable
      ? `Classify mode — projects.json was found in the upload, so each conversation is matched to its nearest claude.ai project centroid by cosine similarity. Conversations that don\u2019t clear τ=${DEFAULT_THRESHOLD} are pooled into emergent clusters afterward.`
      : `Discover mode — no projects.json in the upload, so topics are clustered unsupervised from conversation similarity alone (no pre-existing labels are used).`;
    const rerunContext = isStale
      ? `${coverageGap.toLocaleString()} new ${pluralize(coverageGap, 'session')} since the last run. The full ${ctaCount}-conversation set will be re-embedded and re-labeled; prior labels are replaced.`
      : isComplete
        ? `All ${ctaCount} conversations will be re-embedded and re-labeled; prior labels are replaced.`
        : null;
    const runLabel = bundle ? 'RUN RE-ANALYSIS' : 'RUN ANALYSIS';

    // Enumerated pipeline steps. Classify mode inserts an extra
    // "embed projects as centroids" step; both modes share the model
    // download, session embedding, and persist-to-IDB steps.
    interface Step {
      title: string;
      detail: string;
    }
    const steps: Step[] = [];
    steps.push({
      title: 'Download model',
      detail:
        '~36 MB · BGE-small-en-v1.5 (Xenova port) · cached in the browser after the first run',
    });
    if (projectsAvailable) {
      steps.push({
        title: 'Embed your claude.ai projects',
        detail:
          typeof projectCount === 'number'
            ? `${projectCount.toLocaleString()} ${pluralize(projectCount, 'project')} from projects.json \u2192 384-dim centroid ${pluralize(projectCount, 'vector')}`
            : 'Each project in projects.json \u2192 384-dim centroid vector',
      });
    }
    steps.push({
      title: 'Embed conversations',
      detail: `${ctaCount} ${ctaNoun} \u2192 384-dim vectors (all human turns chunked to ~512 tokens each, max-pooled per centroid)`,
    });
    if (projectsAvailable) {
      steps.push({
        title: 'Classify against centroids',
        detail: `Assign each conversation to the nearest project by cosine similarity (τ=${DEFAULT_THRESHOLD}, margin=${DEFAULT_MARGIN}). Ties below margin are left unlabeled.`,
      });
      steps.push({
        title: 'Cluster emergent topics',
        detail:
          'Group sub-threshold conversations by similarity, then label each cluster from its centroid text \u2014 surfaces topics your projects.json doesn\u2019t cover.',
      });
    } else {
      steps.push({
        title: 'Cluster by similarity',
        detail: `Group conversations by cosine similarity at τ=${DEFAULT_THRESHOLD}; label each cluster from its centroid text.`,
      });
    }
    steps.push({
      title: 'Persist labels',
      detail:
        'Write the labels bundle to browser IndexedDB (chat-arch-semantic-labels). Nothing leaves this page.',
    });

    return (
      <section
        className="lcars-analysis-launcher lcars-analysis-launcher--armed"
        role="dialog"
        aria-label="confirm analysis"
      >
        <div className="lcars-analysis-launcher__heading">
          <div className="lcars-analysis-launcher__title-group">
            <span className="lcars-analysis-launcher__title">READY TO RUN</span>
            {rerunContext && (
              <span className="lcars-analysis-launcher__subtitle">{rerunContext}</span>
            )}
          </div>
        </div>
        <dl className="lcars-analysis-launcher__preview">
          <div className="lcars-analysis-launcher__preview-row">
            <dt className="lcars-analysis-launcher__preview-k">SCOPE</dt>
            <dd className="lcars-analysis-launcher__preview-v">
              <strong>
                {ctaCount} cloud {ctaNoun}
              </strong>{' '}
              from your Claude.ai privacy export.
              <div className="lcars-analysis-launcher__preview-note">
                This in-browser pass only covers cloud conversations. If you&rsquo;re running
                Chat Archaeologist locally (not web-only), the richer local-analysis pipeline
                produces more detailed results from your CLI / Desktop / Cowork transcripts
                too &mdash; it runs via the same interface when available.
              </div>
            </dd>
          </div>
          {sourceLabel && (
            <div className="lcars-analysis-launcher__preview-row">
              <dt className="lcars-analysis-launcher__preview-k">SOURCE</dt>
              <dd className="lcars-analysis-launcher__preview-v">
                <span className="lcars-analysis-launcher__preview-mono">{sourceLabel}</span>
              </dd>
            </div>
          )}
          <div className="lcars-analysis-launcher__preview-row">
            <dt className="lcars-analysis-launcher__preview-k">MODE</dt>
            <dd className="lcars-analysis-launcher__preview-v">
              <strong>
                {projectsAvailable ? 'Classify (seeded)' : 'Discover (unsupervised)'}
              </strong>
              <div className="lcars-analysis-launcher__preview-note">{modeDescription}</div>
            </dd>
          </div>
          <div className="lcars-analysis-launcher__preview-row">
            <dt className="lcars-analysis-launcher__preview-k">STEPS</dt>
            <dd className="lcars-analysis-launcher__preview-v">
              <ol className="lcars-analysis-launcher__steps">
                {steps.map((s, i) => (
                  <li key={i} className="lcars-analysis-launcher__step">
                    <span className="lcars-analysis-launcher__step-title">{s.title}</span>
                    <span className="lcars-analysis-launcher__step-detail">{s.detail}</span>
                  </li>
                ))}
              </ol>
            </dd>
          </div>
          <div className="lcars-analysis-launcher__preview-row">
            <dt className="lcars-analysis-launcher__preview-k">RUNTIME</dt>
            <dd className="lcars-analysis-launcher__preview-v">
              Typically 1&ndash;5 minutes on WebGPU; longer on WASM fallback. Progress shown
              below once you kick it off.
            </dd>
          </div>
        </dl>
        <div className="lcars-analysis-launcher__actions">
          <button
            type="button"
            className="lcars-analysis-launcher__btn lcars-analysis-launcher__btn--primary"
            onClick={() => {
              setArmed(false);
              onAnalyze();
            }}
            autoFocus
          >
            ▶ {runLabel}
          </button>
          <button
            type="button"
            className="lcars-analysis-launcher__btn lcars-analysis-launcher__btn--ghost"
            onClick={() => setArmed(false)}
          >
            CANCEL
          </button>
        </div>
      </section>
    );
  }

  // --- idle: stale ---
  if (isStale && bundle) {
    return (
      <section
        className="lcars-analysis-launcher lcars-analysis-launcher--stale"
        aria-label="analysis is stale"
      >
        <div className="lcars-analysis-launcher__heading">
          <span className="lcars-analysis-launcher__badge lcars-analysis-launcher__badge--warn">
            STALE
          </span>
          <div className="lcars-analysis-launcher__title-group">
            <span className="lcars-analysis-launcher__title">LOCAL ANALYSIS</span>
            <span className="lcars-analysis-launcher__subtitle">
              {coverageGap.toLocaleString()} new {pluralize(coverageGap, 'session')} since the last run{' '}
              {coverageGap === 1 ? 'is' : 'are'} unanalyzed · {analyzedCount.toLocaleString()} /{' '}
              {totalEligibleSessions.toLocaleString()} labeled on {bundle.device.toUpperCase()}
            </span>
          </div>
        </div>
        <div className="lcars-analysis-launcher__actions">
          <button
            type="button"
            className="lcars-analysis-launcher__btn lcars-analysis-launcher__btn--primary"
            onClick={() => setArmed(true)}
          >
            ▶ RE-ANALYZE
          </button>
        </div>
      </section>
    );
  }

  // --- idle: complete ---
  if (isComplete && bundle) {
    return (
      <section
        className="lcars-analysis-launcher lcars-analysis-launcher--done"
        aria-label="analysis done"
      >
        <div className="lcars-analysis-launcher__heading">
          <span className="lcars-analysis-launcher__badge lcars-analysis-launcher__badge--ok">
            DONE
          </span>
          <div className="lcars-analysis-launcher__title-group">
            <span className="lcars-analysis-launcher__title">LOCAL ANALYSIS</span>
            <span className="lcars-analysis-launcher__subtitle">
              {analyzedCount.toLocaleString()} / {totalEligibleSessions.toLocaleString()} analyzed
              {' '}
              · {inferredCount.toLocaleString()} labeled · {abstainedCount.toLocaleString()} abstained
              {' '}· {bundle.device.toUpperCase()}
            </span>
          </div>
        </div>
        <div className="lcars-analysis-launcher__actions">
          <button
            type="button"
            className="lcars-analysis-launcher__btn lcars-analysis-launcher__btn--secondary"
            onClick={() => setArmed(true)}
          >
            RE-RUN
          </button>
        </div>
      </section>
    );
  }

  // --- idle: CTA (no bundle) ---
  const ctaNoun = pluralize(totalEligibleSessions, 'CONVERSATION', 'CONVERSATIONS');
  const ctaLabel =
    totalEligibleSessions > 0
      ? `▶ ANALYZE ${totalEligibleSessions.toLocaleString()} ${ctaNoun}`
      : '▶ ANALYZE TOPICS';
  return (
    <section className="lcars-analysis-launcher lcars-analysis-launcher--cta" aria-label="run analysis">
      <div className="lcars-analysis-launcher__heading">
        <div className="lcars-analysis-launcher__title-group">
          <span className="lcars-analysis-launcher__title">LOCAL ANALYSIS</span>
          <span className="lcars-analysis-launcher__subtitle">
            Discover re-asked prompts, zombie projects, and emergent topic clusters across your
            conversations. Runs entirely in-browser — your data never leaves the page.
          </span>
        </div>
      </div>
      <div className="lcars-analysis-launcher__actions">
        <button
          type="button"
          className="lcars-analysis-launcher__btn lcars-analysis-launcher__btn--primary lcars-analysis-launcher__btn--hero"
          onClick={() => setArmed(true)}
          disabled={totalEligibleSessions === 0}
        >
          {ctaLabel}
        </button>
      </div>
    </section>
  );
}

