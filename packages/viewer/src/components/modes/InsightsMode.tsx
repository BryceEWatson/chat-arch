import { useEffect, useMemo, useState } from 'react';
import { THRESHOLDS } from '@chat-arch/analysis';
import { SidecarEmptyState } from '../SidecarEmptyState.js';
import { MethodologyDisclosure } from '../MethodologyDisclosure.js';
import { CopyMarkdownButton } from '../CopyMarkdownButton.js';
import {
  loadKnowledgeDebtStates,
  setKnowledgeDebtState,
  type KnowledgeDebtStateValue,
} from '../../data/knowledgeDebtStateClient.js';
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
  /**
   * Wave 7 P1 #4 — wire empty-state CTA to the data panel.
   */
  onOpenDataPanel?: () => void;
  /**
   * Wave 7 P2 #9 — base URL for the knowledge-debt-state ledger.
   * Defaults to the standalone data root; tests override.
   */
  dataDirBaseUrl?: string;
}

/**
 * Wave 7 P2 #8 — extended ack entry. We persist the `deltaCI` at the
 * time of ack so future renders can compare it against the current
 * delta and flag drift. Backward-compatible: old ledger entries that
 * lack the snapshot just don't get drift-checked.
 */
interface ItsAckSnapshot {
  deltaCI: { low: number; high: number };
  nPost: number;
  nPre: number;
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
  onOpenDataPanel,
  dataDirBaseUrl = 'chat-arch-data',
}: InsightsModeProps) {
  const { its, knowledgeDebt, reflexive } = bundle;
  // Local-state copy of ack ids so a click updates the UI without a
  // refetch. Seeded from the loader's initial file. We also extract any
  // `snapshot` field carried on legacy entries so drift detection can
  // run without a server round-trip.
  const [ackedIds, setAckedIds] = useState<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (const e of initialAcks?.entries ?? []) {
      s.add(`${e.kind}:${e.id}`);
    }
    return s;
  });
  const [ackSnapshots, setAckSnapshots] = useState<
    ReadonlyMap<string, ItsAckSnapshot>
  >(() => {
    const m = new Map<string, ItsAckSnapshot>();
    for (const e of initialAcks?.entries ?? []) {
      if (e.kind !== 'its-contrast') continue;
      const snap = (e as { snapshot?: ItsAckSnapshot }).snapshot;
      if (snap !== undefined && snap !== null) {
        m.set(`${e.kind}:${e.id}`, snap);
      }
    }
    return m;
  });
  const isAcked = (kind: 'its-contrast', id: string): boolean =>
    ackedIds.has(`${kind}:${id}`);
  const onAck = (
    kind: 'its-contrast',
    id: string,
    snapshot?: ItsAckSnapshot,
  ): void => {
    void ackInsight(kind, id).then((r) => {
      if (!r.ok) return;
      setAckedIds((prev) => {
        if (prev.has(`${kind}:${id}`)) return prev;
        const next = new Set(prev);
        next.add(`${kind}:${id}`);
        return next;
      });
      if (snapshot !== undefined) {
        setAckSnapshots((prev) => {
          const next = new Map(prev);
          next.set(`${kind}:${id}`, snapshot);
          return next;
        });
      }
    });
  };

  // Wave 7 P2 #9 — knowledge-debt cluster states. Loaded once on mount
  // from the on-disk ledger; updates fire through the same single-
  // flight POST endpoint. PENDING is the implicit default for any
  // cluster not in the ledger.
  const [clusterStates, setClusterStates] = useState<
    ReadonlyMap<string, { state: KnowledgeDebtStateValue; sizeAtState: number }>
  >(new Map());
  useEffect(() => {
    let cancelled = false;
    void loadKnowledgeDebtStates(dataDirBaseUrl).then((file) => {
      if (cancelled || file === null) return;
      const m = new Map<
        string,
        { state: KnowledgeDebtStateValue; sizeAtState: number }
      >();
      for (const e of file.entries) {
        m.set(e.clusterId, {
          state: e.state,
          sizeAtState: e.sizeAtState,
        });
      }
      setClusterStates(m);
    });
    return () => {
      cancelled = true;
    };
  }, [dataDirBaseUrl]);
  const onClusterStateChange = (
    clusterId: string,
    state: KnowledgeDebtStateValue,
    currentSize: number,
  ): void => {
    void setKnowledgeDebtState(clusterId, state, currentSize).then((r) => {
      if (!r.ok) return;
      setClusterStates((prev) => {
        const next = new Map(prev);
        next.set(clusterId, { state, sizeAtState: currentSize });
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

  /**
   * Wave 7 P2 #8 — ack staleness check. An acked row is "stale" when
   * the current `deltaCI` no longer overlaps the originally-acked
   * `deltaCI`, OR when post-window n has grown by ≥ the configured
   * fraction since ack-time. Stale rows are promoted back to the
   * pending pile with a STALE-ACK chip.
   */
  const isStaleAck = (
    key: string,
    current: { deltaCI: { low: number; high: number }; post: { n: number } },
  ): boolean => {
    const snap = ackSnapshots.get(`its-contrast:${key}`);
    if (snap === undefined) return false;
    // CI moved outside snapshot CI on either side.
    if (
      current.deltaCI.low > snap.deltaCI.high ||
      current.deltaCI.high < snap.deltaCI.low
    ) {
      return true;
    }
    // n-growth check.
    const growthFloor =
      snap.nPost *
      (1 + THRESHOLDS.actionBanner.staleAckPostNGrowthFraction);
    if (current.post.n >= growthFloor && snap.nPost > 0) {
      return true;
    }
    return false;
  };

  // Partition into pending vs. acknowledged so acked rows don't
  // compete for attention on the main feed. The criterion for the
  // ACKNOWLEDGE pill is "non-zero-overlap CI" — both CI bounds on the
  // same side of 0 — meaning the contrast is clearly non-null
  // (descriptive, not causal). Other rows still render but without
  // the pill. Stale-ack rows count as pending again per #8.
  const itsPending = useMemo(
    () =>
      itsRows.filter((r) => {
        const key = itsRowKey(r);
        if (!isAcked('its-contrast', key)) return true;
        return isStaleAck(key, r);
      }),
    // isAcked / isStaleAck close over ackedIds + ackSnapshots which are
    // both listed; restating the helpers in deps would be redundant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itsRows, ackedIds, ackSnapshots],
  );
  const itsAcknowledged = useMemo(
    () =>
      itsRows.filter((r) => {
        const key = itsRowKey(r);
        if (!isAcked('its-contrast', key)) return false;
        return !isStaleAck(key, r);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itsRows, ackedIds, ackSnapshots],
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

  /**
   * Wave 7 P2 #9 — given a cluster's persisted state + current size,
   * decide whether the cluster should render in the active pile or
   * the DISMISSED collapse. DISMISSED clusters re-promote when their
   * current size grows by ≥ the repromotion multiplier from the
   * snapshot taken at dismissal.
   */
  const effectiveClusterState = (
    clusterId: string,
    currentSize: number,
  ): KnowledgeDebtStateValue => {
    const persisted = clusterStates.get(clusterId);
    if (persisted === undefined) return 'PENDING';
    if (persisted.state !== 'DISMISSED') return persisted.state;
    const repromotionMin =
      persisted.sizeAtState *
      THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;
    if (currentSize >= repromotionMin && persisted.sizeAtState > 0) {
      return 'PENDING';
    }
    return 'DISMISSED';
  };

  const debtActive = useMemo(
    () =>
      debtClusters.filter(
        (c) => effectiveClusterState(c.id, c.sessionIds.length) !== 'DISMISSED',
      ),
    // effectiveClusterState closes over clusterStates which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debtClusters, clusterStates],
  );
  const debtDismissed = useMemo(
    () =>
      debtClusters.filter(
        (c) => effectiveClusterState(c.id, c.sessionIds.length) === 'DISMISSED',
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debtClusters, clusterStates],
  );

  const hasAnything =
    its !== null || knowledgeDebt !== null || reflexive !== null;

  if (!hasAnything) {
    return (
      <SidecarEmptyState
        title="NO INSIGHTS DATA"
        detail="INSIGHTS reads analysis/its-analysis.json + knowledge-debt.json + reflexive.json. Open DATA → SCAN LOCAL to populate them, then refresh."
        {...(onOpenDataPanel ? { onOpenDataPanel } : {})}
        testId="insights-empty"
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
                const isStale =
                  isAcked('its-contrast', key) && isStaleAck(key, r);
                const copyBody = [
                  `${r.subject || r.path}`,
                  `Δ good-share: ${pct(r.deltaGoodShare)}`,
                  `Δ 95% CI: ${fmtCi(r.deltaCI.low, r.deltaCI.high)}`,
                  `Pre window: n=${r.pre.n}, good ${pctAbs(r.pre.goodShare)}`,
                  `Post window: n=${r.post.n}, good ${pctAbs(r.post.goodShare)}`,
                  `Window: ±${r.windowDays}d  ·  Commit: ${r.sha.slice(0, 7)}  ·  Path: ${r.path}`,
                ];
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
                        {isStale && (
                          <span
                            className="lcars-insights__chip lcars-insights__chip--stale"
                            data-testid={`stale-ack-${key}`}
                            title="The CI moved or post-n grew significantly since this row was acknowledged. Re-review."
                          >
                            STALE ACK — re-review
                          </span>
                        )}
                        <CopyMarkdownButton
                          title="CONFIG IMPACT"
                          bodyLines={copyBody}
                          testId={`copy-its-${key}`}
                        />
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
                            onClick={() =>
                              onAck('its-contrast', key, {
                                deltaCI: r.deltaCI,
                                nPost: r.post.n,
                                nPre: r.pre.n,
                              })
                            }
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
          <>
            <ul className="lcars-insights__card-list" role="list">
              {debtActive.slice(0, 12).map((c) => {
                const persistedState =
                  clusterStates.get(c.id)?.state ?? 'PENDING';
                const installed = persistedState === 'INSTALLED';
                const copyBody = [
                  c.canonicalQuestion,
                  `Cluster size: ${c.sessionIds.length} sessions`,
                  `First seen: ${formatShortDate(c.firstSeen)}  ·  Last seen: ${formatShortDate(c.lastSeen)}`,
                  `Confidence: ${c.confidence}`,
                  c.labelTerms.length > 0
                    ? `Top terms: ${c.labelTerms.slice(0, 8).join(', ')}`
                    : '',
                ].filter((l) => l.length > 0);
                return (
                  <li key={c.id} role="listitem">
                    <article
                      className={
                        'lcars-insights__card' +
                        (installed ? ' lcars-insights__card--installed' : '')
                      }
                      data-confidence={c.confidence}
                      data-cluster-state={persistedState}
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
                        {installed && (
                          <span
                            className="lcars-insights__chip lcars-insights__chip--installed"
                            data-testid={`cluster-installed-${c.id}`}
                          >
                            INSTALLED
                          </span>
                        )}
                        <CopyMarkdownButton
                          title="KNOWLEDGE DEBT — recurring question"
                          bodyLines={copyBody}
                          testId={`copy-debt-${c.id}`}
                        />
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
                          onClick={() => {
                            onInstallAsRule({
                              canonicalQuestion: c.canonicalQuestion,
                              sessionIds: c.sessionIds,
                            });
                            onClusterStateChange(
                              c.id,
                              'INSTALLED',
                              c.sessionIds.length,
                            );
                          }}
                          title="Open the Obsidian markdown export for this cluster, or copy a paste-ready snippet for /update-config."
                        >
                          INSTALL AS RULE
                        </button>
                        <button
                          type="button"
                          className="lcars-insights__dismiss-btn"
                          data-testid={`dismiss-cluster-${c.id}`}
                          onClick={() =>
                            onClusterStateChange(
                              c.id,
                              'DISMISSED',
                              c.sessionIds.length,
                            )
                          }
                          title={`Hide this cluster. It will return when its size grows ≥${THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier}× from now.`}
                        >
                          DISMISS
                        </button>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
            {debtDismissed.length > 0 && (
              <details
                className="lcars-insights__dismissed"
                aria-label="dismissed knowledge-debt clusters"
              >
                <summary
                  className="lcars-insights__dismissed-summary"
                  data-testid="dismissed-clusters-summary"
                >
                  DISMISSED ({debtDismissed.length})
                </summary>
                <ul className="lcars-insights__card-list" role="list">
                  {debtDismissed.slice(0, 12).map((c) => (
                    <li key={c.id} role="listitem">
                      <article
                        className="lcars-insights__card lcars-insights__card--muted"
                        data-cluster-state="DISMISSED"
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
                          <button
                            type="button"
                            className="lcars-insights__restore-btn"
                            data-testid={`restore-cluster-${c.id}`}
                            onClick={() =>
                              onClusterStateChange(
                                c.id,
                                'PENDING',
                                c.sessionIds.length,
                              )
                            }
                            title="Restore this cluster to the active list."
                          >
                            RESTORE
                          </button>
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
              <CopyMarkdownButton
                title="REFLEXIVE — matched-pair contrast"
                bodyLines={[
                  `Mean delta: ${pct(reflexive.result.meanDelta)}`,
                  `Delta 95% CI: ${fmtCi(reflexive.result.ci.low, reflexive.result.ci.high)}`,
                  `Treated good: ${pctAbs(reflexive.result.pTreated)}  ·  Control good: ${pctAbs(reflexive.result.pControl)}`,
                  `n_treated=${reflexive.result.nTreated}  ·  n_control=${reflexive.result.nControl}  ·  pairs=${reflexive.result.pairs.length}`,
                  reflexive.result.eValueStatus === 'computed' &&
                  reflexive.result.eValueCIBound !== null
                    ? `E-value (CI bound): ${reflexive.result.eValueCIBound.toFixed(2)}`
                    : reflexive.result.eValueStatus === 'p-control-zero' &&
                        reflexive.result.eValueCIBound !== null
                      ? `E-value (Wilson-floored): ${reflexive.result.eValueCIBound.toFixed(2)}`
                      : 'E-value: N/A — contrast not distinguishable from null',
                ]}
                testId="copy-reflexive"
              />
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
