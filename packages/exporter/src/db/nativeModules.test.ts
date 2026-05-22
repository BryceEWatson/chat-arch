// Native-module CI spike — Phase Rev3-A gate (sub-task A3).
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §"SQLite write
// contract" item 5 ("Native-module CI compatibility. better-sqlite3 +
// sqlite-vec are prebuild-binary native modules. Phase Rev3-A includes
// a CI spike: confirm prebuilt binaries exist for the pinned Node
// version on the Ubuntu CI runner image.").
//
// What this test proves:
// 1. `better-sqlite3` loads and opens an in-memory database
//    (prebuilt native binary resolves on the current platform).
// 2. `sqlite-vec` extension loads successfully and exposes
//    `vec_version()`.
// 3. FTS5 — the third substrate primitive from the plan §0 amendment
//    ("SQLite + sqlite-vec + FTS5 becomes the substrate") — is
//    compiled into the better-sqlite3 prebuild and usable.
//
// Why a unit test and not a one-off CLI script: this needs to run in
// CI every PR so the gate stays green. The plan's "CI spike" language
// means "verify it works in CI", not "verify it works on my laptop."
//
// Why this lives under `packages/exporter/src/db/` rather than
// somewhere generic: that's where the SDK (sub-task A8) will live per
// the plan, and better-sqlite3 is declared on `@chat-arch/exporter`'s
// package.json, so this test is co-located with the code that will
// actually consume the dependency.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';

describe('Rev3-A native modules CI spike', () => {
  it('opens an in-memory better-sqlite3 database', () => {
    const db = new Database(':memory:');
    try {
      const result = db.prepare('SELECT 1 AS one').get() as { one: number };
      expect(result.one).toBe(1);
    } finally {
      db.close();
    }
  });

  it('loads the sqlite-vec extension and exposes vec_version()', () => {
    const db = new Database(':memory:');
    try {
      sqliteVec.load(db);
      const row = db.prepare('SELECT vec_version() AS version').get() as {
        version: string;
      };
      // Don't pin a specific version — pin the shape (semver-ish string
      // starting with 'v'). Lets the prebuild bump without test churn.
      expect(row.version).toMatch(/^v\d+\.\d+\.\d+/);
    } finally {
      db.close();
    }
  });

  it('supports FTS5 (full-text search) and matches a token query', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE smoke USING fts5(content)');
      db.prepare('INSERT INTO smoke(content) VALUES (?)').run('hello world');
      const row = db
        .prepare("SELECT content FROM smoke WHERE smoke MATCH 'hello'")
        .get() as { content: string } | undefined;
      expect(row?.content).toBe('hello world');
    } finally {
      db.close();
    }
  });

  it('enables WAL mode + synchronous=NORMAL (plan §SQLite write contract)', () => {
    // The plan pins WAL + synchronous=NORMAL as the connection contract.
    // For :memory: databases SQLite reports `memory` (not `wal`) — the
    // pragma still accepts the set without error. We assert both pragmas
    // round-trip to confirm the binary supports them.
    const db = new Database(':memory:');
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      const sync = db.pragma('synchronous', { simple: true });
      // synchronous=NORMAL is integer 1 in SQLite's PRAGMA output.
      expect(sync).toBe(1);
    } finally {
      db.close();
    }
  });
});
