import { useMemo } from 'react';
import type { Decision, DecisionsFile } from '@chat-arch/schema';
import { THRESHOLDS, wilsonCI } from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';

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
