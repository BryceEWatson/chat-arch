// Junction-table SDK — the four many-to-many link tables:
//
//   - project_sessions   (project ↔ session)
//   - project_topics     (project ↔ topic)
//   - topic_sessions     (topic ↔ session)
//   - narrative_sessions (narrative ↔ session, distinct from
//                         narrative_evidence which carries excerpt prose)
//
// Each follows the same shape: `linkX()` and `unlinkX()`. INSERT OR
// IGNORE makes link idempotent; the unique-violation path never fires
// for callers re-running an idempotent backfill.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';
import type {
  NarrativeSessionLink,
  ProjectSessionLink,
  ProjectTopicLink,
  SessionKey,
  TopicSessionLink,
} from './types.js';

export async function linkProjectSession(
  db: Database,
  projectId: string,
  session: SessionKey,
): Promise<void> {
  await withWriteTransaction(db, (tx) => {
    tx.prepare(
      `INSERT OR IGNORE INTO project_sessions (project_id, session_source, session_id) VALUES (?, ?, ?)`,
    ).run(projectId, session.source, session.id);
  });
}

export async function unlinkProjectSession(
  db: Database,
  projectId: string,
  session: SessionKey,
): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(
        `DELETE FROM project_sessions WHERE project_id = ? AND session_source = ? AND session_id = ?`,
      )
      .run(projectId, session.source, session.id);
    return info.changes > 0;
  });
}

export function listProjectSessions(
  db: Database,
  projectId: string,
): readonly ProjectSessionLink[] {
  return db
    .prepare<
      [string],
      { readonly project_id: string; readonly session_source: string; readonly session_id: string }
    >(
      `SELECT project_id, session_source, session_id FROM project_sessions WHERE project_id = ? ORDER BY session_source, session_id`,
    )
    .all(projectId)
    .map((row) => ({
      projectId: row.project_id,
      sessionSource: row.session_source,
      sessionId: row.session_id,
    }));
}

export async function linkProjectTopic(
  db: Database,
  projectId: string,
  topicId: string,
): Promise<void> {
  await withWriteTransaction(db, (tx) => {
    tx.prepare(
      `INSERT OR IGNORE INTO project_topics (project_id, topic_id) VALUES (?, ?)`,
    ).run(projectId, topicId);
  });
}

export async function unlinkProjectTopic(
  db: Database,
  projectId: string,
  topicId: string,
): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(`DELETE FROM project_topics WHERE project_id = ? AND topic_id = ?`)
      .run(projectId, topicId);
    return info.changes > 0;
  });
}

export function listProjectTopics(
  db: Database,
  projectId: string,
): readonly ProjectTopicLink[] {
  return db
    .prepare<[string], { readonly project_id: string; readonly topic_id: string }>(
      `SELECT project_id, topic_id FROM project_topics WHERE project_id = ? ORDER BY topic_id`,
    )
    .all(projectId)
    .map((row) => ({ projectId: row.project_id, topicId: row.topic_id }));
}

export async function linkTopicSession(
  db: Database,
  topicId: string,
  session: SessionKey,
): Promise<void> {
  await withWriteTransaction(db, (tx) => {
    tx.prepare(
      `INSERT OR IGNORE INTO topic_sessions (topic_id, session_source, session_id) VALUES (?, ?, ?)`,
    ).run(topicId, session.source, session.id);
  });
}

export async function unlinkTopicSession(
  db: Database,
  topicId: string,
  session: SessionKey,
): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(
        `DELETE FROM topic_sessions WHERE topic_id = ? AND session_source = ? AND session_id = ?`,
      )
      .run(topicId, session.source, session.id);
    return info.changes > 0;
  });
}

export function listTopicSessions(
  db: Database,
  topicId: string,
): readonly TopicSessionLink[] {
  return db
    .prepare<
      [string],
      { readonly topic_id: string; readonly session_source: string; readonly session_id: string }
    >(
      `SELECT topic_id, session_source, session_id FROM topic_sessions WHERE topic_id = ? ORDER BY session_source, session_id`,
    )
    .all(topicId)
    .map((row) => ({
      topicId: row.topic_id,
      sessionSource: row.session_source,
      sessionId: row.session_id,
    }));
}

export async function linkNarrativeSession(
  db: Database,
  narrativeId: string,
  session: SessionKey,
): Promise<void> {
  await withWriteTransaction(db, (tx) => {
    tx.prepare(
      `INSERT OR IGNORE INTO narrative_sessions (narrative_id, session_source, session_id) VALUES (?, ?, ?)`,
    ).run(narrativeId, session.source, session.id);
  });
}

export async function unlinkNarrativeSession(
  db: Database,
  narrativeId: string,
  session: SessionKey,
): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(
        `DELETE FROM narrative_sessions WHERE narrative_id = ? AND session_source = ? AND session_id = ?`,
      )
      .run(narrativeId, session.source, session.id);
    return info.changes > 0;
  });
}

export function listNarrativeSessions(
  db: Database,
  narrativeId: string,
): readonly NarrativeSessionLink[] {
  return db
    .prepare<
      [string],
      { readonly narrative_id: string; readonly session_source: string; readonly session_id: string }
    >(
      `SELECT narrative_id, session_source, session_id FROM narrative_sessions WHERE narrative_id = ? ORDER BY session_source, session_id`,
    )
    .all(narrativeId)
    .map((row) => ({
      narrativeId: row.narrative_id,
      sessionSource: row.session_source,
      sessionId: row.session_id,
    }));
}
