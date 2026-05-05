import { useEffect, useMemo, useState } from 'react';
import type {
  UnifiedSessionEntry,
  Project,
  Topic,
  Narrative,
  ProjectSentiment,
} from '@chat-arch/schema';
import { isUnassignedProject } from '@chat-arch/schema';
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
}

function ProjectDetail({
  project,
  narratives,
  topicNameById,
  sessionById,
  onBack,
  onSelectSession,
  now,
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
        <h3 className="lcars-project-detail__section-title">NARRATIVES</h3>
        {narratives.length === 0 ? (
          <p className="lcars-project-detail__empty-narratives">
            No narratives for this project yet — narratives only emerge once a project has
            multiple same-sentiment sessions.
          </p>
        ) : (
          <ul className="lcars-project-detail__narrative-list" role="list">
            {narratives.map((n) => (
              <li key={n.id} role="listitem">
                <NarrativeCard narrative={n} sessionById={sessionById} />
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
}

function NarrativeCard({ narrative, sessionById }: NarrativeCardProps) {
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

  const isAvailable = available !== false; // null (unknown) optimistically allows
  const actionDisabled = actionPhase === 'running' || available === false;

  const handlePositive = async (): Promise<void> => {
    setActionPhase('running');
    setActionMessage(null);
    try {
      const pattern = buildPatternFromNarrative(narrative, false);
      const result = await encodePattern(pattern);
      setActionPhase('ok');
      setActionMessage(
        `Saved pattern (${result.patternsCount} total) to ${result.sidecarPath}.`,
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
      ? 'Available when running locally. Clone the repo and run `pnpm --filter @chat-arch/standalone dev`, then reload.'
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
      {narrative.body && <p className="lcars-narrative-card__body">{narrative.body}</p>}
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
                  title={e.excerpt ?? label}
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
