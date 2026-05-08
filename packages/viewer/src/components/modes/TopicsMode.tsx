import { useMemo, useState } from 'react';
import type { UnifiedSessionEntry, Topic, Project } from '@chat-arch/schema';
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
 */

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

export function TopicsMode({
  topics,
  projects,
  sessions,
  selectedTopicId,
  onSelectTopic,
  onSelectSession,
  onSelectProject,
}: TopicsModeProps) {
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

  return <TopicsIndex topics={topics} onSelectTopic={onSelectTopic} />;
}

interface TopicsIndexProps {
  topics: readonly Topic[];
  onSelectTopic: (id: string) => void;
}

function TopicsIndex({ topics, onSelectTopic }: TopicsIndexProps) {
  const [filter, setFilter] = useState('');
  const sorted = useMemo(() => {
    return [...topics].sort((a, b) => b.sessionIds.length - a.sessionIds.length);
  }, [topics]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((t) => t.displayName.toLowerCase().includes(q));
  }, [sorted, filter]);

  return (
    <div className="lcars-topics-index">
      <header className="lcars-topics-index__header">
        <h2 className="lcars-topics-index__title">TOPICS</h2>
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
              aria-label={`open topic ${t.displayName}`}
              onClick={() => onSelectTopic(t.id)}
              onKeyDown={(e) => onActivate(e, () => onSelectTopic(t.id))}
            >
              <span className="lcars-topics-index__row-name"># {t.displayName}</span>
              <span className="lcars-topics-index__row-meta">
                <span title="sessions tagged with this topic">
                  {t.sessionIds.length} session{t.sessionIds.length === 1 ? '' : 's'}
                </span>
                <span title="distinct projects this topic crosses">
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
  const sessionsForTopic = useMemo(() => {
    const list: UnifiedSessionEntry[] = [];
    for (const sid of topic.sessionIds) {
      const s = sessionById.get(sid);
      if (s) list.push(s);
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }, [topic.sessionIds, sessionById]);

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
          aria-label="back to topics index"
          onClick={onBack}
        >
          ← TOPICS
        </button>
        <h2 className="lcars-topic-detail__title"># {topic.displayName}</h2>
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
