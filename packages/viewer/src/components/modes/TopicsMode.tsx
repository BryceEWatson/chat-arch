import { useEffect, useMemo, useState } from 'react';
import type { UnifiedSessionEntry, Topic, Project } from '@chat-arch/schema';
import {
  rankTopicsBySessionCount,
  sortSessionsByRecency,
} from '@chat-arch/analysis';
import { EmptyState } from '../EmptyState.js';
import { onActivate } from '../../util/a11y.js';
import { SessionCard } from '../SessionCard.js';

/**
 * v2 spec §5.2: TOPICS surface — index + detail in one component.
 * Index lists discovered topics with session count + per-topic project
 * count. Detail is a side panel rendering the topic's session list,
 * cross-linked to projects via project chips on each card.
 *
 * Topics are universal labels (spec §4.2) — they apply to sessions
 * regardless of project assignment, including those parked under
 * `[UNASSIGNED]`.
 *
 * Phase 3 opt-in gate: the TOPICS surface is deferred behind an
 * explicit user click because the broader topic-clustering feature
 * downloads a 36 MB embedding model from Hugging Face on first use.
 * Until the user opts in (persisted under `chat-arch:topics-opt-in`),
 * this component renders an opt-in placeholder describing the trade
 * instead of the topic index. The placeholder takes the user's click
 * to flip the storage flag and re-render the populated mode.
 */

/** localStorage key for the opt-in. `=== 'true'` means opted in. */
const TOPICS_OPT_IN_KEY = 'chat-arch:topics-opt-in';

/**
 * Read the opt-in from localStorage with SSR + private-mode safety.
 * Defaults to `false` whenever storage is unavailable so we never
 * accidentally trigger the embedding download in a degraded environment.
 */
function readTopicsOptIn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(TOPICS_OPT_IN_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeTopicsOptIn(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.localStorage.setItem(TOPICS_OPT_IN_KEY, 'true');
    } else {
      window.localStorage.removeItem(TOPICS_OPT_IN_KEY);
    }
  } catch {
    // Private mode / policy-locked storage — opt-in is session-only.
  }
}

export interface TopicsModeProps {
  topics: readonly Topic[];
  projects: readonly Project[];
  sessions: readonly UnifiedSessionEntry[];
  selectedTopicId: string | null;
  onSelectTopic: (id: string | null) => void;
  onSelectSession: (id: string) => void;
  /** Forwarded to the SESSIONS-grid sidebar so /topics deep-links can pick a project to filter by. */
  onSelectProject?: (id: string) => void;
}

interface TopicsOptInGateProps {
  onEnable: () => void;
}

/**
 * Disclosure card shown when the user has not yet opted in. The body
 * copy is verbatim from the Phase 3 spec — it names the model size,
 * the source, and the privacy posture so the user can decide before
 * the download starts.
 */
function TopicsOptInGate({ onEnable }: TopicsOptInGateProps) {
  return (
    <div
      className="lcars-topics-opt-in"
      role="region"
      aria-labelledby="lcars-topics-opt-in-h"
    >
      <h2 id="lcars-topics-opt-in-h" className="lcars-topics-opt-in__title">ENABLE TOPIC CLUSTERING</h2>
      <p className="lcars-topics-opt-in__body">
        Computes topic clusters using a 36MB embedding model downloaded one time from Hugging
        Face. The download stays in your browser cache; nothing about your conversations is
        uploaded.
      </p>
      <button
        type="button"
        className="lcars-topics-opt-in__cta"
        onClick={onEnable}
      >
        ENABLE TOPICS
      </button>
    </div>
  );
}

export function TopicsMode({
  topics,
  projects,
  sessions,
  selectedTopicId,
  onSelectTopic,
  onSelectSession,
  onSelectProject,
}: TopicsModeProps) {
  // Hydrate the opt-in from localStorage. Initial state intentionally
  // mirrors `readTopicsOptIn()` so first paint already reflects the
  // stored choice — there's no flash of the gate for users who already
  // opted in. The effect below resyncs on mount in case storage
  // changed in another tab between renders.
  const [optedIn, setOptedIn] = useState<boolean>(() => readTopicsOptIn());
  useEffect(() => {
    setOptedIn(readTopicsOptIn());
  }, []);

  // All other hooks run unconditionally — React requires a stable hook
  // order across renders, so we cannot early-return above them. The
  // opt-in branch below is a render-time conditional, not a hook gate.
  const now = useMemo(() => Date.now(), []);

  const projectById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const sessionById = useMemo(() => {
    const m = new Map<string, UnifiedSessionEntry>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  if (!optedIn) {
    return (
      <TopicsOptInGate
        onEnable={() => {
          writeTopicsOptIn(true);
          setOptedIn(true);
        }}
      />
    );
  }

  const onDisable = () => {
    writeTopicsOptIn(false);
    setOptedIn(false);
    // Snap back to the index when the user revokes — leaving
    // `selectedTopicId` set would render "topic not found" against
    // the gate the next time they enable.
    onSelectTopic(null);
  };

  if (topics.length === 0) {
    return (
      <EmptyState
        title="NO TOPICS YET"
        message="No topics discovered in the active manifest. Run the analyzer or load a richer fixture to populate."
      />
    );
  }

  if (selectedTopicId) {
    const topic = topics.find((t) => t.id === selectedTopicId);
    if (!topic) {
      return (
        <EmptyState
          title="TOPIC NOT FOUND"
          message={`No topic with id ${selectedTopicId} in the active manifest.`}
        />
      );
    }
    return (
      <TopicDetail
        topic={topic}
        projectById={projectById}
        sessionById={sessionById}
        onBack={() => onSelectTopic(null)}
        onSelectSession={onSelectSession}
        {...(onSelectProject ? { onSelectProject } : {})}
        now={now}
      />
    );
  }

  return <TopicsIndex topics={topics} onSelectTopic={onSelectTopic} onDisable={onDisable} />;
}

interface TopicsIndexProps {
  topics: readonly Topic[];
  onSelectTopic: (id: string) => void;
  onDisable: () => void;
}

function TopicsIndex({ topics, onSelectTopic, onDisable }: TopicsIndexProps) {
  const [filter, setFilter] = useState('');
  // Ordering lives in the `rankTopicsBySessionCount` analysis selector
  // (Phase 3 of "Centralize data processing"); the search filter is
  // UI-coupled and stays local.
  const sorted = useMemo(() => rankTopicsBySessionCount(topics), [topics]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((t) => t.displayName.toLowerCase().includes(q));
  }, [sorted, filter]);

  return (
    <div className="lcars-topics-index">
      <header className="lcars-topics-index__header">
        <h2 className="lcars-topics-index__title">TOPICS</h2>
        {/* Iter-10 a11y: disable button moved OUT of the h2 (button-
            inside-heading reads as "TOPICS, disable..." on heading
            nav). Parens dropped (read as "left paren" on NVDA).
            title= was carrying load-bearing risk explanation mouse-
            only — inlined into an sr-only describedby. */}
        <button
          type="button"
          className="lcars-topics-index__disable"
          onClick={onDisable}
          aria-describedby="lcars-topics-disable-hint"
        >
          disable
        </button>
        <span id="lcars-topics-disable-hint" className="lcars-sr-only">
          Clears the local opt-in flag. Re-enabling triggers the embedding model download again.
        </span>
        <label className="lcars-topics-index__filter">
          <span className="lcars-topics-index__filter-label" aria-hidden="true">
            FILTER
          </span>
          <input
            className="lcars-topics-index__filter-input"
            type="search"
            placeholder="topic name…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="filter topics by name"
          />
        </label>
      </header>
      <ul className="lcars-topics-index__list" role="list">
        {filtered.map((t) => (
          <li key={t.id} role="listitem">
            <div
              role="button"
              tabIndex={0}
              className="lcars-topics-index__row"
              onClick={() => onSelectTopic(t.id)}
              onKeyDown={(e) => onActivate(e, () => onSelectTopic(t.id))}
            >
              <span className="lcars-sr-only">open topic </span>
              <span className="lcars-topics-index__row-name">
                <span aria-hidden="true"># </span>
                {t.displayName}
              </span>
              <span className="lcars-topics-index__row-meta">
                <span>
                  {t.sessionIds.length} session{t.sessionIds.length === 1 ? '' : 's'}
                </span>
                <span>
                  {t.projectIds.length} project{t.projectIds.length === 1 ? '' : 's'}
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TopicDetailProps {
  topic: Topic;
  projectById: ReadonlyMap<string, Project>;
  sessionById: ReadonlyMap<string, UnifiedSessionEntry>;
  onBack: () => void;
  onSelectSession: (id: string) => void;
  onSelectProject?: (id: string) => void;
  now: number;
}

function TopicDetail({
  topic,
  projectById,
  sessionById,
  onBack,
  onSelectSession,
  onSelectProject,
  now,
}: TopicDetailProps) {
  const sessionsForTopic = useMemo(
    () => sortSessionsByRecency(topic.sessionIds, sessionById),
    [topic.sessionIds, sessionById],
  );

  const projectsForTopic = useMemo(() => {
    return topic.projectIds
      .map((id) => projectById.get(id))
      .filter((p): p is Project => Boolean(p));
  }, [topic.projectIds, projectById]);

  return (
    <div className="lcars-topic-detail" id={`topic-${topic.id}`}>
      <header className="lcars-topic-detail__header">
        <button
          type="button"
          className="lcars-project-detail__back"
          aria-label="BACK to topics index"
          onClick={onBack}
        >
          <span aria-hidden="true">← </span>TOPICS
        </button>
        <h2 className="lcars-topic-detail__title">
          <span aria-hidden="true"># </span>
          {topic.displayName}
        </h2>
      </header>
      {projectsForTopic.length > 0 && (
        <section className="lcars-topic-detail__projects" aria-label="projects with this topic">
          <h3 className="lcars-project-detail__section-title">CROSSES PROJECTS</h3>
          <div className="lcars-topic-detail__project-chips">
            {projectsForTopic.map((p) => (
              <button
                key={p.id}
                type="button"
                className="lcars-chip lcars-chip--cross-project"
                title={`open project ${p.displayName}`}
                onClick={() => onSelectProject?.(p.id)}
                disabled={!onSelectProject}
              >
                ↳ {p.displayName}
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="lcars-topic-detail__sessions" aria-label="sessions tagged with this topic">
        <h3 className="lcars-project-detail__section-title">
          SESSIONS ({sessionsForTopic.length})
        </h3>
        <div className="lcars-project-detail__session-grid" role="list">
          {sessionsForTopic.map((s) => (
            <div role="listitem" key={`${s.source}:${s.id}`}>
              <SessionCard session={s} onSelect={onSelectSession} now={now} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
