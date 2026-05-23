// Initial schema migration — Phase Rev3-A sub-task A5.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` Phase Rev3-A:
//   "Create initial tables for first-class entities (Project, Topic,
//    Narrative, Pattern, Session, SessionMessage, SessionRevision) +
//    generic `findings` + `analyzers` registry + `schema_migrations`."
//
// Design choices documented inline so reviewers can ratify column-by-
// column without reverse-engineering the locked spec. Columns match
// the existing TypeScript entity types one-to-one
// (`packages/schema/src/{project,topic,narrative,pattern,unified}.ts`)
// — provenance fields (intent, observation, confidence, etc.) land in
// the Phase Rev3-B migration, not here.
//
// ID types: TEXT throughout. The locked spec's entity IDs are stable
// hashes or UUIDs (strings); INTEGER PRIMARY KEY would require either
// translating those at the SDK boundary (lossy) or assigning a
// surrogate (silly). The plan's "stable IDs required for idempotency"
// concern is met by stamping the entity ID at write time.
//
// Timestamp types: matched to existing TS shape. `Project` /
// `Topic` / `Narrative` / `Pattern` use ISO-string timestamps in TS,
// so the SQL columns are TEXT. `UnifiedSessionEntry` uses ms-since-
// epoch numbers in TS, so its columns are INTEGER. The mismatch is
// the existing schema convention, not a Rev3 decision.
//
// Many-to-many: a Project has `sessionIds[]`, `narrativeIds[]`,
// `topicIds[]` arrays in TS. The narrativeIds + project_id-on-
// narrative direction is owned (one narrative belongs to one project)
// — a `narratives.project_id` FK suffices. Project↔Session and
// Project↔Topic are true many-to-many, so they get junction tables
// (`project_sessions`, `project_topics`). Topic↔Session is also many-
// to-many (`topic_sessions`). The arrays in TS are derivable from
// these junction tables; the SDK reconstructs them at query time.
//
// Foreign keys: enabled by `openDb()` per connection. `ON DELETE
// CASCADE` for owned relationships (narrative → evidence, project →
// junction tables). `ON DELETE SET NULL` where the entity loosely
// references but doesn't own (sessions → project_id, findings →
// optional entity links).

import type { Database } from 'better-sqlite3';

import type { Migration } from './types.js';

const DDL = `
  -- Analyzer (kernel) registry. Plan §"Confidence ladder" requires
  -- per-kernel prior + calibration timestamp; the SDK reads these
  -- when computing Bayesian confidence in Rev3-B.
  CREATE TABLE analyzers (
    name TEXT PRIMARY KEY NOT NULL,
    version TEXT NOT NULL,
    last_run_at INTEGER,
    calibration_completed_at INTEGER,
    prior REAL NOT NULL DEFAULT 2.0
  );

  -- Project: discovered, narrative-bearing entity. Per spec §4.1.
  CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    discovered_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    sentiment TEXT NOT NULL,
    source TEXT NOT NULL
  );

  -- Topic: universal lightweight label. Per spec §4.2.
  CREATE TABLE topics (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  -- Session: one row per (source, id) pair. Per
  -- packages/schema/src/unified.ts UnifiedSessionEntry. Composite PK
  -- because the same id can appear in multiple sources (Phase 2/3
  -- exporter de-dups by preferring cli-desktop, but the raw rows
  -- coexist).
  CREATE TABLE sessions (
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    raw_session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL,
    preview TEXT,
    project_id TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL
  );

  -- Per-message rows. The exporter writes these so kernel scans don't
  -- have to re-parse transcripts on every run. role is 'user' /
  -- 'assistant' / 'tool' / 'system' per Anthropic SDK shape.
  CREATE TABLE session_messages (
    session_source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    timestamp INTEGER,
    PRIMARY KEY (session_source, session_id, turn_index),
    FOREIGN KEY (session_source, session_id)
      REFERENCES sessions (source, id) ON DELETE CASCADE
  );

  -- Revision audit trail. Captures pruning events (transcriptStatus
  -- = 'pruned' per commit 5c480aa) and re-import observations so the
  -- viewer can show "session was pruned at T1, recovered at T2".
  -- Surrogate INTEGER PK because revisions are append-only.
  CREATE TABLE session_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    transcript_status TEXT NOT NULL,
    FOREIGN KEY (session_source, session_id)
      REFERENCES sessions (source, id) ON DELETE CASCADE
  );

  -- Narrative: positive/negative finding attached to a Project. Per
  -- spec §4.4. schema_version starts at 1; Rev3-B bumps to 2 when
  -- provenance fields land.
  CREATE TABLE narratives (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    sentiment TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    action_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
  );

  -- Evidence rows for each narrative. evidence_index preserves array
  -- order; (narrative_id, evidence_index) is the natural PK.
  CREATE TABLE narrative_evidence (
    narrative_id TEXT NOT NULL,
    evidence_index INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    anchor TEXT,
    excerpt TEXT,
    PRIMARY KEY (narrative_id, evidence_index),
    FOREIGN KEY (narrative_id) REFERENCES narratives (id) ON DELETE CASCADE
  );

  -- Pattern: encoded actionable rule promoted from a Narrative. Per
  -- spec §9. appended_to_claude_md is 0/1 (SQLite has no bool type).
  CREATE TABLE patterns (
    id TEXT PRIMARY KEY NOT NULL,
    source_narrative_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    encoded_at TEXT NOT NULL,
    appended_to_claude_md INTEGER NOT NULL DEFAULT 0 CHECK (appended_to_claude_md IN (0, 1)),
    FOREIGN KEY (source_narrative_id) REFERENCES narratives (id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
  );

  -- Many-to-many junctions. The TS shape exposes arrays
  -- (Project.sessionIds[], etc.); the SDK reconstructs them by
  -- joining through these tables.
  CREATE TABLE project_sessions (
    project_id TEXT NOT NULL,
    session_source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    PRIMARY KEY (project_id, session_source, session_id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY (session_source, session_id)
      REFERENCES sessions (source, id) ON DELETE CASCADE
  );

  CREATE TABLE project_topics (
    project_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    PRIMARY KEY (project_id, topic_id),
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE
  );

  CREATE TABLE topic_sessions (
    topic_id TEXT NOT NULL,
    session_source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    PRIMARY KEY (topic_id, session_source, session_id),
    FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE CASCADE,
    FOREIGN KEY (session_source, session_id)
      REFERENCES sessions (source, id) ON DELETE CASCADE
  );

  -- Generic findings table for kernel outputs that don't warrant a
  -- dedicated table. payload_json carries kernel-specific shape; the
  -- optional FK columns let UI surfaces filter by anchor entity
  -- without parsing the JSON. ON DELETE SET NULL because a finding
  -- can outlive the entity it anchored to (e.g. a finding about
  -- "project X had high decision velocity" stays meaningful even if
  -- the project is re-discovered with a new ID).
  CREATE TABLE findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kernel TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    emitted_at INTEGER NOT NULL,
    project_id TEXT,
    topic_id TEXT,
    session_source TEXT,
    session_id TEXT,
    narrative_id TEXT,
    pattern_id TEXT,
    FOREIGN KEY (kernel) REFERENCES analyzers (name) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
    FOREIGN KEY (topic_id) REFERENCES topics (id) ON DELETE SET NULL,
    FOREIGN KEY (session_source, session_id)
      REFERENCES sessions (source, id) ON DELETE SET NULL,
    FOREIGN KEY (narrative_id) REFERENCES narratives (id) ON DELETE SET NULL,
    FOREIGN KEY (pattern_id) REFERENCES patterns (id) ON DELETE SET NULL
  );

  -- Indexes for the most common query paths. Added now rather than
  -- in a follow-on migration so the first SDK-backed query in
  -- Rev3-A.A8 doesn't full-scan.
  CREATE INDEX idx_sessions_project ON sessions (project_id);
  CREATE INDEX idx_sessions_started ON sessions (started_at);
  CREATE INDEX idx_session_messages_session
    ON session_messages (session_source, session_id);
  CREATE INDEX idx_session_revisions_session
    ON session_revisions (session_source, session_id);
  CREATE INDEX idx_narratives_project ON narratives (project_id);
  CREATE INDEX idx_patterns_project ON patterns (project_id);
  CREATE INDEX idx_findings_kernel ON findings (kernel);
  CREATE INDEX idx_findings_project ON findings (project_id);
`;

export const initialSchemaMigration: Migration = {
  id: '001-initial-schema',
  name: 'Initial schema — entities, junctions, findings, analyzers',
  up(db: Database): void {
    db.exec(DDL);
  },
};
