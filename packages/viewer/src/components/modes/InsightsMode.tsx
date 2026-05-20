import { useMemo, useState } from 'react';
import { THRESHOLDS } from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';
import { MethodologyDisclosure } from '../MethodologyDisclosure.js';
import type { InsightsBundle } from '../../data/insightsLoader.js';
import { formatShortDate } from '../../util/time.js';
import {
  ackInsight,
  type InsightsAcksFile,
} from '../../data/insightsAckClient.js';

/**
 * Phase 1 expansions #2 (config-correlation) + #11 (knowledge-debt) +
 * #14 (reflexive). One mode, three sub-sections — viewer mirrors the
 * one-file-per-kernel split on disk but presents them as a single
 * "INSIGHTS" surface so the user doesn't have to chase three separate
 * modes for what are all descriptive-contrast cards.
 *
 * Critical copy posture: every card frames its numbers as a
 * **descriptive contrast, not a causal estimate**. The Wave 5 lint
 * will enforce this against the rendered DOM; we pre-comply.
 *
 * Sub-sections:
 *
 *   1. CONFIG IMPACT — from `analysis/its-analysis.json` + (commits
 *      narrative from `analysis/config-history.json`).
 *   2. KNOWLEDGE DEBT — from `analysis/knowledge-debt.json`.
 *   3. REFLEXIVE — from `analysis/reflexive.json`. Surfaces the
 *      E-value CI-bound when computed; otherwise renders the
 *      "N/A — contrast not distinguishable from null" copy mandated
 *      by the kernel's status enum.
 */

export interface InsightsModeProps {
  bundle: InsightsBundle;
  /** Click-through to a session detail surface. */
  onSelectSession?: (id: string) => void;
  /** Pre-loaded acks file (read once at mount; the mode updates a
   *  local-state copy on click so the UI doesn't need a refresh). */
  acks?: InsightsAcksFile | null;
  /**
   * Base URL where Obsidian-export markdown files live (relative to
   * the data root). When the user clicks INSTALL AS RULE on a
   * knowledge-debt cluster, the mode opens `<baseUrl>/exports/
   * knowledge-debt.md` in a new tab if supported; otherwise it copies
   * the cluster's canonical question to the clipboard so the user can
   * paste it into `/update-config`. Defaults to a sensible value.
   */
  knowledgeDebtMarkdownUrl?: string;
}

function pct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function pctAbs(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtCi(low: number, high: number): string {
  return `${pct(low)} … ${pct(high)}`;
}

/** Stable id for an ITS contrast row — used as the ack ledger key. */
function itsRowKey(r: { sha: string; path: string }): string {
  return `${r.sha}:${r.path}`;
}

export function InsightsMode({
  bundle,
  onSelectSession,
  acks: initialAcks = null,
  knowledgeDebtMarkdownUrl = 'chat-arch-data/exports/knowledge-debt.md',
}: InsightsModeProps) {
  const { its, knowledgeDebt, reflexive } = bundle;
  // Local-state copy of ack ids so a click updates the UI without a
  // refetch. Seeded from the loader's initial file.
  const [ackedIds, setAckedIds] = useState<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (const e of initialAcks?.entries ?? []) {
      s.add(`${e.kind}:${e.id}`);
    }
    return s;
  });
  const isAcked = (kind: 'its-contrast', id: string): boolean =>
    ackedIds.has(`${kind}:${id}`);
  const onAck = (kind: 'its-contrast', id: string): void => {
    void ackInsight(kind, id).then((r) => {
      if (!r.ok) return;
      setAckedIds((prev) => {
        if (prev.has(`${kind}:${id}`)) return prev;
        const next = new Set(prev);
        next.add(`${kind}:${id}`);
        return next;
      });
    });
  };

  // Wave 6 #3b — INSTALL AS RULE handler.
  // Tries to open the Obsidian markdown export in a new tab; if the
  // browser blocks (popup blocker, file:// scheme refused on some
  // hosts), copies the canonical question + sample sessions to the
  // clipboard so the user can paste them into `/update-config`.
  const onInstallAsRule = (cluster: {
    canonicalQuestion: string;
    sessionIds: readonly string[];
  }): void => {
    const lines = [
      `# Install as rule`,
      ``,
      `Canonical question: ${cluster.canonicalQuestion}`,
      ``,
      `Sample sessions (first ${Math.min(cluster.sessionIds.length, 5)}):`,
      ...cluster.sessionIds.slice(0, 5).map((s) => `- ${s}`),
      ``,
      `Next step: paste this into \`/update-config\` so the rule is added`,
      `to your CLAUDE.md / settings.json.`,
    ];
    const payload = lines.join('\n');
    const opened =
      typeof window !== 'undefined' &&
      typeof window.open === 'function'
        ? window.open(knowledgeDebtMarkdownUrl, '_blank', 'noopener')
        : null;
    if (opened !== null) return;
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard !== undefined
    ) {
      void navigator.clipboard.writeText(payload).catch(() => undefined);
    }
  };

  const itsRows = useMemo(() => {
    if (its === null) return [];
    // Hide rows where either side's n is below the display threshold —
    // a snapshot with two pre-window sessions and three post-window
    // sessions just isn't informative, and surfacing it invites the
    // reader to over-interpret. Sort by absolute delta so the biggest
    // observed contrasts surface first.
    return its.results
      .filter(
        (r) =>
          r.pre.n >= THRESHOLDS.display.minNForRate &&
          r.post.n >= THRESHOLDS.display.minNForRate,
      )
      .slice()
      .sort((a, b) => Math.abs(b.deltaGoodShare) - Math.abs(a.deltaGoodShare));
  }, [its]);

  // Partition into pending vs. acknowledged so acked rows don't
  // compete for attention on the main feed. The criterion for the
  // ACKNOWLEDGE pill is "non-zero-overlap CI" — both CI bounds on the
  // same side of 0 — meaning the contrast is clearly non-null
  // (descriptive, not causal). Other rows still render but without
  // the pill.
  const itsPending = useMemo(
    () => itsRows.filter((r) => !isAcked('its-contrast', itsRowKey(r))),
    [itsRows, ackedIds],
  );
  const itsAcknowledged = useMemo(
    () => itsRows.filter((r) => isAcked('its-contrast', itsRowKey(r))),
    [itsRows, ackedIds],
  );
  const hasClearEffect = (r: { deltaCI: { low: number; high: number } }): boolean =>
    (r.deltaCI.low > 0 && r.deltaCI.high > 0) ||
    (r.deltaCI.low < 0 && r.deltaCI.high < 0);

  const debtClusters = useMemo(() => {
    if (knowledgeDebt === null) return [];
    // Sort by cluster size desc — biggest "this question keeps coming
    // back" candidates first.
    return knowledgeDebt.clusters
      .slice()
      .sort((a, b) => b.sessionIds.length - a.sessionIds.length);
  }, [knowledgeDebt]);

  const hasAnything =
    its !== null || knowledgeDebt !== null || reflexive !== null;

  if (!hasAnything) {
    return (
      <EmptyState
        title="NO INSIGHTS DATA"
        message="INSIGHTS reads analysis/its-analysis.json + knowledge-debt.json + reflexive.json. Run pnpm exporter run start to generate them, then refresh."
      />
    );
  }

  return (
    <div className="lcars-insights">
      <header className="lcars-insights__header">
        <h2 className="lcars-insights__title">INSIGHTS</h2>
        <p className="lcars-insights__lead">
          Descriptive contrasts over your corpus — config-window
          snapshots, recurring-question clusters, and a matched-pair
          contrast for chat-arch-touched sessions. None of these are
          causal estimates; all rest on observational data with the
          caveats listed under Methodology &amp; limitations.
        </p>
      </header>

      {/* ----------------------------- CONFIG IMPACT --------------------- */}
      <section
        className="lcars-insights__section"
        aria-label="config impact snapshots"
      >
        <header className="lcars-insights__section-header">
          <h3 className="lcars-insights__section-title">CONFIG IMPACT</h3>
          <p className="lcars-insights__section-blurb">
            Pre-vs-post window snapshots around config-history commits
            (CLAUDE.md, skills, settings). Descriptive contrasts only —
            commits co-vary with everything else happening that week.
          </p>
        </header>
        {its === null ? (
          <p className="lcars-insights__empty">
            <code>analysis/its-analysis.json</code> not present yet.
          </p>
        ) : itsRows.length === 0 ? (
          <p className="lcars-insights__empty">
            No commit windows had{' '}
            {THRESHOLDS.display.minNForRate}+ sessions on both sides yet.
          </p>
        ) : (
          <>
            <ul
              className="lcars-insights__card-list"
              role="list"
              aria-label="pending config-impact contrasts"
            >
              {itsPending.slice(0, 12).map((r) => {
                const key = itsRowKey(r);
                const showAck = hasClearEffect(r);
                return (
                  <li key={`${r.sha}-${r.path}`} role="listitem">
                    <article className="lcars-insights__card">
                      <header className="lcars-insights__card-header">
                        <span className="lcars-insights__card-tag">
                          {pct(r.deltaGoodShare)} delta
                        </span>
                        <h4 className="lcars-insights__card-title">
                          {r.subject || r.path}
                        </h4>
                        <span className="lcars-insights__card-meta">
                          {formatShortDate(r.ts)} · {r.path}
                        </span>
                      </header>
                      <dl className="lcars-insights__card-dl">
                        <div className="lcars-insights__card-dl-row">
                          <dt>PRE WINDOW</dt>
                          <dd>
                            n={r.pre.n} · good {pctAbs(r.pre.goodShare)}
                          </dd>
                        </div>
                        <div className="lcars-insights__card-dl-row">
                          <dt>POST WINDOW</dt>
                          <dd>
                            n={r.post.n} · good {pctAbs(r.post.goodShare)}
                          </dd>
                        </div>
                        <div className="lcars-insights__card-dl-row">
                          <dt>DELTA 95% CI</dt>
                          <dd>{fmtCi(r.deltaCI.low, r.deltaCI.high)}</dd>
                        </div>
                        <div className="lcars-insights__card-dl-row">
                          <dt>WINDOW</dt>
                          <dd>±{r.windowDays}d</dd>
                        </div>
                      </dl>
                      {showAck && (
                        <div className="lcars-insights__card-actions">
                          <button
                            type="button"
                            className="lcars-insights__ack-pill"
                            data-testid={`ack-its-${key}`}
                            onClick={() => onAck('its-contrast', key)}
                            title="Mark this contrast as reviewed; it'll move to the ACKNOWLEDGED list."
                          >
                            ACKNOWLEDGE
                          </button>
                        </div>
                      )}
                    </article>
                  </li>
                );
              })}
            </ul>
            {itsAcknowledged.length > 0 && (
              <details
                className="lcars-insights__acked"
                aria-label="acknowledged config-impact contrasts"
              >
                <summary className="lcars-insights__acked-summary">
                  ACKNOWLEDGED ({itsAcknowledged.length})
                </summary>
                <ul className="lcars-insights__card-list" role="list">
                  {itsAcknowledged.slice(0, 12).map((r) => (
                    <li key={`${r.sha}-${r.path}-acked`} role="listitem">
                      <article className="lcars-insights__card lcars-insights__card--muted">
                        <header className="lcars-insights__card-header">
                          <span className="lcars-insights__card-tag">
                            {pct(r.deltaGoodShare)} delta
                          </span>
                          <h4 className="lcars-insights__card-title">
                            {r.subject || r.path}
                          </h4>
                          <span className="lcars-insights__card-meta">
                            {formatShortDate(r.ts)} · {r.path}
                          </span>
                        </header>
                      </article>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      {/* ----------------------------- KNOWLEDGE DEBT -------------------- */}
      <section
        className="lcars-insights__section"
        aria-label="knowledge debt clusters"
      >
        <header className="lcars-insights__section-header">
          <h3 className="lcars-insights__section-title">KNOWLEDGE DEBT</h3>
          <p className="lcars-insights__section-blurb">
            First-user-turn questions that recur across sessions — a
            signal the answer isn&rsquo;t sticking in your notes or
            CLAUDE.md. Each cluster is a candidate for a single
            artifact that pays the debt down.
          </p>
        </header>
        {knowledgeDebt === null ? (
          <p className="lcars-insights__empty">
            <code>analysis/knowledge-debt.json</code> not present yet.
          </p>
        ) : debtClusters.length === 0 ? (
          <p className="lcars-insights__empty">
            No recurring-question clusters surfaced. (Minimum cluster
            size {THRESHOLDS.clustering.minClusterSize}.)
          </p>
        ) : (
          <ul className="lcars-insights__card-list" role="list">
            {debtClusters.slice(0, 12).map((c) => (
              <li key={c.id} role="listitem">
                <article
                  className="lcars-insights__card"
                  data-confidence={c.confidence}
                >
                  <header className="lcars-insights__card-header">
                    <span className="lcars-insights__card-tag">
                      {c.sessionIds.length} sessions
                    </span>
                    <h4 className="lcars-insights__card-title">
                      {c.canonicalQuestion.length > 140
                        ? `${c.canonicalQuestion.slice(0, 140)}…`
                        : c.canonicalQuestion}
                    </h4>
                    <span className="lcars-insights__card-meta">
                      {formatShortDate(c.firstSeen)} –{' '}
                      {formatShortDate(c.lastSeen)} · confidence{' '}
                      {c.confidence}
                    </span>
                  </header>
                  {c.labelTerms.length > 0 && (
                    <p className="lcars-insights__card-tags">
                      {c.labelTerms.slice(0, 8).map((t) => (
                        <span
                          key={t}
                          className="lcars-insights__card-term"
                        >
                          {t}
                        </span>
                      ))}
                    </p>
                  )}
                  {onSelectSession !== undefined && (
                    <ul
                      className="lcars-insights__evidence"
                      role="list"
                      aria-label="evidence sessions"
                    >
                      {c.sessionIds.slice(0, 6).map((sid) => (
                        <li key={sid}>
                          <button
                            type="button"
                            className="lcars-insights__evidence-pill"
                            onClick={() => onSelectSession(sid)}
                          >
                            ▸ session: {sid.slice(0, 8)}
                          </button>
                        </li>
                      ))}
                      {c.sessionIds.length > 6 && (
                        <li>
                          <span className="lcars-insights__evidence-pill lcars-insights__evidence-pill--static">
                            +{c.sessionIds.length - 6} more
                          </span>
                        </li>
                      )}
                    </ul>
                  )}
                  <div className="lcars-insights__card-actions">
                    <button
                      type="button"
                      className="lcars-insights__install-btn"
                      data-testid={`install-rule-${c.id}`}
                      onClick={() =>
                        onInstallAsRule({
                          canonicalQuestion: c.canonicalQuestion,
                          sessionIds: c.sessionIds,
                        })
                      }
                      title="Open the Obsidian markdown export for this cluster, or copy a paste-ready snippet for /update-config."
                    >
                      INSTALL AS RULE
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ----------------------------- REFLEXIVE ------------------------ */}
      <section
        className="lcars-insights__section"
        aria-label="reflexive matched-pair contrast"
      >
        <header className="lcars-insights__section-header">
          <h3 className="lcars-insights__section-title">REFLEXIVE</h3>
          <p className="lcars-insights__section-blurb">
            1-nearest-neighbor matched-pair contrast: chat-arch-touched
            sessions vs. control. Pre-treatment covariates only
            (filesEdited / toolCallDepth excluded — collider bias).
            Descriptive contrast, not a causal estimate.
          </p>
        </header>
        {reflexive === null ? (
          <p className="lcars-insights__empty">
            <code>analysis/reflexive.json</code> not present yet.
          </p>
        ) : reflexive.result.nTreated < THRESHOLDS.display.minNForRate ? (
          <p className="lcars-insights__empty">
            Only {reflexive.result.nTreated} matched-pair contrasts so
            far — need at least {THRESHOLDS.display.minNForRate} for a
            stable reading.
          </p>
        ) : (
          <article className="lcars-insights__card">
            <header className="lcars-insights__card-header">
              <span className="lcars-insights__card-tag">
                {pct(reflexive.result.meanDelta)} mean delta
              </span>
              <h4 className="lcars-insights__card-title">
                Matched-pair good-share contrast
              </h4>
              <span className="lcars-insights__card-meta">
                nTreated={reflexive.result.nTreated} · nControl=
                {reflexive.result.nControl} · pairs={reflexive.result.pairs.length}
              </span>
            </header>
            <dl className="lcars-insights__card-dl">
              <div className="lcars-insights__card-dl-row">
                <dt>TREATED GOOD</dt>
                <dd>{pctAbs(reflexive.result.pTreated)}</dd>
              </div>
              <div className="lcars-insights__card-dl-row">
                <dt>CONTROL GOOD</dt>
                <dd>{pctAbs(reflexive.result.pControl)}</dd>
              </div>
              <div className="lcars-insights__card-dl-row">
                <dt>DELTA 95% CI</dt>
                <dd>
                  {fmtCi(reflexive.result.ci.low, reflexive.result.ci.high)}
                </dd>
              </div>
              <div className="lcars-insights__card-dl-row">
                <dt>E-VALUE (CI BOUND)</dt>
                <dd>
                  {reflexive.result.eValueStatus === 'computed' &&
                  reflexive.result.eValueCIBound !== null
                    ? reflexive.result.eValueCIBound.toFixed(2)
                    : reflexive.result.eValueStatus === 'p-control-zero'
                      ? `${reflexive.result.eValueCIBound?.toFixed(2) ?? '—'} (Wilson-floored)`
                      : 'N/A — contrast not distinguishable from null'}
                </dd>
              </div>
            </dl>
            <p className="lcars-insights__card-footnote">
              Covariates: {reflexive.methodology.covariates.join(', ')}.{' '}
              {reflexive.methodology.notes}
            </p>
          </article>
        )}
      </section>

      <MethodologyDisclosure />
    </div>
  );
}
