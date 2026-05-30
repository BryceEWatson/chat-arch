import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Decision,
  DecisionsFile,
  DecisionClustersFile,
} from '@chat-arch/schema';
import {
  THRESHOLDS,
  wilsonCI,
  unwrapEnvelope,
  groupDecisionsByKind,
  partitionDecisions,
} from '@chat-arch/analysis';
import { SidecarEmptyState } from '../SidecarEmptyState.js';
import {
  startMineDecisions,
  fetchDecisionRunStatus,
  clearDecisions,
  probeClearDecisions,
  type MineDecisionsBatch,
  type DecisionRunStatus,
} from '../../data/mineDecisionsClient.js';

/**
 * DECISIONS surface — redesigned (PR2) around two honest states:
 *
 *   1. UNCLASSIFIED (pre-mine): a clean, collapsible, BROWSABLE list of
 *      "moments you weighed one path against another." No cryptic
 *      detector PHRASE column; the surrounding context is unwrapped of
 *      harness envelopes and shown as the row's primary text. The MINE
 *      action is real (it runs the `/mine-decisions` skill) with live
 *      status-file progress.
 *   2. CLASSIFIED (post-mine): grouped by decision kind, each row a
 *      narrative — distilled decision (headline) · chose-vs-over ·
 *      rationale (the why) · confidence · outcome — with a per-kind
 *      landed-rate (Wilson 95% CI, shown only when n ≥ the display
 *      floor). Recurring decisions surface from the clusters sidecar.
 *
 * No causal copy: "landed-rate" / "correlates with", never "worked
 * because".
 */

export interface DecisionsModeProps {
  file: DecisionsFile | null;
  /** Recurring-decision clusters (analysis/decision-clusters.json). */
  clustersFile?: DecisionClustersFile | null;
  /** Data-root base URL — used to poll the run-status sidecar. */
  dataRoot?: string;
  /**
   * Re-fetch decisions + clusters in place after a mine/clear run, so the
   * surface updates without a full page reload. When omitted, the UI
   * falls back to a manual "reload" affordance.
   */
  onRefresh?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onOpenDataPanel?: () => void;
}

const MINE_BATCH_OPTIONS: ReadonlyArray<MineDecisionsBatch> = [5, 20, 'all'];
const STATUS_POLL_MS = 1500;
const UNCLASSIFIED_PREVIEW = 15;

function formatScore(s: number): string {
  return Number.isFinite(s) ? s.toFixed(2) : '—';
}
function formatRate(p: number): string {
  return Number.isFinite(p) ? `${Math.round(p * 100)}%` : '—';
}
function cleanContext(raw: string): string {
  return unwrapEnvelope(raw) ?? '(no preview)';
}
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type MineState =
  | { status: 'idle' }
  | {
      status: 'running';
      requestId: string | null;
      runStatus: DecisionRunStatus | null;
      count: number;
    }
  | { status: 'done'; ok: boolean; message: string };

export function DecisionsMode({
  file,
  clustersFile = null,
  dataRoot,
  onRefresh,
  onSelectSession,
  onOpenDataPanel,
}: DecisionsModeProps) {
  const [mineState, setMineState] = useState<MineState>({ status: 'idle' });
  const [mineBatch, setMineBatch] = useState<MineDecisionsBatch>(5);
  const [showAllUnclassified, setShowAllUnclassified] = useState(false);
  const [clearAvail, setClearAvail] = useState(false);
  const [clearState, setClearState] = useState<
    { status: 'idle' } | { status: 'armed' } | { status: 'busy' } | { status: 'done'; message: string }
  >({ status: 'idle' });

  // Probe whether the clear endpoint exists (dev server only; hidden on
  // the static hosted build).
  useEffect(() => {
    let cancelled = false;
    void probeClearDecisions().then((ok) => {
      if (!cancelled) setClearAvail(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { classified, unclassified } = useMemo(
    () => (file === null ? { classified: [], unclassified: [] } : partitionDecisions(file.decisions)),
    [file],
  );
  const kindGroups = useMemo(() => groupDecisionsByKind(classified), [classified]);

  // Poll the run-status sidecar while a mine is in flight.
  const mineStatus = mineState.status;
  const mineRequestId = mineState.status === 'running' ? mineState.requestId : null;
  useEffect(() => {
    if (mineStatus !== 'running' || mineRequestId === null || !dataRoot) return;
    let cancelled = false;
    const tick = async () => {
      const s = await fetchDecisionRunStatus(dataRoot, mineRequestId);
      if (cancelled || s === null) return;
      setMineState((prev) => (prev.status === 'running' ? { ...prev, runStatus: s } : prev));
    };
    const handle = setInterval(() => void tick(), STATUS_POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [mineStatus, mineRequestId, dataRoot]);

  if (file === null) {
    return (
      <SidecarEmptyState
        title="NO DECISIONS"
        detail="DECISIONS reads analysis/decisions.json. Open DATA → SCAN LOCAL to populate it."
        {...(onOpenDataPanel ? { onOpenDataPanel } : {})}
        testId="decisions-empty"
      />
    );
  }
  if (file.decisions.length === 0) {
    return (
      <SidecarEmptyState
        title="NO DECISIONS FOUND"
        detail="The decision-extraction kernel ran but didn't surface any candidates in your corpus."
        {...(onOpenDataPanel ? { onOpenDataPanel } : {})}
        testId="decisions-empty-found"
      />
    );
  }

  const minN = THRESHOLDS.display.minNForRate;
  const clusters = clustersFile?.clusters ?? [];

  const onMine = async () => {
    setMineState({ status: 'running', requestId: null, runStatus: null, count: 0 });
    const result = await startMineDecisions({
      batch: mineBatch,
      onStart: (requestId) =>
        setMineState((prev) => (prev.status === 'running' ? { ...prev, requestId } : prev)),
      onProgress: (count) =>
        setMineState((prev) => (prev.status === 'running' ? { ...prev, count } : prev)),
    });
    if (result.ok) onRefresh?.();
    setMineState({
      status: 'done',
      ok: result.ok,
      message: result.ok
        ? onRefresh
          ? 'Mining complete — classified decisions updated below.'
          : 'Mining complete — reload to see the classified decisions.'
        : result.stderrTail || result.error || 'Mining run did not complete.',
    });
  };

  const renderOutcome = (d: Decision) => {
    const ref = d.outcomeRef;
    if (ref === null) {
      return (
        <span className="lcars-decisions__score lcars-decisions__score--none">no outcome</span>
      );
    }
    return (
      <span
        className={`lcars-decisions__score lcars-decisions__score--${ref.binaryClass}`}
        title={`composite ${formatScore(ref.compositeScore)} · ${ref.binaryClass}`}
      >
        {ref.binaryClass.toUpperCase()} · {formatScore(ref.compositeScore)}
      </span>
    );
  };

  const renderSessionLink = (sessionId: string) =>
    onSelectSession ? (
      <button
        type="button"
        className="lcars-decisions__session-link"
        onClick={() => onSelectSession(sessionId)}
        title={`open session ${sessionId}`}
        aria-label={`open session ${sessionId}`}
      >
        ▸ {sessionId.slice(0, 12)}
      </button>
    ) : (
      <span title={sessionId}>{sessionId.slice(0, 12)}</span>
    );

  const onClear = async () => {
    setClearState({ status: 'busy' });
    try {
      const { reset } = await clearDecisions();
      onRefresh?.();
      setClearState({
        status: 'done',
        message: `Cleared ${reset} classification${reset === 1 ? '' : 's'}.${
          onRefresh ? '' : ' Reload to re-mine.'
        }`,
      });
    } catch (err) {
      setClearState({
        status: 'done',
        message: err instanceof Error ? err.message : 'Clear failed.',
      });
    }
  };

  return (
    <div className="lcars-decisions" aria-label="decisions" data-testid="decisions">
      <header className="lcars-decisions__header">
        <h2 className="lcars-decisions__title">DECISIONS</h2>
        <p className="lcars-decisions__lead">
          Moments you weighed one path against another — the forks in the road across
          your sessions. Mining classifies each into what you chose, what you turned
          down, and why, then joins it to how the session turned out.
        </p>
        <details className="lcars-decisions__method">
          <summary>How outcomes &amp; landed-rate work</summary>
          <p>
            Each decision is joined to its session&rsquo;s composite outcome —{' '}
            <strong>good</strong> / <strong>bad</strong> / <strong>neutral</strong> with
            a 0–1 score. <em>Landed-rate</em> is the share of a group&rsquo;s decisions
            whose joined outcome was &lsquo;good&rsquo;, over those with a non-neutral
            outcome. It&rsquo;s a correlation, shown only when n &ge; {minN} (below that
            the Wilson 95% CI is too wide to be informative).
          </p>
        </details>
      </header>

      {/* MINE — real action over the unclassified queue. */}
      {unclassified.length > 0 && (
        <aside
          className="lcars-decisions__cta"
          aria-label="mine decisions"
          data-testid="mine-decisions-cta"
        >
          <p className="lcars-decisions__cta-text">
            <strong>{unclassified.length}</strong>{' '}
            {unclassified.length === 1 ? 'decision is' : 'decisions are'} detected but not
            yet classified. Mining runs an LLM over them to extract the choice, the
            alternatives, and the rationale.
          </p>
          <div
            className="lcars-decisions__cta-controls"
            role="group"
            aria-label="mine decisions controls"
          >
            <label className="lcars-decisions__cta-batch" data-testid="mine-batch-selector">
              <span className="lcars-decisions__cta-batch-label">Mine</span>
              <select
                value={String(mineBatch)}
                onChange={(e) => {
                  const v = e.target.value;
                  setMineBatch(v === 'all' ? 'all' : (Number(v) as 5 | 20));
                }}
                disabled={mineState.status === 'running'}
                aria-label="batch size"
              >
                {MINE_BATCH_OPTIONS.map((opt) => (
                  <option key={String(opt)} value={String(opt)}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="lcars-decisions__cta-btn"
              disabled={mineState.status === 'running'}
              onClick={() => void onMine()}
              data-testid="mine-decisions-btn"
            >
              {mineState.status === 'running'
                ? `MINING… (${mineState.runStatus?.progress?.current ?? mineState.count})`
                : `▶ MINE ${mineBatch === 'all' ? 'ALL' : mineBatch}`}
            </button>
          </div>
          {mineState.status === 'running' && mineState.runStatus && (
            <p className="lcars-decisions__cta-status" role="status" aria-live="polite">
              {mineState.runStatus.status}
              {mineState.runStatus.progress?.total
                ? ` — ${mineState.runStatus.progress.current ?? 0}/${mineState.runStatus.progress.total}`
                : ''}
            </p>
          )}
          {mineState.status === 'done' && (
            <p
              className={
                mineState.ok ? 'lcars-decisions__cta-status' : 'lcars-decisions__cta-error'
              }
              role="status"
              aria-live="polite"
              data-testid="mine-decisions-result"
            >
              {mineState.message}
              {mineState.ok && !onRefresh && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="lcars-decisions__reload"
                    onClick={() => window.location.reload()}
                  >
                    reload
                  </button>
                </>
              )}
            </p>
          )}
        </aside>
      )}

      {/* CLASSIFIED — grouped by kind, each row a narrative. */}
      {kindGroups.map((group) => {
        const showRate = group.denom >= minN;
        const pHat = group.denom > 0 ? group.landed / group.denom : 0;
        const ci = showRate ? wilsonCI(pHat, group.denom) : null;
        return (
          <section
            key={group.key}
            className="lcars-decisions__bucket"
            aria-labelledby={`decisions-bucket-${group.key}-h`}
            data-kind={group.key}
          >
            <header className="lcars-decisions__bucket-header">
              <h3
                id={`decisions-bucket-${group.key}-h`}
                className="lcars-decisions__bucket-title"
              >
                {group.label}
              </h3>
              <span className="lcars-decisions__bucket-count">
                {group.rows.length} {group.rows.length === 1 ? 'decision' : 'decisions'}
              </span>
              {showRate && ci !== null ? (
                <span
                  className="lcars-decisions__rate"
                  title={`Wilson 95% CI: ${formatRate(ci.low)} – ${formatRate(ci.high)}`}
                  data-testid={`rate-${group.key}`}
                >
                  landed {formatRate(pHat)}{' '}
                  <span className="lcars-decisions__ci">
                    [{formatRate(ci.low)}–{formatRate(ci.high)}]
                  </span>
                </span>
              ) : (
                <span
                  className="lcars-decisions__rate lcars-decisions__rate--hidden"
                  data-testid={`rate-hidden-${group.key}`}
                >
                  landed-rate hidden — n={group.denom} of {minN}
                </span>
              )}
            </header>
            <ul className="lcars-decisions__rows" role="list">
              {group.rows.map((d) => {
                const c = d.classification!;
                return (
                  <li
                    key={`${d.candidate.sessionId}-${d.candidate.userTurnIndex}-${d.candidate.span.startOffset}`}
                    className="lcars-decisions__row"
                    data-decision-key={`${d.candidate.sessionId}:${d.candidate.userTurnIndex}`}
                  >
                    <div className="lcars-decisions__row-head">
                      <span className="lcars-decisions__distilled">{c.distilledDecision}</span>
                      {renderOutcome(d)}
                    </div>
                    <div className="lcars-decisions__choice">
                      <span className="lcars-decisions__chose">
                        chose: {c.chosen.join(', ') || '—'}
                      </span>
                      {c.rejected.length > 0 && (
                        <span className="lcars-decisions__over">
                          over: {c.rejected.join(', ')}
                        </span>
                      )}
                    </div>
                    {c.rationale && <p className="lcars-decisions__rationale">{c.rationale}</p>}
                    <div className="lcars-decisions__row-foot">
                      {renderSessionLink(d.candidate.sessionId)}
                      <span
                        className="lcars-decisions__confidence"
                        title="classifier-reported confidence"
                      >
                        conf {formatScore(c.confidence)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {/* Clear classifications — reset to candidates so the user can re-mine.
          Only when there's something to clear and the endpoint exists. */}
      {classified.length > 0 && clearAvail && (
        <div className="lcars-decisions__clear" data-testid="decisions-clear">
          {clearState.status === 'idle' && (
            <button
              type="button"
              className="lcars-decisions__clear-btn"
              onClick={() => setClearState({ status: 'armed' })}
              data-testid="decisions-clear-arm"
            >
              clear classifications &amp; re-mine
            </button>
          )}
          {clearState.status === 'armed' && (
            <span className="lcars-decisions__clear-confirm">
              Reset all {classified.length} classifications back to candidates? Decision
              candidates are preserved.{' '}
              <button
                type="button"
                className="lcars-decisions__clear-btn"
                onClick={() => void onClear()}
                data-testid="decisions-clear-confirm"
              >
                confirm
              </button>{' '}
              <button
                type="button"
                className="lcars-decisions__clear-btn"
                onClick={() => setClearState({ status: 'idle' })}
              >
                cancel
              </button>
            </span>
          )}
          {clearState.status === 'busy' && (
            <span className="lcars-decisions__clear-confirm" role="status">
              Clearing…
            </span>
          )}
          {clearState.status === 'done' && (
            <span className="lcars-decisions__clear-confirm" role="status" aria-live="polite">
              {clearState.message}
              {!onRefresh && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="lcars-decisions__reload"
                    onClick={() => window.location.reload()}
                  >
                    reload
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      )}

      {/* RECURRING — clusters of the same call made across sessions. */}
      {clusters.length > 0 && (
        <section
          className="lcars-decisions__recurring"
          aria-label="recurring decisions"
          data-testid="decisions-recurring"
        >
          <h3 className="lcars-decisions__bucket-title">RECURRING DECISIONS</h3>
          <p className="lcars-decisions__recurring-lead">
            The same call, made across multiple sessions.
          </p>
          <ul className="lcars-decisions__rows" role="list">
            {clusters.map((cl) => (
              <li key={cl.id} className="lcars-decisions__row">
                <div className="lcars-decisions__row-head">
                  <span className="lcars-decisions__distilled">{cl.canonicalDecision}</span>
                  <span className="lcars-decisions__bucket-count">
                    {cl.occurrenceCount} sessions
                  </span>
                </div>
                {cl.landedRate !== null && (
                  <div className="lcars-decisions__choice">
                    <span className="lcars-decisions__chose">
                      landed {formatRate(cl.landedRate)} of {cl.landedDenom} decided
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* UNCLASSIFIED — clean browsable list, collapsed. */}
      {unclassified.length > 0 && (
        <section
          className="lcars-decisions__unclassified"
          aria-label="unclassified decisions"
          data-testid="decisions-unclassified"
        >
          <h3 className="lcars-decisions__bucket-title">
            NOT YET CLASSIFIED ({unclassified.length})
          </h3>
          <ul className="lcars-decisions__rows" role="list">
            {(showAllUnclassified
              ? unclassified
              : unclassified.slice(0, UNCLASSIFIED_PREVIEW)
            ).map((d) => {
              const ctx = cleanContext(d.candidate.surroundingContext);
              return (
                <li
                  key={`${d.candidate.sessionId}-${d.candidate.userTurnIndex}-${d.candidate.span.startOffset}`}
                  className="lcars-decisions__row lcars-decisions__row--pending"
                  data-decision-key={`${d.candidate.sessionId}:${d.candidate.userTurnIndex}`}
                >
                  <div className="lcars-decisions__row-head">
                    <span className="lcars-decisions__context" title={ctx}>
                      {truncate(ctx, 240)}
                    </span>
                    {renderOutcome(d)}
                  </div>
                  <div className="lcars-decisions__row-foot">
                    {renderSessionLink(d.candidate.sessionId)}
                  </div>
                </li>
              );
            })}
          </ul>
          {unclassified.length > UNCLASSIFIED_PREVIEW && (
            <button
              type="button"
              className="lcars-decisions__show-all"
              onClick={() => setShowAllUnclassified((v) => !v)}
              data-testid="decisions-show-all"
            >
              {showAllUnclassified ? 'show fewer' : `show all ${unclassified.length}`}
            </button>
          )}
        </section>
      )}

      <footer className="lcars-decisions__legend" aria-label="outcome legend">
        <span className="lcars-decisions__score lcars-decisions__score--good">GOOD</span> /{' '}
        <span className="lcars-decisions__score lcars-decisions__score--bad">BAD</span> /{' '}
        <span className="lcars-decisions__score lcars-decisions__score--neutral">NEUTRAL</span>{' '}
        is the joined composite outcome; the number is its 0–1 score. &lsquo;no
        outcome&rsquo; means the session wasn&rsquo;t scored.
      </footer>
    </div>
  );
}
