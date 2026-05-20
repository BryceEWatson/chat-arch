import { useMemo, useState } from 'react';
import type { Decision, DecisionsFile } from '@chat-arch/schema';
import { THRESHOLDS, wilsonCI } from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';
import { startMineDecisions } from '../../data/mineDecisionsClient.js';

/**
 * Stream J #1 — DECISIONS surface.
 *
 * Renders a table of LLM-classified decisions grouped by topic.
 * Each row carries the underlying user-turn phrase, surrounding
 * context, decision kind, and (when joined) a composite-score chip
 * sourced from `outcomeRef.compositeScore`. Per-topic landed-rate
 * is shown with a Wilson 95% CI, but only when n ≥
 * `THRESHOLDS.display.minNForRate` (below that the rate column
 * is suppressed — the CI is too wide to be informative).
 *
 * No causal copy: the panel says "landed-rate" / "correlates with",
 * not "decisions that worked because…".
 */

export interface DecisionsModeProps {
  file: DecisionsFile | null;
  onSelectSession?: (sessionId: string) => void;
}

/** Group decisions by topic-ish bucket. Falls back to "Untagged" when the
 *  LLM-classification pass hasn't tagged the row yet. The Phase 2 #1
 *  builder does not yet emit a topic field on the classification, so for
 *  now we bucket by `classification.kind` (or 'unclassified'). When the
 *  Phase 2 #1 follow-up adds `classification.topic`, swap that in here. */
interface TopicBucket {
  key: string;
  label: string;
  rows: readonly Decision[];
  /** Subset where outcomeRef joined AND binaryClass !== 'neutral' — denominator
   *  for the landed-rate. */
  denom: number;
  /** Subset where outcomeRef.binaryClass === 'good'. */
  landed: number;
}

const KIND_LABEL: Record<string, string> = {
  'explicit-marker': 'EXPLICIT MARKER',
  'explicit-go-with': 'GO-WITH',
  'instead-of': 'INSTEAD-OF',
  'alternative-block': 'ALTERNATIVE',
  'imperative-choice': 'IMPERATIVE',
  'tool-pivot': 'TOOL PIVOT',
  'scope-cut': 'SCOPE CUT',
  other: 'OTHER',
  unclassified: 'UNCLASSIFIED',
};

function topicKeyOf(d: Decision): string {
  const cls = d.classification;
  if (cls === null) return 'unclassified';
  return cls.kind;
}

function buildBuckets(decisions: readonly Decision[]): TopicBucket[] {
  const m = new Map<string, Decision[]>();
  for (const d of decisions) {
    const k = topicKeyOf(d);
    const arr = m.get(k);
    if (arr) arr.push(d);
    else m.set(k, [d]);
  }
  const out: TopicBucket[] = [];
  for (const [key, rows] of m) {
    let denom = 0;
    let landed = 0;
    for (const r of rows) {
      const ref = r.outcomeRef;
      if (ref === null || ref.binaryClass === 'neutral') continue;
      denom += 1;
      if (ref.binaryClass === 'good') landed += 1;
    }
    out.push({
      key,
      label: KIND_LABEL[key] ?? key.toUpperCase(),
      rows,
      denom,
      landed,
    });
  }
  // Largest buckets first; unclassified pinned to the bottom.
  out.sort((a, b) => {
    if ((a.key === 'unclassified') !== (b.key === 'unclassified')) {
      return a.key === 'unclassified' ? 1 : -1;
    }
    if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
    return a.label.localeCompare(b.label);
  });
  return out;
}

function formatScore(s: number): string {
  if (!Number.isFinite(s)) return '—';
  return s.toFixed(2);
}

function formatRate(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${Math.round(p * 100)}%`;
}

function scoreClass(binary: 'good' | 'bad' | 'neutral'): string {
  return `lcars-decisions__score lcars-decisions__score--${binary}`;
}

export function DecisionsMode({ file, onSelectSession }: DecisionsModeProps) {
  const buckets = useMemo(
    () => (file === null ? [] : buildBuckets(file.decisions)),
    [file],
  );

  // Wave 6 #3a — surface the unclassified-decisions queue at the top
  // of the mode so the user knows there's an LLM-pass available. Count
  // is observational: classification === null on the on-disk row.
  const unclassifiedCount = useMemo(() => {
    if (file === null) return 0;
    let n = 0;
    for (const d of file.decisions) if (d.classification === null) n += 1;
    return n;
  }, [file]);
  const [mineState, setMineState] = useState<
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; ok: boolean; stderr: string | null }
  >({ status: 'idle' });

  const onMine = async () => {
    setMineState({ status: 'running' });
    const result = await startMineDecisions();
    setMineState({
      status: 'done',
      ok: result.ok,
      stderr: result.stderrTail ?? null,
    });
  };

  if (file === null) {
    return (
      <EmptyState
        title="NO DECISIONS"
        message="DECISIONS reads analysis/decisions.json. Run the exporter to generate it."
      />
    );
  }

  if (file.decisions.length === 0) {
    return (
      <EmptyState
        title="NO DECISIONS FOUND"
        message="The decision-extraction kernel ran but didn't surface any candidates in your corpus."
      />
    );
  }

  const minN = THRESHOLDS.display.minNForRate;

  return (
    <div className="lcars-decisions" aria-label="decisions">
      <header className="lcars-decisions__header">
        <h2 className="lcars-decisions__title">DECISIONS</h2>
        <p className="lcars-decisions__lead">
          Decisions detected in your archive, grouped by kind. Landed-rate is the share
          of decisions whose joined outcome was &lsquo;good&rsquo; — hidden when n &lt;{' '}
          {minN} (the Wilson 95% CI is too wide to be informative).
        </p>
      </header>
      {unclassifiedCount > 0 && (
        <aside
          className="lcars-decisions__cta"
          aria-label="mine decisions"
          data-testid="mine-decisions-cta"
        >
          <p className="lcars-decisions__cta-text">
            <strong>{unclassifiedCount}</strong>{' '}
            {unclassifiedCount === 1 ? 'decision awaits' : 'decisions await'}{' '}
            classification. Mining will use an LLM to extract{' '}
            {`{question, alternatives, chosen, rationale}`} for each — same
            shape as <code>/mine-corrections</code> does for corrections.
          </p>
          <button
            type="button"
            className="lcars-decisions__cta-btn"
            disabled={mineState.status === 'running'}
            onClick={() => void onMine()}
            data-testid="mine-decisions-btn"
          >
            {mineState.status === 'running' ? 'MINING…' : '▶ MINE DECISIONS'}
          </button>
          {mineState.status === 'done' && !mineState.ok && (
            <p
              className="lcars-decisions__cta-error"
              role="status"
              aria-live="polite"
            >
              {mineState.stderr ?? 'Mining run did not complete.'}
            </p>
          )}
          {mineState.status === 'done' && mineState.ok && (
            <p
              className="lcars-decisions__cta-status"
              role="status"
              aria-live="polite"
            >
              Mining complete — refresh the page to pick up new classifications.
            </p>
          )}
        </aside>
      )}
      {buckets.map((bucket) => {
        const showRate = bucket.denom >= minN;
        const pHat = bucket.denom > 0 ? bucket.landed / bucket.denom : 0;
        const ci = showRate ? wilsonCI(pHat, bucket.denom) : null;
        return (
          <section
            key={bucket.key}
            className="lcars-decisions__bucket"
            aria-label={bucket.label}
            data-kind={bucket.key}
          >
            <header className="lcars-decisions__bucket-header">
              <h3 className="lcars-decisions__bucket-title">{bucket.label}</h3>
              <span className="lcars-decisions__bucket-count">
                {bucket.rows.length}{' '}
                {bucket.rows.length === 1 ? 'decision' : 'decisions'}
              </span>
              {showRate && ci !== null ? (
                <span
                  className="lcars-decisions__rate"
                  title={`Wilson 95% CI: ${formatRate(ci.low)} – ${formatRate(ci.high)}`}
                  data-testid={`rate-${bucket.key}`}
                >
                  landed {formatRate(pHat)}{' '}
                  <span className="lcars-decisions__ci">
                    [{formatRate(ci.low)}–{formatRate(ci.high)}]
                  </span>
                </span>
              ) : (
                <span
                  className="lcars-decisions__rate lcars-decisions__rate--hidden"
                  data-testid={`rate-hidden-${bucket.key}`}
                  title={`n=${bucket.denom} below display floor (${minN})`}
                >
                  rate hidden — n &lt; {minN}
                </span>
              )}
            </header>
            <table className="lcars-decisions__table" role="table">
              <thead>
                <tr>
                  <th scope="col">PHRASE</th>
                  <th scope="col">CONTEXT</th>
                  <th scope="col">SESSION</th>
                  <th scope="col">OUTCOME</th>
                </tr>
              </thead>
              <tbody>
                {bucket.rows.map((d) => {
                  const cand = d.candidate;
                  const ref = d.outcomeRef;
                  const ctx = cand.surroundingContext.trim();
                  const ctxShort =
                    ctx.length > 200 ? `${ctx.slice(0, 197)}…` : ctx;
                  return (
                    <tr
                      key={`${cand.sessionId}-${cand.userTurnIndex}-${cand.kind}-${cand.span.startOffset}`}
                      data-decision-key={`${cand.sessionId}:${cand.userTurnIndex}`}
                    >
                      <td className="lcars-decisions__phrase">
                        <code title={cand.span.phrase}>
                          {cand.span.phrase}
                        </code>
                      </td>
                      <td className="lcars-decisions__context">
                        <span title={ctx}>{ctxShort}</span>
                      </td>
                      <td className="lcars-decisions__session">
                        {onSelectSession ? (
                          <button
                            type="button"
                            className="lcars-decisions__session-link"
                            onClick={() => onSelectSession(cand.sessionId)}
                            title={`open session ${cand.sessionId}`}
                          >
                            ▸ {cand.sessionId.slice(0, 12)}
                          </button>
                        ) : (
                          <span title={cand.sessionId}>
                            {cand.sessionId.slice(0, 12)}
                          </span>
                        )}
                      </td>
                      <td>
                        {ref === null ? (
                          <span className="lcars-decisions__score lcars-decisions__score--none">
                            no outcome
                          </span>
                        ) : (
                          <span
                            className={scoreClass(ref.binaryClass)}
                            title={`composite ${formatScore(ref.compositeScore)} · ${ref.binaryClass}`}
                          >
                            {ref.binaryClass.toUpperCase()} ·{' '}
                            {formatScore(ref.compositeScore)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}
