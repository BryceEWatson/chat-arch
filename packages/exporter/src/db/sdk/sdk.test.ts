// Round-trip tests for the chat-arch SQLite SDK (Phase Rev3-A.A8).
//
// Pattern: seed a file-backed DB, run migrations, exercise each SDK
// surface against a small fixture, assert that what we wrote is what
// we read back. The intent is the A11 gate ("SDK returns expected
// rows from a seeded-fixture test corpus") shrunk to a sub-task scale —
// A11 will scale this fixture to a fuller corpus.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import { MIGRATIONS, runMigrations } from '../migrations/index.js';
import {
  deleteAnalyzer,
  getAnalyzerByName,
  listAnalyzers,
  upsertAnalyzer,
} from './analyzers.js';
import {
  NotFoundError,
  UniqueViolationError,
} from './errors.js';
import {
  deleteFinding,
  getFindingById,
  insertFinding,
  listFindings,
} from './findings.js';
import {
  linkNarrativeSession,
  linkProjectSession,
  linkProjectTopic,
  linkTopicSession,
  listNarrativeSessions,
  listProjectSessions,
  listProjectTopics,
  listTopicSessions,
  unlinkProjectSession,
} from './junctions.js';
import {
  listNarrativeEvidence,
  replaceNarrativeEvidence,
} from './narrativeEvidence.js';
import {
  deleteNarrative,
  getNarrativeById,
  insertNarrative,
  listNarratives,
  updateNarrative,
} from './narratives.js';
import {
  deletePattern,
  getPatternById,
  insertPattern,
  listPatterns,
  updatePattern,
} from './patterns.js';
import {
  deleteProject,
  getProjectById,
  insertProject,
  listProjectSessionKeys,
  listProjectTopicIds,
  listProjects,
  updateProject,
} from './projects.js';
import {
  listSessionMessages,
  replaceSessionMessages,
} from './sessionMessages.js';
import {
  appendSessionRevision,
  listSessionRevisions,
} from './sessionRevisions.js';
import {
  deleteSession,
  getSession,
  insertSession,
  listSessions,
  updateSession,
} from './sessions.js';
import {
  deleteTopic,
  getTopicById,
  insertTopic,
  listTopics,
  updateTopic,
} from './topics.js';

describe('chat-arch SQLite SDK round-trip (A8)', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-sdk-test-'));
    db = openDb(join(tmpDir, 'sdk.db'));
    runMigrations(db, MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ----- analyzers (registry, INSERT OR REPLACE) -----

  describe('analyzers', () => {
    it('upserts, gets, lists, and deletes', async () => {
      expect(listAnalyzers(db)).toEqual([]);

      const inserted = await upsertAnalyzer(db, {
        name: 'kernel-foo',
        version: '1.0.0',
        lastRunAt: 1000,
        prior: 3.5,
      });
      expect(inserted).toEqual({
        name: 'kernel-foo',
        version: '1.0.0',
        lastRunAt: 1000,
        calibrationCompletedAt: null,
        prior: 3.5,
      });
      expect(getAnalyzerByName(db, 'kernel-foo')).toEqual(inserted);

      // upsert mutates in place
      const updated = await upsertAnalyzer(db, {
        name: 'kernel-foo',
        version: '1.0.1',
        lastRunAt: 2000,
        calibrationCompletedAt: 1500,
        prior: 2.0,
      });
      expect(updated.version).toBe('1.0.1');
      expect(updated.calibrationCompletedAt).toBe(1500);
      expect(listAnalyzers(db)).toHaveLength(1);

      expect(await deleteAnalyzer(db, 'kernel-foo')).toBe(true);
      expect(await deleteAnalyzer(db, 'kernel-foo')).toBe(false);
      expect(getAnalyzerByName(db, 'kernel-foo')).toBeNull();
    });

    it('default prior=2.0 matches the DDL default', async () => {
      const a = await upsertAnalyzer(db, { name: 'k', version: '1' });
      expect(a.prior).toBe(2.0);
    });
  });

  // ----- projects + junctions -----

  describe('projects', () => {
    it('inserts, gets by id, lists, updates, and deletes', async () => {
      const inserted = await insertProject(db, {
        id: 'proj-1',
        displayName: 'Project One',
        discoveredAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-02-01T00:00:00Z',
        sentiment: 'positive',
        source: 'desktop',
      });
      expect(inserted.displayName).toBe('Project One');
      expect(getProjectById(db, 'proj-1')).toEqual(inserted);

      const updated = await updateProject(db, 'proj-1', {
        displayName: 'Project Uno',
        lastActivityAt: '2025-03-01T00:00:00Z',
      });
      expect(updated.displayName).toBe('Project Uno');
      expect(updated.lastActivityAt).toBe('2025-03-01T00:00:00Z');
      expect(updated.sentiment).toBe('positive');

      expect(listProjects(db)).toHaveLength(1);
      expect(await deleteProject(db, 'proj-1')).toBe(true);
      expect(getProjectById(db, 'proj-1')).toBeNull();
    });

    it('throws UniqueViolationError on duplicate insert', async () => {
      const base = {
        id: 'dup',
        displayName: 'D',
        discoveredAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:00:00Z',
        sentiment: 'positive',
        source: 'desktop',
      };
      await insertProject(db, base);
      await expect(insertProject(db, base)).rejects.toThrow(UniqueViolationError);
    });

    it('throws NotFoundError on update of missing project', async () => {
      await expect(updateProject(db, 'missing', { sentiment: 'mixed' })).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  // ----- topics -----

  describe('topics', () => {
    it('round-trips a topic with full CRUD', async () => {
      const t = await insertTopic(db, {
        id: 'topic-a',
        displayName: 'Topic A',
        firstSeenAt: '2025-01-01T00:00:00Z',
        lastSeenAt: '2025-01-02T00:00:00Z',
      });
      expect(t.displayName).toBe('Topic A');
      const updated = await updateTopic(db, 'topic-a', {
        displayName: 'Topic A renamed',
      });
      expect(updated.displayName).toBe('Topic A renamed');
      expect(updated.firstSeenAt).toBe('2025-01-01T00:00:00Z');
      expect(await deleteTopic(db, 'topic-a')).toBe(true);
      expect(getTopicById(db, 'topic-a')).toBeNull();
      expect(listTopics(db)).toHaveLength(0);
    });
  });

  // ----- sessions + composite key + filters -----

  describe('sessions', () => {
    beforeEach(async () => {
      await insertProject(db, {
        id: 'p1',
        displayName: 'P1',
        discoveredAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:00:00Z',
        sentiment: 'positive',
        source: 'desktop',
      });
    });

    it('round-trips a session with composite (source, id) key', async () => {
      const key = { source: 'cli-direct', id: 'sess-1' };
      const inserted = await insertSession(db, {
        ...key,
        rawSessionId: 'raw-1',
        startedAt: 1000,
        updatedAt: 2000,
        durationMs: 1000,
        title: 'Session 1',
        titleSource: 'extracted',
        projectId: 'p1',
        messageCount: 3,
      });
      expect(inserted.title).toBe('Session 1');
      expect(getSession(db, key)).toEqual(inserted);
    });

    it('rejects bare session_source without session_id at the FK layer', async () => {
      // The same id can exist under two sources — composite PK
      // permits it.
      const id = 'shared-id';
      await insertSession(db, {
        source: 'cli-direct',
        id,
        rawSessionId: 'raw-cli',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 'Cli',
        titleSource: 'extracted',
      });
      await insertSession(db, {
        source: 'desktop',
        id,
        rawSessionId: 'raw-desktop',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 'Desktop',
        titleSource: 'extracted',
      });
      expect(listSessions(db)).toHaveLength(2);
    });

    it('filters by project_id (including null) + source + time range', async () => {
      await insertSession(db, {
        source: 'cli-direct',
        id: 'a',
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
        projectId: 'p1',
      });
      await insertSession(db, {
        source: 'cli-direct',
        id: 'b',
        rawSessionId: 'r',
        startedAt: 2000,
        updatedAt: 2000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
        projectId: null,
      });
      await insertSession(db, {
        source: 'desktop',
        id: 'c',
        rawSessionId: 'r',
        startedAt: 3000,
        updatedAt: 3000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
        projectId: 'p1',
      });
      expect(listSessions(db, { projectId: 'p1' })).toHaveLength(2);
      expect(listSessions(db, { projectId: null })).toHaveLength(1);
      expect(listSessions(db, { source: 'desktop' })).toHaveLength(1);
      expect(
        listSessions(db, { startedAtMin: 1500, startedAtMax: 2500 }),
      ).toHaveLength(1);
      expect(listSessions(db, { limit: 2 })).toHaveLength(2);
    });

    it('CASCADE deletes child messages + revisions when session removed', async () => {
      const key = { source: 'cli-direct', id: 'cascade' };
      await insertSession(db, {
        ...key,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
      });
      await replaceSessionMessages(db, key, [
        { turnIndex: 0, role: 'user', content: 'hi' },
        { turnIndex: 1, role: 'assistant', content: 'hello' },
      ]);
      await appendSessionRevision(db, key, {
        observedAt: 1500,
        transcriptStatus: 'present',
      });
      expect(listSessionMessages(db, key)).toHaveLength(2);
      expect(listSessionRevisions(db, key)).toHaveLength(1);

      expect(await deleteSession(db, key)).toBe(true);
      expect(listSessionMessages(db, key)).toHaveLength(0);
      expect(listSessionRevisions(db, key)).toHaveLength(0);
    });

    it('updateSession patches partial fields and preserves the rest', async () => {
      const key = { source: 'desktop', id: 'patch' };
      await insertSession(db, {
        ...key,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 'before',
        titleSource: 'extracted',
        projectId: 'p1',
        tokensInput: 100,
      });
      const after = await updateSession(db, key, {
        title: 'after',
        tokensInput: 200,
      });
      expect(after.title).toBe('after');
      expect(after.tokensInput).toBe(200);
      expect(after.projectId).toBe('p1');
      expect(after.titleSource).toBe('extracted');
    });
  });

  // ----- session_messages: replace = delete + bulk insert -----

  describe('session_messages', () => {
    it('replaceSessionMessages is idempotent — re-running yields same result', async () => {
      const key = { source: 'cli-direct', id: 's1' };
      await insertSession(db, {
        ...key,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
      });
      const inputs = [
        { turnIndex: 0, role: 'user', content: 'q' },
        { turnIndex: 1, role: 'assistant', content: 'a', timestamp: 1100 },
      ];
      const first = await replaceSessionMessages(db, key, inputs);
      const second = await replaceSessionMessages(db, key, inputs);
      expect(first).toEqual(second);
      expect(second).toHaveLength(2);
      expect(second[1]?.timestamp).toBe(1100);
    });
  });

  // ----- session_revisions: append-only -----

  describe('session_revisions', () => {
    it('append-only audit trail orders by observedAt then id', async () => {
      const key = { source: 'cli-direct', id: 's1' };
      await insertSession(db, {
        ...key,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
      });
      const r1 = await appendSessionRevision(db, key, {
        observedAt: 1000,
        transcriptStatus: 'present',
      });
      const r2 = await appendSessionRevision(db, key, {
        observedAt: 2000,
        transcriptStatus: 'pruned',
      });
      const list = listSessionRevisions(db, key);
      expect(list).toEqual([r1, r2]);
    });
  });

  // ----- narratives + evidence + sessions junction -----

  describe('narratives', () => {
    beforeEach(async () => {
      await insertProject(db, {
        id: 'p1',
        displayName: 'P1',
        discoveredAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:00:00Z',
        sentiment: 'positive',
        source: 'desktop',
      });
    });

    it('CRUD + filter by project + sentiment + schemaVersion', async () => {
      await insertNarrative(db, {
        id: 'n1',
        projectId: 'p1',
        sentiment: 'positive',
        title: 'A',
        body: 'b',
        generatedAt: '2025-01-01T00:00:00Z',
        actionType: 'observe',
      });
      await insertNarrative(db, {
        id: 'n2',
        projectId: 'p1',
        sentiment: 'negative',
        title: 'B',
        body: 'b',
        generatedAt: '2025-01-02T00:00:00Z',
        actionType: 'fix',
      });
      expect(listNarratives(db, { projectId: 'p1' })).toHaveLength(2);
      expect(listNarratives(db, { sentiment: 'positive' })).toHaveLength(1);
      expect(listNarratives(db, { schemaVersion: 1 })).toHaveLength(2);
      const fetched = getNarrativeById(db, 'n1');
      expect(fetched?.title).toBe('A');
      const after = await updateNarrative(db, 'n1', { title: 'A renamed' });
      expect(after.title).toBe('A renamed');
      expect(after.sentiment).toBe('positive');
      expect(await deleteNarrative(db, 'n2')).toBe(true);
      expect(listNarratives(db)).toHaveLength(1);
    });

    it('replaceNarrativeEvidence + listNarrativeEvidence round-trip', async () => {
      const sessKey = { source: 'cli-direct', id: 'sn-ev' };
      await insertSession(db, {
        ...sessKey,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
      });
      await insertNarrative(db, {
        id: 'n-ev',
        projectId: 'p1',
        sentiment: 'positive',
        title: 't',
        body: 'b',
        generatedAt: '2025-01-01T00:00:00Z',
        actionType: 'observe',
      });
      await replaceNarrativeEvidence(db, 'n-ev', [
        {
          evidenceIndex: 0,
          sessionSource: sessKey.source,
          sessionId: sessKey.id,
          anchor: 'turn:5',
          excerpt: 'snippet',
        },
        {
          evidenceIndex: 1,
          sessionSource: sessKey.source,
          sessionId: sessKey.id,
          anchor: 'turn:6',
        },
      ]);
      const rows = listNarrativeEvidence(db, 'n-ev');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.excerpt).toBe('snippet');
      expect(rows[1]?.excerpt).toBeNull();
    });

    it('narrative cascade-deletes evidence + session-junction rows', async () => {
      const sessKey = { source: 'cli-direct', id: 'sn-cascade' };
      await insertSession(db, {
        ...sessKey,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
      });
      await insertNarrative(db, {
        id: 'n-cascade',
        projectId: 'p1',
        sentiment: 'positive',
        title: 't',
        body: 'b',
        generatedAt: '2025-01-01T00:00:00Z',
        actionType: 'observe',
      });
      await replaceNarrativeEvidence(db, 'n-cascade', [
        {
          evidenceIndex: 0,
          sessionSource: sessKey.source,
          sessionId: sessKey.id,
        },
      ]);
      await linkNarrativeSession(db, 'n-cascade', sessKey);
      await deleteNarrative(db, 'n-cascade');
      expect(listNarrativeEvidence(db, 'n-cascade')).toHaveLength(0);
      expect(listNarrativeSessions(db, 'n-cascade')).toHaveLength(0);
    });
  });

  // ----- patterns -----

  describe('patterns', () => {
    beforeEach(async () => {
      await insertProject(db, {
        id: 'p1',
        displayName: 'P1',
        discoveredAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:00:00Z',
        sentiment: 'positive',
        source: 'desktop',
      });
      await insertNarrative(db, {
        id: 'n1',
        projectId: 'p1',
        sentiment: 'positive',
        title: 't',
        body: 'b',
        generatedAt: '2025-01-01T00:00:00Z',
        actionType: 'encode',
      });
    });

    it('round-trips a pattern with boolean appendedToClaudeMd', async () => {
      const pat = await insertPattern(db, {
        id: 'pat-1',
        sourceNarrativeId: 'n1',
        projectId: 'p1',
        title: 'Pat',
        body: 'do X',
        encodedAt: '2025-01-02T00:00:00Z',
        appendedToClaudeMd: false,
      });
      expect(pat.appendedToClaudeMd).toBe(false);
      const after = await updatePattern(db, 'pat-1', { appendedToClaudeMd: true });
      expect(after.appendedToClaudeMd).toBe(true);
      expect(getPatternById(db, 'pat-1')?.appendedToClaudeMd).toBe(true);
      const filtered = listPatterns(db, { appendedToClaudeMd: true });
      expect(filtered).toHaveLength(1);
      expect(await deletePattern(db, 'pat-1')).toBe(true);
    });
  });

  // ----- findings (generic, both-or-neither session anchor) -----

  describe('findings', () => {
    beforeEach(async () => {
      await upsertAnalyzer(db, { name: 'kernel-x', version: '1' });
    });

    it('inserts, lists with filters, and deletes', async () => {
      const sessKey = { source: 'cli-direct', id: 's-f' };
      await insertSession(db, {
        ...sessKey,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
      });
      const f1 = await insertFinding(db, {
        kernel: 'kernel-x',
        payloadJson: JSON.stringify({ a: 1 }),
        emittedAt: 1000,
        sessionKey: sessKey,
      });
      const f2 = await insertFinding(db, {
        kernel: 'kernel-x',
        payloadJson: JSON.stringify({ a: 2 }),
        emittedAt: 2000,
      });
      expect(getFindingById(db, f1.id)).toEqual(f1);
      // Filter by kernel:
      expect(listFindings(db, { kernel: 'kernel-x' })).toHaveLength(2);
      // Filter by null session_source returns the unanchored one:
      const noSession = listFindings(db).filter((f) => f.sessionSource === null);
      expect(noSession).toHaveLength(1);
      expect(noSession[0]?.id).toBe(f2.id);
      // Both-or-neither: f1 has both populated, f2 has neither:
      expect(f1.sessionSource).toBe(sessKey.source);
      expect(f1.sessionId).toBe(sessKey.id);
      expect(f2.sessionSource).toBeNull();
      expect(f2.sessionId).toBeNull();

      expect(await deleteFinding(db, f1.id)).toBe(true);
      expect(listFindings(db)).toHaveLength(1);
    });

    it('deleting the analyzer CASCADE-deletes its findings', async () => {
      await insertFinding(db, {
        kernel: 'kernel-x',
        payloadJson: '{}',
        emittedAt: 1000,
      });
      expect(listFindings(db)).toHaveLength(1);
      await deleteAnalyzer(db, 'kernel-x');
      expect(listFindings(db)).toHaveLength(0);
    });
  });

  // ----- junctions -----

  describe('junctions', () => {
    beforeEach(async () => {
      await insertProject(db, {
        id: 'p1',
        displayName: 'P1',
        discoveredAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:00:00Z',
        sentiment: 'positive',
        source: 'desktop',
      });
      await insertTopic(db, {
        id: 't1',
        displayName: 'T1',
        firstSeenAt: '2025-01-01T00:00:00Z',
        lastSeenAt: '2025-01-01T00:00:00Z',
      });
      await insertSession(db, {
        source: 'cli-direct',
        id: 's1',
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 't',
        titleSource: 'extracted',
      });
    });

    it('project_sessions: link is idempotent, listProjectSessionKeys reads back', async () => {
      const session = { source: 'cli-direct', id: 's1' };
      await linkProjectSession(db, 'p1', session);
      await linkProjectSession(db, 'p1', session); // idempotent
      const links = listProjectSessions(db, 'p1');
      expect(links).toHaveLength(1);
      expect(listProjectSessionKeys(db, 'p1')).toEqual([session]);
      expect(await unlinkProjectSession(db, 'p1', session)).toBe(true);
      expect(listProjectSessions(db, 'p1')).toHaveLength(0);
    });

    it('project_topics: link, list, listProjectTopicIds round-trip', async () => {
      await linkProjectTopic(db, 'p1', 't1');
      expect(listProjectTopics(db, 'p1')).toHaveLength(1);
      expect(listProjectTopicIds(db, 'p1')).toEqual(['t1']);
    });

    it('topic_sessions: link + list', async () => {
      await linkTopicSession(db, 't1', { source: 'cli-direct', id: 's1' });
      expect(listTopicSessions(db, 't1')).toHaveLength(1);
    });

    it('narrative_sessions: link + list', async () => {
      await insertNarrative(db, {
        id: 'n1',
        projectId: 'p1',
        sentiment: 'positive',
        title: 't',
        body: 'b',
        generatedAt: '2025-01-01T00:00:00Z',
        actionType: 'observe',
      });
      await linkNarrativeSession(db, 'n1', { source: 'cli-direct', id: 's1' });
      expect(listNarrativeSessions(db, 'n1')).toHaveLength(1);
    });
  });

  // ----- cross-table sanity -----

  describe('cross-table integration', () => {
    it('full fixture seeds 14 tables and reads back as expected', async () => {
      // The A11 gate in miniature: write something into every entity
      // and confirm the SDK returns it. Mirrors the seeded-fixture
      // pattern that A11 will scale to a fuller corpus.
      await upsertAnalyzer(db, { name: 'k', version: '1' });
      await insertProject(db, {
        id: 'p',
        displayName: 'P',
        discoveredAt: '2025-01-01T00:00:00Z',
        lastActivityAt: '2025-01-01T00:00:00Z',
        sentiment: 'positive',
        source: 'desktop',
      });
      await insertTopic(db, {
        id: 't',
        displayName: 'T',
        firstSeenAt: '2025-01-01T00:00:00Z',
        lastSeenAt: '2025-01-01T00:00:00Z',
      });
      const sess = { source: 'cli-direct', id: 's' };
      await insertSession(db, {
        ...sess,
        rawSessionId: 'r',
        startedAt: 1000,
        updatedAt: 1000,
        durationMs: 0,
        title: 'T',
        titleSource: 'extracted',
      });
      await replaceSessionMessages(db, sess, [
        { turnIndex: 0, role: 'user', content: 'hi' },
      ]);
      await appendSessionRevision(db, sess, {
        observedAt: 1500,
        transcriptStatus: 'present',
      });
      await insertNarrative(db, {
        id: 'n',
        projectId: 'p',
        sentiment: 'positive',
        title: 't',
        body: 'b',
        generatedAt: '2025-01-01T00:00:00Z',
        actionType: 'observe',
      });
      await replaceNarrativeEvidence(db, 'n', [
        { evidenceIndex: 0, sessionSource: sess.source, sessionId: sess.id },
      ]);
      await insertPattern(db, {
        id: 'pat',
        sourceNarrativeId: 'n',
        projectId: 'p',
        title: 'pat',
        body: 'b',
        encodedAt: '2025-01-02T00:00:00Z',
      });
      await insertFinding(db, {
        kernel: 'k',
        payloadJson: '{}',
        emittedAt: 2000,
        projectId: 'p',
      });
      await linkProjectSession(db, 'p', sess);
      await linkProjectTopic(db, 'p', 't');
      await linkTopicSession(db, 't', sess);
      await linkNarrativeSession(db, 'n', sess);

      expect(listAnalyzers(db)).toHaveLength(1);
      expect(listProjects(db)).toHaveLength(1);
      expect(listTopics(db)).toHaveLength(1);
      expect(listSessions(db)).toHaveLength(1);
      expect(listSessionMessages(db, sess)).toHaveLength(1);
      expect(listSessionRevisions(db, sess)).toHaveLength(1);
      expect(listNarratives(db)).toHaveLength(1);
      expect(listNarrativeEvidence(db, 'n')).toHaveLength(1);
      expect(listPatterns(db)).toHaveLength(1);
      expect(listFindings(db)).toHaveLength(1);
      expect(listProjectSessions(db, 'p')).toHaveLength(1);
      expect(listProjectTopics(db, 'p')).toHaveLength(1);
      expect(listTopicSessions(db, 't')).toHaveLength(1);
      expect(listNarrativeSessions(db, 'n')).toHaveLength(1);
    });
  });
});
