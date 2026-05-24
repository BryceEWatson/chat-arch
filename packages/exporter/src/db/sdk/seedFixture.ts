// Reusable seed-fixture helper for the chat-arch SQLite SDK
// (Phase Rev3-A sub-task A11 — gate for Phase Rev3-A).
//
// Produces a deterministic small corpus that exercises every entity,
// every junction, and the cross-entity relationships the downstream
// phases will rely on:
//
//   - 2 analyzers (kernels), one calibrated, one not.
//   - 3 projects (P1, P2, P3) with realistic discovery / activity dates.
//   - 4 topics (T1..T4) — T1 spans P1+P2, T2 only P1, T3 only P2,
//     T4 only P3.
//   - 7 sessions distributed across projects + sources (mix of
//     cli-direct and desktop, same session id appearing under two
//     sources to exercise the composite-PK case).
//   - Session messages on 3 of the 7 sessions; revisions on 1.
//   - 5 narratives across the 3 projects, with evidence rows on 3,
//     spanning two distinct schema versions (1 and 2) to exercise the
//     schemaVersion filter.
//   - 2 patterns promoted from narratives N3 + N5 (one
//     appended-to-CLAUDE-md, one not).
//   - 4 findings: one anchored to a session, one to a project, one
//     to a narrative, one fully unanchored.
//   - All junctions populated to match the project↔session,
//     project↔topic, topic↔session, narrative↔session relations
//     implied by the rows above.
//
// Downstream phases (B-I) can call `seedRev3Fixture(db)` to get a
// known-good baseline they can layer their own writes on top of.

import type { Database } from 'better-sqlite3';

import { upsertAnalyzer } from './analyzers.js';
import { insertFinding } from './findings.js';
import {
  linkNarrativeSession,
  linkProjectSession,
  linkProjectTopic,
  linkTopicSession,
} from './junctions.js';
import { replaceNarrativeEvidence } from './narrativeEvidence.js';
import { insertNarrative } from './narratives.js';
import { insertPattern } from './patterns.js';
import { insertProject } from './projects.js';
import { replaceSessionMessages } from './sessionMessages.js';
import { appendSessionRevision } from './sessionRevisions.js';
import { insertSession } from './sessions.js';
import { insertTopic } from './topics.js';
import type { SessionKey } from './types.js';

/**
 * Summary of what the fixture wrote. Tests assert against these
 * counts so a future change to the fixture either matches the
 * existing summary or updates this object alongside the change —
 * preventing silent fixture drift.
 */
export interface SeedFixtureSummary {
  readonly analyzers: 2;
  readonly projects: 3;
  readonly topics: 4;
  readonly sessions: 7;
  readonly sessionMessageRows: 6;
  readonly sessionRevisionRows: 1;
  readonly narratives: 5;
  readonly narrativeEvidenceRows: 5;
  readonly patterns: 2;
  readonly findings: 4;
  readonly projectSessionLinks: 7;
  readonly projectTopicLinks: 5;
  readonly topicSessionLinks: 6;
  readonly narrativeSessionLinks: 4;
}

/** Stable identifiers exposed for tests to assert specific shapes. */
export const SEED_IDS = {
  analyzers: { calibrated: 'kernel-alpha', uncalibrated: 'kernel-beta' } as const,
  projects: { p1: 'proj-p1', p2: 'proj-p2', p3: 'proj-p3' } as const,
  topics: { t1: 'topic-t1', t2: 'topic-t2', t3: 'topic-t3', t4: 'topic-t4' } as const,
  narratives: {
    n1: 'narr-n1',
    n2: 'narr-n2',
    n3: 'narr-n3',
    n4: 'narr-n4',
    n5: 'narr-n5',
  } as const,
  patterns: { pat1: 'pat-pat1', pat2: 'pat-pat2' } as const,
} as const;

/**
 * Stable session keys. The pair `(cli-direct, sess-shared)` +
 * `(desktop, sess-shared)` exercises the same `id` under two sources
 * — a real-world case from the unified exporter.
 */
export const SEED_SESSION_KEYS: readonly SessionKey[] = [
  { source: 'cli-direct', id: 'sess-1' },
  { source: 'cli-direct', id: 'sess-2' },
  { source: 'cli-direct', id: 'sess-shared' },
  { source: 'desktop', id: 'sess-shared' },
  { source: 'desktop', id: 'sess-4' },
  { source: 'desktop', id: 'sess-5' },
  { source: 'cli-direct', id: 'sess-6' },
] as const;

/**
 * Seed the fixture into an empty post-migration database. Idempotent
 * is NOT a goal — call once per test against a freshly-migrated DB.
 * Returns a summary of what was written.
 */
export async function seedRev3Fixture(db: Database): Promise<SeedFixtureSummary> {
  // ----- analyzers -----
  await upsertAnalyzer(db, {
    name: SEED_IDS.analyzers.calibrated,
    version: '1.0.0',
    lastRunAt: 1_700_000_000_000,
    calibrationCompletedAt: 1_699_000_000_000,
    prior: 2.0,
  });
  await upsertAnalyzer(db, {
    name: SEED_IDS.analyzers.uncalibrated,
    version: '0.9.0',
    lastRunAt: 1_700_000_000_000,
    // calibrationCompletedAt omitted → null → tier-3 unreachable.
    prior: 20.0,
  });

  // ----- projects -----
  await insertProject(db, {
    id: SEED_IDS.projects.p1,
    displayName: 'Project P1',
    discoveredAt: '2025-01-01T00:00:00Z',
    lastActivityAt: '2025-03-15T00:00:00Z',
    sentiment: 'positive',
    source: 'desktop',
  });
  await insertProject(db, {
    id: SEED_IDS.projects.p2,
    displayName: 'Project P2',
    discoveredAt: '2025-02-01T00:00:00Z',
    lastActivityAt: '2025-03-01T00:00:00Z',
    sentiment: 'mixed',
    source: 'cli-direct',
  });
  await insertProject(db, {
    id: SEED_IDS.projects.p3,
    displayName: 'Project P3',
    discoveredAt: '2025-03-01T00:00:00Z',
    lastActivityAt: '2025-03-10T00:00:00Z',
    sentiment: 'negative',
    source: 'desktop',
  });

  // ----- topics -----
  await insertTopic(db, {
    id: SEED_IDS.topics.t1,
    displayName: 'Topic T1',
    firstSeenAt: '2025-01-05T00:00:00Z',
    lastSeenAt: '2025-03-14T00:00:00Z',
  });
  await insertTopic(db, {
    id: SEED_IDS.topics.t2,
    displayName: 'Topic T2',
    firstSeenAt: '2025-01-10T00:00:00Z',
    lastSeenAt: '2025-02-20T00:00:00Z',
  });
  await insertTopic(db, {
    id: SEED_IDS.topics.t3,
    displayName: 'Topic T3',
    firstSeenAt: '2025-02-05T00:00:00Z',
    lastSeenAt: '2025-02-28T00:00:00Z',
  });
  await insertTopic(db, {
    id: SEED_IDS.topics.t4,
    displayName: 'Topic T4',
    firstSeenAt: '2025-03-02T00:00:00Z',
    lastSeenAt: '2025-03-08T00:00:00Z',
  });

  // ----- sessions -----
  // Project mapping: [sess-1, sess-2, sess-shared/cli] → p1;
  // [sess-shared/desktop, sess-4] → p2; [sess-5, sess-6] → p3.
  const sessionPlan: readonly {
    key: SessionKey;
    projectId: string;
    startedAt: number;
    title: string;
    messageCount: number;
  }[] = [
    { key: SEED_SESSION_KEYS[0]!, projectId: SEED_IDS.projects.p1, startedAt: 1_700_001_000, title: 'P1 session 1', messageCount: 4 },
    { key: SEED_SESSION_KEYS[1]!, projectId: SEED_IDS.projects.p1, startedAt: 1_700_002_000, title: 'P1 session 2', messageCount: 2 },
    { key: SEED_SESSION_KEYS[2]!, projectId: SEED_IDS.projects.p1, startedAt: 1_700_003_000, title: 'P1 shared-id (cli)', messageCount: 0 },
    { key: SEED_SESSION_KEYS[3]!, projectId: SEED_IDS.projects.p2, startedAt: 1_700_004_000, title: 'P2 shared-id (desktop)', messageCount: 0 },
    { key: SEED_SESSION_KEYS[4]!, projectId: SEED_IDS.projects.p2, startedAt: 1_700_005_000, title: 'P2 session 4', messageCount: 0 },
    { key: SEED_SESSION_KEYS[5]!, projectId: SEED_IDS.projects.p3, startedAt: 1_700_006_000, title: 'P3 session 5', messageCount: 0 },
    { key: SEED_SESSION_KEYS[6]!, projectId: SEED_IDS.projects.p3, startedAt: 1_700_007_000, title: 'P3 session 6', messageCount: 0 },
  ];
  for (const { key, projectId, startedAt, title, messageCount } of sessionPlan) {
    await insertSession(db, {
      ...key,
      rawSessionId: `raw-${key.source}-${key.id}`,
      startedAt,
      updatedAt: startedAt + 60_000,
      durationMs: 60_000,
      title,
      titleSource: 'extracted',
      projectId,
      messageCount,
      tokensInput: messageCount * 100,
      tokensOutput: messageCount * 50,
    });
  }

  // ----- session_messages on sess-1 (4 turns), sess-2 (2 turns) -----
  await replaceSessionMessages(db, SEED_SESSION_KEYS[0]!, [
    { turnIndex: 0, role: 'user', content: 'How do I configure X?', timestamp: 1_700_001_000 },
    { turnIndex: 1, role: 'assistant', content: 'Set the X flag in config.', timestamp: 1_700_001_500 },
    { turnIndex: 2, role: 'user', content: 'What about Y?', timestamp: 1_700_001_800 },
    { turnIndex: 3, role: 'assistant', content: 'Y depends on X being set.', timestamp: 1_700_001_900 },
  ]);
  await replaceSessionMessages(db, SEED_SESSION_KEYS[1]!, [
    { turnIndex: 0, role: 'user', content: 'follow-up' },
    { turnIndex: 1, role: 'assistant', content: 'sure', timestamp: 1_700_002_100 },
  ]);

  // ----- session_revisions on sess-1 -----
  await appendSessionRevision(db, SEED_SESSION_KEYS[0]!, {
    observedAt: 1_700_001_950,
    transcriptStatus: 'present',
  });

  // ----- narratives across projects -----
  // n1, n2 → p1 (schemaVersion 1)
  // n3 → p1 (schemaVersion 2 — provenance-ready)
  // n4 → p2 (schemaVersion 1)
  // n5 → p3 (schemaVersion 1)
  await insertNarrative(db, {
    id: SEED_IDS.narratives.n1,
    projectId: SEED_IDS.projects.p1,
    sentiment: 'positive',
    title: 'X always works after Y',
    body: 'Repeated observation that pattern X succeeds when Y is set first.',
    generatedAt: '2025-03-01T00:00:00Z',
    actionType: 'observe',
  });
  await insertNarrative(db, {
    id: SEED_IDS.narratives.n2,
    projectId: SEED_IDS.projects.p1,
    sentiment: 'negative',
    title: 'Z fails on weekends',
    body: 'Z workflow consistently breaks on Sundays.',
    generatedAt: '2025-03-05T00:00:00Z',
    actionType: 'fix',
  });
  await insertNarrative(db, {
    id: SEED_IDS.narratives.n3,
    projectId: SEED_IDS.projects.p1,
    sentiment: 'positive',
    title: 'Encode-as-pattern candidate',
    body: 'Reproducible win that should be promoted.',
    generatedAt: '2025-03-10T00:00:00Z',
    actionType: 'encode',
    schemaVersion: 2,
  });
  await insertNarrative(db, {
    id: SEED_IDS.narratives.n4,
    projectId: SEED_IDS.projects.p2,
    sentiment: 'mixed',
    title: 'Inconclusive evidence',
    body: 'Need more sessions to verify.',
    generatedAt: '2025-03-02T00:00:00Z',
    actionType: 'observe',
  });
  await insertNarrative(db, {
    id: SEED_IDS.narratives.n5,
    projectId: SEED_IDS.projects.p3,
    sentiment: 'positive',
    title: 'P3 pattern candidate',
    body: 'Promotable to pattern.',
    generatedAt: '2025-03-08T00:00:00Z',
    actionType: 'encode',
  });

  // ----- narrative_evidence: n1, n3, n5 carry evidence rows -----
  await replaceNarrativeEvidence(db, SEED_IDS.narratives.n1, [
    { evidenceIndex: 0, session: SEED_SESSION_KEYS[0]!, anchor: 'turn:1', excerpt: 'Set the X flag in config.' },
    { evidenceIndex: 1, session: SEED_SESSION_KEYS[1]!, anchor: 'turn:0' },
  ]);
  await replaceNarrativeEvidence(db, SEED_IDS.narratives.n3, [
    { evidenceIndex: 0, session: SEED_SESSION_KEYS[0]!, anchor: 'turn:3', excerpt: 'Y depends on X being set.' },
    { evidenceIndex: 1, session: SEED_SESSION_KEYS[2]!, anchor: 'turn:0' },
  ]);
  await replaceNarrativeEvidence(db, SEED_IDS.narratives.n5, [
    { evidenceIndex: 0, session: SEED_SESSION_KEYS[5]!, anchor: 'turn:0' },
  ]);

  // ----- patterns promoted from n3 (CLAUDE.md-appended) + n5 (not) -----
  await insertPattern(db, {
    id: SEED_IDS.patterns.pat1,
    sourceNarrativeId: SEED_IDS.narratives.n3,
    projectId: SEED_IDS.projects.p1,
    title: 'Always set X before Y',
    body: 'When you need Y to work, set X first per N3.',
    encodedAt: '2025-03-11T00:00:00Z',
    appendedToClaudeMd: true,
  });
  await insertPattern(db, {
    id: SEED_IDS.patterns.pat2,
    sourceNarrativeId: SEED_IDS.narratives.n5,
    projectId: SEED_IDS.projects.p3,
    title: 'P3 rule',
    body: 'Promotable rule for P3.',
    encodedAt: '2025-03-09T00:00:00Z',
    appendedToClaudeMd: false,
  });

  // ----- findings: 1 session-anchored, 1 project, 1 narrative, 1 unanchored -----
  await insertFinding(db, {
    kernel: SEED_IDS.analyzers.calibrated,
    payloadJson: JSON.stringify({ score: 0.82, kind: 'session-level' }),
    emittedAt: 1_700_010_000,
    sessionKey: SEED_SESSION_KEYS[0]!,
    projectId: SEED_IDS.projects.p1,
  });
  await insertFinding(db, {
    kernel: SEED_IDS.analyzers.calibrated,
    payloadJson: JSON.stringify({ score: 0.61, kind: 'project-level' }),
    emittedAt: 1_700_010_500,
    projectId: SEED_IDS.projects.p2,
  });
  await insertFinding(db, {
    kernel: SEED_IDS.analyzers.uncalibrated,
    payloadJson: JSON.stringify({ score: 0.41, kind: 'narrative-level' }),
    emittedAt: 1_700_011_000,
    narrativeId: SEED_IDS.narratives.n2,
  });
  await insertFinding(db, {
    kernel: SEED_IDS.analyzers.uncalibrated,
    payloadJson: JSON.stringify({ kind: 'corpus-level' }),
    emittedAt: 1_700_011_500,
  });

  // ----- junctions -----
  // project_sessions: 1:1 mirror of session.projectId.
  for (const { key, projectId } of sessionPlan) {
    await linkProjectSession(db, projectId, key);
  }
  // project_topics: T1 → P1+P2 ; T2 → P1 ; T3 → P2 ; T4 → P3.
  await linkProjectTopic(db, SEED_IDS.projects.p1, SEED_IDS.topics.t1);
  await linkProjectTopic(db, SEED_IDS.projects.p2, SEED_IDS.topics.t1);
  await linkProjectTopic(db, SEED_IDS.projects.p1, SEED_IDS.topics.t2);
  await linkProjectTopic(db, SEED_IDS.projects.p2, SEED_IDS.topics.t3);
  await linkProjectTopic(db, SEED_IDS.projects.p3, SEED_IDS.topics.t4);
  // topic_sessions: T1 → all P1 + P2 sessions (5); T4 → P3 sessions (2 each but
  // only one — we link T4 → sess-5 only to keep the count exact).
  for (const i of [0, 1, 2, 3, 4]) {
    await linkTopicSession(db, SEED_IDS.topics.t1, SEED_SESSION_KEYS[i]!);
  }
  await linkTopicSession(db, SEED_IDS.topics.t4, SEED_SESSION_KEYS[5]!);
  // narrative_sessions: N1 → sess-1, sess-2 ; N3 → sess-1, sess-shared/cli.
  await linkNarrativeSession(db, SEED_IDS.narratives.n1, SEED_SESSION_KEYS[0]!);
  await linkNarrativeSession(db, SEED_IDS.narratives.n1, SEED_SESSION_KEYS[1]!);
  await linkNarrativeSession(db, SEED_IDS.narratives.n3, SEED_SESSION_KEYS[0]!);
  await linkNarrativeSession(db, SEED_IDS.narratives.n3, SEED_SESSION_KEYS[2]!);

  return {
    analyzers: 2,
    projects: 3,
    topics: 4,
    sessions: 7,
    sessionMessageRows: 6,
    sessionRevisionRows: 1,
    narratives: 5,
    narrativeEvidenceRows: 5,
    patterns: 2,
    findings: 4,
    projectSessionLinks: 7,
    projectTopicLinks: 5,
    topicSessionLinks: 6,
    narrativeSessionLinks: 4,
  };
}
