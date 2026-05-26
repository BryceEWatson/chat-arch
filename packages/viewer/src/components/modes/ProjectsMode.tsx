import { useEffect, useMemo, useState } from 'react';
import type {
  UnifiedSessionEntry,
  Project,
  Topic,
  Narrative,
  ProjectSentiment,
} from '@chat-arch/schema';
import { isUnassignedProject } from '@chat-arch/schema';
import { narrativeSaturation } from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';
import { onActivate } from '../../util/a11y.js';
import { SessionCard } from '../SessionCard.js';
import {
  buildCorrectivePromptBody,
  buildPatternFromNarrative,
  copyToClipboard,
  encodePattern,
  fetchRepoGround,
  probeNarrativeActionsAvailable,
  savePrompt,
} from '../../data/narrativeActions.js';
import {
  loadEntityStates,
  setEntityState,
  type EntityStateValue,
} from '../../data/entityStatesClient.js';
// `buildClaudeMdMarkdown` is exported by narrativeActions and consumed
// by the encode-pattern endpoint when a `claudeMdMarkdown` payload is
// supplied — Phase 7 ships the endpoint + helper, while the UI flow
// for picking a target repo + flipping the "also append" checkbox
// follows in Phase 7.1 (TODO: hoist a CLAUDE.md toggle here).

/**
 * v2 spec §5.1: PROJECTS surface — index + detail in one component
 * driven by `selectedProjectId`. Detail layout is single-scroll with
 * narrative cards on top, the project's session list below, and topic
 * chips threaded throughout.
 *
 * Discovery-only (spec §4.1) — no manual project creation. The list is
 * derived from `analysis/projects.json` (server-rendered) or from the
 * in-browser kernel pass (uploaded data) — see `computeV2Entities` in
 * the viewer's data layer for the parity wiring.
 */

export interface ProjectsModeProps {
  /** All projects, including the `[UNASSIGNED]` pseudo-project. */
  projects: readonly Project[];
  /** All topics — used to look up displayName by id for project rollups. */
  topics: readonly Topic[];
  /** All narratives — keyed by id for the detail surface's narrative cards. */
  narratives: readonly Narrative[];
  /** Full session set so detail can render the project's sessions. */
  sessions: readonly UnifiedSessionEntry[];
  /** Selected project id (null = index view). Driven by URL hash in the host. */
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onSelectSession: (id: string) => void;
  /**
   * Rev3-D D3 — base URL for the entity-states ledger. Defaults to the
   * standalone data root; tests override. The detail surface uses this
   * to load per-narrative dismissal state for the audit affordance.
   */
  dataDirBaseUrl?: string;
}

const SENTIMENT_LABEL: Record<ProjectSentiment, string> = {
  positive: 'POSITIVE',
  negative: 'NEGATIVE',
  neutral: 'NEUTRAL',
  mixed: 'MIXED',
};

const SENTIMENT_CLASS: Record<ProjectSentiment, string> = {
  positive: 'lcars-projects__sentiment--positive',
  negative: 'lcars-projects__sentiment--negative',
  neutral: 'lcars-projects__sentiment--neutral',
  mixed: 'lcars-projects__sentiment--mixed',
};

function lastActivityRelative(iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '—';
  const diffMs = Math.max(0, now - ts);
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function ProjectsMode({
  projects,
  topics,
  narratives,
  sessions,
  selectedProjectId,
  onSelectProject,
  onSelectSession,
  dataDirBaseUrl = 'chat-arch-data',
}: ProjectsModeProps) {
  const now = useMemo(() => Date.now(), []);

  // Topic id → displayName for rollup chips on detail.
  const topicNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of topics) m.set(t.id, t.displayName);
    return m;
  }, [topics]);

  // Narrative id → narrative for fast detail-page lookup.
  const narrativeById = useMemo(() => {
    const m = new Map<string, Narrative>();
    for (const n of narratives) m.set(n.id, n);
    return m;
  }, [narratives]);

  // Session id → entry for the detail surface session list.
  const sessionById = useMemo(() => {
    const m = new Map<string, UnifiedSessionEntry>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  if (projects.length === 0) {
    return (
      <EmptyState
        title="NO PROJECTS YET"
        message="No projects discovered in the active manifest. Upload a cloud export or scan local sources to populate."
      />
    );
  }

  if (selectedProjectId) {
    const proj = projects.find((p) => p.id === selectedProjectId);
    if (!proj) {
      return (
        <EmptyState
          title="PROJECT NOT FOUND"
          message={`No project with id ${selectedProjectId} in the active manifest.`}
        />
      );
    }
    return (
      <ProjectDetail
        project={proj}
        narratives={proj.narrativeIds.map((id) => narrativeById.get(id)).filter(Boolean) as Narrative[]}
        topicNameById={topicNameById}
        sessionById={sessionById}
        onBack={() => onSelectProject(null)}
        onSelectSession={onSelectSession}
        now={now}
        dataDirBaseUrl={dataDirBaseUrl}
      />
    );
  }

  return (
    <ProjectsIndex
      projects={projects}
      onSelectProject={onSelectProject}
      now={now}
    />
  );
}

interface ProjectsIndexProps {
  projects: readonly Project[];
  onSelectProject: (id: string) => void;
  now: number;
}

function ProjectsIndex({ projects, onSelectProject, now }: ProjectsIndexProps) {
  const [showUnassigned, setShowUnassigned] = useState(true);

  const sorted = useMemo(() => {
    return [...projects].sort((a, b) => {
      // Real projects first; UNASSIGNED last.
      const aU = isUnassignedProject(a);
      const bU = isUnassignedProject(b);
      if (aU !== bU) return aU ? 1 : -1;
      // Within real projects: most-recent activity first.
      return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    });
  }, [projects]);

  const filtered = useMemo(
    () => sorted.filter((p) => showUnassigned || !isUnassignedProject(p)),
    [sorted, showUnassigned],
  );

  return (
    <div className="lcars-projects-index">
      <header className="lcars-projects-index__header">
        <h2 className="lcars-projects-index__title">PROJECTS</h2>
        <label className="lcars-projects-index__toggle">
          <input
            type="checkbox"
            checked={showUnassigned}
            onChange={(e) => setShowUnassigned(e.target.checked)}
          />
          <span>show [UNASSIGNED]</span>
        </label>
      </header>
      <ul className="lcars-projects-index__list" role="list">
        {filtered.map((p) => {
          const sessionCount = p.sessionIds.length;
          const narrativeCount = p.narrativeIds.length;
          const isUnassigned = isUnassignedProject(p);
          return (
            <li key={p.id} role="listitem">
              <div
                role="button"
                tabIndex={0}
                className={`lcars-projects-index__row${isUnassigned ? ' lcars-projects-index__row--unassigned' : ''}`}
                aria-label={`open project ${p.displayName}`}
                onClick={() => onSelectProject(p.id)}
                onKeyDown={(e) => onActivate(e, () => onSelectProject(p.id))}
              >
                <div className="lcars-projects-index__row-main">
                  <span className="lcars-projects-index__row-name">{p.displayName}</span>
                  <span
                    className={`lcars-projects-index__sentiment ${SENTIMENT_CLASS[p.sentiment]}`}
                    aria-label={`sentiment ${SENTIMENT_LABEL[p.sentiment]}`}
                  >
                    {SENTIMENT_LABEL[p.sentiment]}
                  </span>
                </div>
                <div className="lcars-projects-index__row-meta">
                  <span title="sessions in this project">
                    {sessionCount} session{sessionCount === 1 ? '' : 's'}
                  </span>
                  {!isUnassigned && (
                    <span title="narratives discovered for this project">
                      {narrativeCount} narrative{narrativeCount === 1 ? '' : 's'}
                    </span>
                  )}
                  <span title="last activity in this project">
                    last {lastActivityRelative(p.lastActivityAt, now)}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface ProjectDetailProps {
  project: Project;
  narratives: readonly Narrative[];
  topicNameById: ReadonlyMap<string, string>;
  sessionById: ReadonlyMap<string, UnifiedSessionEntry>;
  onBack: () => void;
  onSelectSession: (id: string) => void;
  now: number;
  dataDirBaseUrl: string;
}

/**
 * Per-narrative state surfaced via the audit affordance (Rev3-D D3).
 * `dismissalCount` defaults to 0 for any narrative the user hasn't
 * dismissed; `state` defaults to PENDING. Snapshotted `sizeAtState`
 * is the evidence count at the moment of dismissal — the live
 * `narrative.evidence.length` is compared against
 * `sizeAtState × narrativeSaturation(dismissalCount).multiplier` to
 * decide whether re-promotion is unlocked.
 */
interface NarrativeAuditState {
  readonly state: EntityStateValue;
  readonly sizeAtState: number;
  readonly dismissalCount: number;
}

function ProjectDetail({
  project,
  narratives,
  topicNameById,
  sessionById,
  onBack,
  onSelectSession,
  now,
  dataDirBaseUrl,
}: ProjectDetailProps) {
  const projectSessions = useMemo(() => {
    const list: UnifiedSessionEntry[] = [];
    for (const sid of project.sessionIds) {
      const s = sessionById.get(sid);
      if (s) list.push(s);
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }, [project.sessionIds, sessionById]);

  // Rev3-D D3 — load per-narrative entity-states for the audit
  // affordance. PENDING is the implicit default for any narrative not
  // in the ledger. Mirrors the InsightsMode knowledge-debt pattern
  // (PR #70, generalized to narratives in C1+C2).
  const [narrativeStates, setNarrativeStates] = useState<
    ReadonlyMap<string, NarrativeAuditState>
  >(new Map());
  useEffect(() => {
    let cancelled = false;
    void loadEntityStates(dataDirBaseUrl).then((file) => {
      if (cancelled || file === null) return;
      const m = new Map<string, NarrativeAuditState>();
      for (const e of file.entries) {
        if (e.entityKind !== 'narrative') continue;
        m.set(e.entityId, {
          state: e.state,
          sizeAtState: e.sizeAtState,
          dismissalCount: e.dismissalCount ?? 0,
        });
      }
      setNarrativeStates(m);
    });
    return () => {
      cancelled = true;
    };
  }, [dataDirBaseUrl]);

  const onNarrativeStateChange = (
    narrativeId: string,
    state: EntityStateValue,
    currentSize: number,
  ): void => {
    void setEntityState('narrative', narrativeId, state, currentSize).then(
      (r) => {
        if (!r.ok) return;
        setNarrativeStates((prev) => {
          const next = new Map(prev);
          // Prefer the server-returned canonical row when present
          // (C4 SDK is authoritative — its `upsertEntityState` runs
          // the read-old + compute-counter + write sequence inside a
          // single BEGIN IMMEDIATE, so its `dismissalCount` reflects
          // any prior state we may not have known about, e.g. a sibling
          // tab dismissed first or the legacy migrator seeded a count).
          // Fall back to local approximation only if the response
          // didn't carry `entry` (older server, partial deploy).
          if (r.entry !== undefined) {
            next.set(narrativeId, {
              state: r.entry.state,
              sizeAtState: r.entry.sizeAtState,
              dismissalCount: r.entry.dismissalCount ?? 0,
            });
            return next;
          }
          const prior = prev.get(narrativeId);
          const wasDismissed = prior?.state === 'DISMISSED';
          const becomeDismissed = state === 'DISMISSED';
          const dismissalCount =
            (prior?.dismissalCount ?? 0) +
            (becomeDismissed && !wasDismissed ? 1 : 0);
          next.set(narrativeId, {
            state,
            sizeAtState: currentSize,
            dismissalCount,
          });
          return next;
        });
      },
    );
  };

  // Rev3-D D4 — show-shelved toggle state. Default OFF so high-
  // friction narratives don't keep nag-rendering across reloads; the
  // toggle is transient (no localStorage) so an explicit reveal is
  // bounded to the current session.
  const [showShelved, setShowShelved] = useState(false);

  // Partition narratives into active (default rendering) vs shelved
  // (hidden unless the toggle is on). Uses the saturation kernel as
  // the single source of truth — never inline the cap comparison.
  const { visibleNarratives, shelvedNarrativeIds } = useMemo(() => {
    const shelvedIds = new Set<string>();
    const visible: Narrative[] = [];
    for (const n of narratives) {
      const state = narrativeStates.get(n.id);
      const sat = narrativeSaturation(state?.dismissalCount ?? 0);
      if (sat.shelved) {
        shelvedIds.add(n.id);
        if (showShelved) visible.push(n);
      } else {
        visible.push(n);
      }
    }
    return { visibleNarratives: visible, shelvedNarrativeIds: shelvedIds };
  }, [narratives, narrativeStates, showShelved]);

  return (
    <div className="lcars-project-detail" id={`project-${project.id}`}>
      {/*
        Sticky single-scroll layout (spec §5.1): narratives at top,
        sessions below. The back chip + heading hold position with a
        sticky-top so the user always knows which project they're in
        even when scrolled deep into the session list.
      */}
      <header className="lcars-project-detail__header">
        <button
          type="button"
          className="lcars-project-detail__back"
          aria-label="back to projects index"
          onClick={onBack}
        >
          ← PROJECTS
        </button>
        <h2 className="lcars-project-detail__title">{project.displayName}</h2>
        <span
          className={`lcars-projects-index__sentiment ${SENTIMENT_CLASS[project.sentiment]}`}
          aria-label={`sentiment ${SENTIMENT_LABEL[project.sentiment]}`}
        >
          {SENTIMENT_LABEL[project.sentiment]}
        </span>
      </header>
      {project.topicIds.length > 0 && (
        <div className="lcars-project-detail__topics" role="list" aria-label="project topics">
          {project.topicIds.map((tid) => (
            <span
              key={tid}
              role="listitem"
              className="lcars-chip lcars-chip--topic"
              title={`topic: ${topicNameById.get(tid) ?? tid}`}
            >
              # {topicNameById.get(tid) ?? tid}
            </span>
          ))}
        </div>
      )}

      <section
        className="lcars-project-detail__narratives"
        aria-label="discovered narratives"
      >
        <div className="lcars-project-detail__narratives-header">
          <h3 className="lcars-project-detail__section-title">NARRATIVES</h3>
          {/*
            Rev3-D D4 — show-shelved toggle. Narratives whose
            `dismissalCount >= maxDismissals` (see narrativeSaturation)
            are hidden from the active pile by default; flipping the
            toggle reveals them so the user can audit or re-promote.
            Transient session-state (no localStorage) — the safe
            default is "shelved hidden" so a high-friction narrative
            doesn't keep reappearing across reloads.
          */}
          {shelvedNarrativeIds.size > 0 && (
            <label
              className="lcars-project-detail__shelved-toggle"
              aria-label={
                showShelved
                  ? `hide ${shelvedNarrativeIds.size} shelved narratives`
                  : `show ${shelvedNarrativeIds.size} shelved narratives`
              }
            >
              <input
                type="checkbox"
                checked={showShelved}
                onChange={(e) => setShowShelved(e.target.checked)}
              />
              <span>
                show shelved ({shelvedNarrativeIds.size})
              </span>
            </label>
          )}
        </div>
        {visibleNarratives.length === 0 ? (
          <p className="lcars-project-detail__empty-narratives">
            {narratives.length === 0
              ? 'No narratives for this project yet — narratives only emerge once a project has multiple same-sentiment sessions.'
              : `All ${narratives.length} narrative${narratives.length === 1 ? ' is' : 's are'} shelved. Toggle "show shelved" to audit.`}
          </p>
        ) : (
          <ul className="lcars-project-detail__narrative-list" role="list">
            {visibleNarratives.map((n) => (
              <li key={n.id} role="listitem">
                <NarrativeCard
                  narrative={n}
                  sessionById={sessionById}
                  auditState={narrativeStates.get(n.id) ?? null}
                  onStateChange={onNarrativeStateChange}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="lcars-project-detail__sessions"
        aria-label="sessions in this project"
      >
        <h3 className="lcars-project-detail__section-title">
          SESSIONS ({projectSessions.length})
        </h3>
        <div className="lcars-project-detail__session-grid" role="list">
          {projectSessions.map((s) => (
            <div role="listitem" key={`${s.source}:${s.id}`}>
              <SessionCard session={s} onSelect={onSelectSession} now={now} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface NarrativeCardProps {
  narrative: Narrative;
  sessionById: ReadonlyMap<string, UnifiedSessionEntry>;
  /**
   * Rev3-D D3 — current dismissal-ledger entry for this narrative.
   * `null` = the user has not dismissed it yet (effective state is
   * PENDING). The component renders the audit affordance regardless
   * so the user can see "Not dismissed (0/cap)" + a DISMISS button
   * even before the first dismissal.
   */
  auditState: NarrativeAuditState | null;
  onStateChange: (
    narrativeId: string,
    state: EntityStateValue,
    currentSize: number,
  ) => void;
}

function NarrativeCard({
  narrative,
  sessionById,
  auditState,
  onStateChange,
}: NarrativeCardProps) {
  const isPositive = narrative.sentiment === 'positive';
  const accent = isPositive ? 'positive' : 'negative';

  // v2 spec §3 / D11-D12: actions are local-tier only — probe the
  // three /api endpoints once to decide whether to render the button
  // enabled or as disabled-with-explanation.
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    probeNarrativeActionsAvailable().then((v) => {
      if (!cancelled) setAvailable(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [actionPhase, setActionPhase] = useState<'idle' | 'running' | 'ok' | 'error'>('idle');
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  // Rev3-E E3 — explicit falsifier-skip override for the
  // encode-as-pattern flow. Default OFF — the safe path is to let the
  // future Rev3-F falsifier verify the claim before the pattern surfaces
  // as load-bearing. Checking the box records the bypass as
  // `falsifierStatus: 'skipped-by-user'` in the persisted Pattern so
  // the audit table can tell why this pattern lacks verification.
  const [falsifierOverride, setFalsifierOverride] = useState(false);

  const isAvailable = available !== false; // null (unknown) optimistically allows
  const actionDisabled = actionPhase === 'running' || available === false;

  const handlePositive = async (): Promise<void> => {
    setActionPhase('running');
    setActionMessage(null);
    try {
      const pattern = buildPatternFromNarrative(narrative, false, {
        falsifierOverride,
      });
      const result = await encodePattern(pattern);
      setActionPhase('ok');
      setActionMessage(
        falsifierOverride
          ? `Saved pattern (${result.patternsCount} total) to ${result.sidecarPath} — falsifier skipped per override.`
          : `Saved pattern (${result.patternsCount} total) to ${result.sidecarPath}.`,
      );
    } catch (err) {
      setActionPhase('error');
      setActionMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNegative = async (): Promise<void> => {
    setActionPhase('running');
    setActionMessage(null);
    try {
      const ground = await fetchRepoGround();
      const body = buildCorrectivePromptBody(narrative, ground);
      const path = await savePrompt(narrative.id, body);
      let clipboardOk = true;
      try {
        await copyToClipboard(body);
      } catch {
        clipboardOk = false;
      }
      setActionPhase('ok');
      setActionMessage(
        `Saved prompt to ${path}.${clipboardOk ? ' Copied to clipboard.' : ' Clipboard copy failed — open the file to copy manually.'}`,
      );
    } catch (err) {
      setActionPhase('error');
      setActionMessage(err instanceof Error ? err.message : String(err));
    }
  };

  // Build a small ARIA hint string for the disabled-with-explanation
  // state per spec §3. Browser-tier deploys get the same copy used
  // by the SCAN LOCAL chip's tooltip.
  const disabledHint =
    available === false
      ? 'Available when running locally — install chat-arch (see README quickstart) and reload.'
      : undefined;

  return (
    <article
      className={`lcars-narrative-card lcars-narrative-card--${accent}`}
      aria-label={`${narrative.sentiment} narrative: ${narrative.title}`}
    >
      <header className="lcars-narrative-card__header">
        <span
          className={`lcars-narrative-card__sentiment lcars-narrative-card__sentiment--${accent}`}
        >
          {narrative.sentiment.toUpperCase()}
        </span>
        <h4 className="lcars-narrative-card__title">{narrative.title}</h4>
      </header>
      {narrative.body && (
        <p className="lcars-narrative-card__body">{narrative.body}</p>
      )}
      {narrative.evidence.length > 0 && (
        <ul className="lcars-narrative-card__evidence" role="list" aria-label="evidence sessions">
          {narrative.evidence.map((e, ix) => {
            const s = sessionById.get(e.sessionId);
            const label = s?.title || e.sessionId;
            return (
              <li key={`${e.sessionId}-${ix}`}>
                <a
                  className="lcars-narrative-card__evidence-pill"
                  href={`#session/${e.sessionId}`}
                  title={label}
                >
                  ▸ {label}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="lcars-narrative-card__footer">
        {actionMessage && (
          <p
            className={`lcars-narrative-card__status lcars-narrative-card__status--${actionPhase}`}
            role={actionPhase === 'error' ? 'alert' : 'status'}
          >
            {actionMessage}
          </p>
        )}
        <NarrativeAudit
          narrative={narrative}
          auditState={auditState}
          onStateChange={onStateChange}
        />
        {isPositive && (
          // Rev3-E E3 — explicit override for the future falsifier
          // check. Only renders for positive narratives (the
          // encode-as-pattern path). The negative path goes to
          // GENERATE CORRECTIVE PROMPT which doesn't produce a
          // Pattern row, so the override doesn't apply.
          <label className="lcars-narrative-card__falsifier-skip">
            <input
              type="checkbox"
              checked={falsifierOverride}
              onChange={(e) => setFalsifierOverride(e.target.checked)}
              disabled={actionDisabled}
              aria-label="skip falsifier verification when encoding"
            />
            <span>skip falsifier (record as skipped-by-user)</span>
          </label>
        )}
        <button
          type="button"
          className="lcars-narrative-card__action"
          aria-label={
            isPositive
              ? 'encode this narrative as a pattern'
              : 'generate a corrective prompt from this narrative'
          }
          {...(disabledHint ? { title: disabledHint } : {})}
          aria-disabled={actionDisabled || !isAvailable}
          disabled={actionDisabled}
          onClick={isPositive ? handlePositive : handleNegative}
        >
          {actionPhase === 'running'
            ? isPositive
              ? 'ENCODING…'
              : 'GENERATING…'
            : actionPhase === 'ok'
              ? isPositive
                ? 'ENCODED ✓'
                : 'PROMPT SAVED ✓'
              : isPositive
                ? 'ENCODE AS PATTERN'
                : 'GENERATE CORRECTIVE PROMPT'}
        </button>
      </footer>
    </article>
  );
}

interface NarrativeAuditProps {
  narrative: Narrative;
  auditState: NarrativeAuditState | null;
  onStateChange: (
    narrativeId: string,
    state: EntityStateValue,
    currentSize: number,
  ) => void;
}

/**
 * Rev3-D D3 — per-narrative audit row. Surfaces the Closure-B
 * dismissal counter + the effective re-promotion bar so the user can
 * see (a) how many times they've shelved this narrative, (b) what
 * evidence-count it would have to grow to before re-emerging, and
 * (c) a DISMISS button for the next dismissal.
 *
 * The displayed re-promotion bar is derived from `narrativeSaturation`
 * (Rev3-D D1) — never inline `pow(decay, count)` here. The shelved
 * regime (dismissalCount ≥ maxDismissals) shows the cap reached + no
 * DISMISS button; D4 will add the "show shelved" toggle that filters
 * the card from the list entirely.
 */
function NarrativeAudit({
  narrative,
  auditState,
  onStateChange,
}: NarrativeAuditProps) {
  const dismissalCount = auditState?.dismissalCount ?? 0;
  const saturation = narrativeSaturation(dismissalCount);
  const currentSize = narrative.evidence.length;
  const state: EntityStateValue = auditState?.state ?? 'PENDING';
  const sizeAtState = auditState?.sizeAtState ?? 0;
  const repromotionThreshold = saturation.multiplier !== null && sizeAtState > 0
    ? sizeAtState * saturation.multiplier
    : null;

  const handleDismiss = (): void => {
    onStateChange(narrative.id, 'DISMISSED', currentSize);
  };

  return (
    <div
      className="lcars-narrative-card__audit"
      // Wrapper omits aria-label so the screen reader doesn't announce
      // dismissal counts three times (wrapper → visible counts text →
      // button label). The "AUDIT" sentinel chip gives spoken context
      // via plain text instead.
      role="group"
    >
      <span className="lcars-narrative-card__audit-label">AUDIT</span>
      <span className="lcars-narrative-card__audit-counts">
        {saturation.dismissalsConsumed}/{saturation.cap} dismissals
      </span>
      {state === 'DISMISSED' && repromotionThreshold !== null && (
        <span className="lcars-narrative-card__audit-threshold">
          re-emerges at ≥{Math.ceil(repromotionThreshold)} evidence
          {' '}(now: {currentSize})
        </span>
      )}
      {saturation.shelved && (
        <span
          className="lcars-narrative-card__audit-shelved"
          role="note"
          aria-label="shelved permanently"
        >
          SHELVED
        </span>
      )}
      {!saturation.shelved && state !== 'DISMISSED' && (
        <button
          type="button"
          className="lcars-narrative-card__audit-dismiss"
          aria-label={`dismiss this narrative (dismissal ${saturation.dismissalsConsumed + 1} of ${saturation.cap})`}
          onClick={handleDismiss}
        >
          DISMISS
        </button>
      )}
    </div>
  );
}
