// End-to-end SDK-against-seeded-corpus tests for Phase Rev3-A sub-task
// A11 (gate for Phase Rev3-A: "SDK returns expected rows from a
// seeded-fixture test corpus").
//
// Distinct from `sdk.test.ts` (unit-shaped CRUD round-trips):
//
//   - sdk.test.ts seeds ad-hoc per test; verifies API contract on each
//     entity individually.
//   - seedFixture.test.ts seeds a SINGLE realistic corpus via
//     `seedRev3Fixture()` and asserts cross-entity workflows + join
//     queries actually return the rows we expect.
//
// The fixture is reusable by downstream phases (B-I) for their own
// integration tests; this file's assertions doubly serve as the
// fixture's contract test.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import { MIGRATIONS, runMigrations } from '../migrations/index.js';
import { getAnalyzerByName, listAnalyzers } from './analyzers.js';
import { getFindingById, listFindings } from './findings.js';
import {
  listNarrativeSessions,
  listProjectSessions,
  listProjectTopics,
  listTopicSessions,
} from './junctions.js';
import { listNarrativeEvidence } from './narrativeEvidence.js';
import {
  deleteNarrative,
  getNarrativeById,
  listNarratives,
} from './narratives.js';
import { getPatternById, listPatterns } from './patterns.js';
import {
  deleteProject,
  getProjectById,
  listProjects,
} from './projects.js';
import {
  SEED_IDS,
  SEED_SESSION_KEYS,
  type SeedFixtureSummary,
  seedRev3Fixture,
} from './seedFixture.js';
import { listSessionMessages } from './sessionMessages.js';
import { listSessionRevisions } from './sessionRevisions.js';
import { getSessionByKey, listSessions } from './sessions.js';
import { getTopicById, listTopics } from './topics.js';

describe('SDK against seeded-corpus fixture (A11 gate)', () => {
  let tmpDir: string;
  let db: Database;
  let summary: SeedFixtureSummary;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-a11-test-'));
    db = openDb(join(tmpDir, 'a11.db'));
    runMigrations(db, MIGRATIONS);
    summary = await seedRev3Fixture(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fixture summary contract (no silent drift)', () => {
    it('analyzers, projects, topics, sessions counts match the summary', () => {
      expect(listAnalyzers(db)).toHaveLength(summary.analyzers);
      expect(listProjects(db)).toHaveLength(summary.projects);
      expect(listTopics(db)).toHaveLength(summary.topics);
      expect(listSessions(db)).toHaveLength(summary.sessions);
    });

    it('narratives, patterns, findings counts match the summary', () => {
      expect(listNarratives(db)).toHaveLength(summary.narratives);
      expect(listPatterns(db)).toHaveLength(summary.patterns);
      expect(listFindings(db)).toHaveLength(summary.findings);
    });

    it('per-session message + revision counts sum to the fixture totals', () => {
      let messages = 0;
      let revisions = 0;
      for (const key of SEED_SESSION_KEYS) {
        messages += listSessionMessages(db, key).length;
        revisions += listSessionRevisions(db, key).length;
      }
      expect(messages).toBe(summary.sessionMessageRows);
      expect(revisions).toBe(summary.sessionRevisionRows);
    });

    it('per-narrative evidence rows sum to the fixture total', () => {
      let evidence = 0;
      for (const id of Object.values(SEED_IDS.narratives)) {
        evidence += listNarrativeEvidence(db, id).length;
      }
      expect(evidence).toBe(summary.narrativeEvidenceRows);
    });

    it('junction link counts match the summary', () => {
      let projectSessionLinks = 0;
      let topicSessionLinks = 0;
      let projectTopicLinks = 0;
      let narrativeSessionLinks = 0;
      for (const id of Object.values(SEED_IDS.projects)) {
        projectSessionLinks += listProjectSessions(db, id).length;
        projectTopicLinks += listProjectTopics(db, id).length;
      }
      for (const id of Object.values(SEED_IDS.topics)) {
        topicSessionLinks += listTopicSessions(db, id).length;
      }
      for (const id of Object.values(SEED_IDS.narratives)) {
        narrativeSessionLinks += listNarrativeSessions(db, id).length;
      }
      expect(projectSessionLinks).toBe(summary.projectSessionLinks);
      expect(topicSessionLinks).toBe(summary.topicSessionLinks);
      expect(projectTopicLinks).toBe(summary.projectTopicLinks);
      expect(narrativeSessionLinks).toBe(summary.narrativeSessionLinks);
    });
  });

  describe('individual rows resolve by ID', () => {
    it('analyzer kernel-alpha is calibrated; kernel-beta is not', () => {
      const calibrated = getAnalyzerByName(db, SEED_IDS.analyzers.calibrated);
      const uncalibrated = getAnalyzerByName(db, SEED_IDS.analyzers.uncalibrated);
      expect(calibrated?.calibrationCompletedAt).not.toBeNull();
      expect(calibrated?.prior).toBe(2.0);
      expect(uncalibrated?.calibrationCompletedAt).toBeNull();
      expect(uncalibrated?.prior).toBe(20.0);
    });

    it('project P1 has the expected display name and sentiment', () => {
      const p1 = getProjectById(db, SEED_IDS.projects.p1);
      expect(p1?.displayName).toBe('Project P1');
      expect(p1?.sentiment).toBe('positive');
    });

    it('topic T1 spans projects P1 and P2 via project_topics', () => {
      // listProjectTopics is per-project; sweep all and find T1.
      const p1Topics = listProjectTopics(db, SEED_IDS.projects.p1)
        .map((l) => l.topicId);
      const p2Topics = listProjectTopics(db, SEED_IDS.projects.p2)
        .map((l) => l.topicId);
      const p3Topics = listProjectTopics(db, SEED_IDS.projects.p3)
        .map((l) => l.topicId);
      expect(p1Topics).toContain(SEED_IDS.topics.t1);
      expect(p2Topics).toContain(SEED_IDS.topics.t1);
      expect(p3Topics).not.toContain(SEED_IDS.topics.t1);
    });

    it('topic T4 is found by id and only linked to P3', () => {
      expect(getTopicById(db, SEED_IDS.topics.t4)?.displayName).toBe('Topic T4');
      const p3Topics = listProjectTopics(db, SEED_IDS.projects.p3).map((l) => l.topicId);
      expect(p3Topics).toEqual([SEED_IDS.topics.t4]);
    });

    it('same session id under two sources both resolve and have distinct projects', () => {
      const cliShared = getSessionByKey(db, { source: 'cli-direct', id: 'sess-shared' });
      const desktopShared = getSessionByKey(db, { source: 'desktop', id: 'sess-shared' });
      expect(cliShared).not.toBeNull();
      expect(desktopShared).not.toBeNull();
      expect(cliShared?.projectId).toBe(SEED_IDS.projects.p1);
      expect(desktopShared?.projectId).toBe(SEED_IDS.projects.p2);
    });

    it('narrative N3 carries schemaVersion 2; the rest are 1', () => {
      const n3 = getNarrativeById(db, SEED_IDS.narratives.n3);
      expect(n3?.schemaVersion).toBe(2);
      for (const id of [SEED_IDS.narratives.n1, SEED_IDS.narratives.n2, SEED_IDS.narratives.n4, SEED_IDS.narratives.n5]) {
        expect(getNarrativeById(db, id)?.schemaVersion).toBe(1);
      }
    });

    it('pattern PAT1 is appended-to-CLAUDE.md; PAT2 is not', () => {
      const pat1 = getPatternById(db, SEED_IDS.patterns.pat1);
      const pat2 = getPatternById(db, SEED_IDS.patterns.pat2);
      expect(pat1?.appendedToClaudeMd).toBe(true);
      expect(pat2?.appendedToClaudeMd).toBe(false);
    });
  });

  describe('filtered queries return the expected subsets', () => {
    it('listSessions({projectId: p1}) returns 3 sessions', () => {
      expect(
        listSessions(db, { projectId: SEED_IDS.projects.p1 }),
      ).toHaveLength(3);
    });

    it('listSessions({source: "desktop"}) returns the 3 desktop sessions', () => {
      const desktop = listSessions(db, { source: 'desktop' });
      expect(desktop.map((s) => s.id).sort()).toEqual(['sess-4', 'sess-5', 'sess-shared']);
    });

    it('listNarratives({projectId: p1}) returns N1+N2+N3', () => {
      const ids = listNarratives(db, { projectId: SEED_IDS.projects.p1 })
        .map((n) => n.id)
        .sort();
      expect(ids).toEqual([
        SEED_IDS.narratives.n1,
        SEED_IDS.narratives.n2,
        SEED_IDS.narratives.n3,
      ]);
    });

    it('listNarratives({schemaVersion: 2}) returns only N3', () => {
      const ids = listNarratives(db, { schemaVersion: 2 }).map((n) => n.id);
      expect(ids).toEqual([SEED_IDS.narratives.n3]);
    });

    it('listNarratives({sentiment: "mixed"}) returns N4 (the inconclusive one)', () => {
      const rows = listNarratives(db, { sentiment: 'mixed' });
      expect(rows.map((n) => n.id)).toEqual([SEED_IDS.narratives.n4]);
    });

    it('listFindings({session: sess-1/cli}) returns only the session-anchored one', () => {
      const found = listFindings(db, { session: SEED_SESSION_KEYS[0]! });
      expect(found).toHaveLength(1);
      const parsed = JSON.parse(found[0]!.payloadJson) as { kind: string };
      expect(parsed.kind).toBe('session-level');
    });

    it('listFindings({session: null}) returns the 3 session-null findings (project/narrative/corpus-level)', () => {
      // 4 findings total: 1 session-anchored + 3 session-NULL (one
      // anchored to a project, one to a narrative, one fully
      // unanchored). The session filter is independent of the other
      // anchor columns.
      const sessionNull = listFindings(db, { session: null });
      expect(sessionNull).toHaveLength(3);
      const kinds = sessionNull
        .map((f) => (JSON.parse(f.payloadJson) as { kind: string }).kind)
        .sort();
      expect(kinds).toEqual(['corpus-level', 'narrative-level', 'project-level']);
    });

    it('listFindings({kernel: kernel-beta}) returns the 2 uncalibrated-kernel findings', () => {
      expect(
        listFindings(db, { kernel: SEED_IDS.analyzers.uncalibrated }),
      ).toHaveLength(2);
    });

    it('listPatterns({appendedToClaudeMd: true}) returns only PAT1', () => {
      const promoted = listPatterns(db, { appendedToClaudeMd: true });
      expect(promoted.map((p) => p.id)).toEqual([SEED_IDS.patterns.pat1]);
    });
  });

  describe('cascade-delete realistic workflows', () => {
    it('deleting P1 cascades: removes narratives N1+N2+N3, their evidence, their pattern PAT1', async () => {
      // Pre-conditions
      expect(getProjectById(db, SEED_IDS.projects.p1)).not.toBeNull();
      expect(listNarratives(db, { projectId: SEED_IDS.projects.p1 })).toHaveLength(3);
      expect(getPatternById(db, SEED_IDS.patterns.pat1)).not.toBeNull();
      expect(listNarrativeEvidence(db, SEED_IDS.narratives.n1)).toHaveLength(2);

      expect(await deleteProject(db, SEED_IDS.projects.p1)).toBe(true);

      // Project gone
      expect(getProjectById(db, SEED_IDS.projects.p1)).toBeNull();
      // Narratives gone (CASCADE on narratives.project_id)
      expect(listNarratives(db, { projectId: SEED_IDS.projects.p1 })).toHaveLength(0);
      expect(getNarrativeById(db, SEED_IDS.narratives.n3)).toBeNull();
      // Pattern PAT1 (project_id FK CASCADE) gone
      expect(getPatternById(db, SEED_IDS.patterns.pat1)).toBeNull();
      // Evidence gone (narrative CASCADE)
      expect(listNarrativeEvidence(db, SEED_IDS.narratives.n1)).toHaveLength(0);
      // Sessions remain — sessions.project_id is ON DELETE SET NULL
      const orphaned = listSessions(db, { projectId: null });
      expect(orphaned.map((s) => s.id).sort()).toEqual(
        ['sess-1', 'sess-2', 'sess-shared'].sort(),
      );
      // P3 narratives + pattern untouched
      expect(getNarrativeById(db, SEED_IDS.narratives.n5)).not.toBeNull();
      expect(getPatternById(db, SEED_IDS.patterns.pat2)).not.toBeNull();
    });

    it('deleting narrative N3 cascades: removes evidence + session links + the dependent pattern PAT1', async () => {
      expect(getNarrativeById(db, SEED_IDS.narratives.n3)).not.toBeNull();
      expect(listNarrativeEvidence(db, SEED_IDS.narratives.n3)).toHaveLength(2);
      expect(listNarrativeSessions(db, SEED_IDS.narratives.n3)).toHaveLength(2);
      expect(getPatternById(db, SEED_IDS.patterns.pat1)).not.toBeNull();

      expect(await deleteNarrative(db, SEED_IDS.narratives.n3)).toBe(true);

      expect(getNarrativeById(db, SEED_IDS.narratives.n3)).toBeNull();
      expect(listNarrativeEvidence(db, SEED_IDS.narratives.n3)).toHaveLength(0);
      expect(listNarrativeSessions(db, SEED_IDS.narratives.n3)).toHaveLength(0);
      // Pattern PAT1 (source_narrative_id FK CASCADE) gone
      expect(getPatternById(db, SEED_IDS.patterns.pat1)).toBeNull();
    });

    it('finding referencing N2 survives N2 deletion because narrative_id is ON DELETE SET NULL', async () => {
      const before = listFindings(db, { narrativeId: SEED_IDS.narratives.n2 });
      expect(before).toHaveLength(1);
      const findingId = before[0]!.id;

      expect(await deleteNarrative(db, SEED_IDS.narratives.n2)).toBe(true);

      // The finding row still exists; its narrative_id is now NULL.
      const after = getFindingById(db, findingId);
      expect(after).not.toBeNull();
      expect(after?.narrativeId).toBeNull();
    });
  });
});
