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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Rev3-A native modules CI spike', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Per-test temp dir so the file-backed WAL case (below) can
    // open + journal + clean up without colliding with siblings.
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-native-modules-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

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

  it('enables WAL mode + synchronous=NORMAL on a file-backed DB (plan §SQLite write contract)', () => {
    // The plan pins WAL + synchronous=NORMAL as the connection contract.
    // MUST run against a file-backed DB: in-memory SQLite silently
    // ignores `journal_mode = WAL` (stays 'memory'), so a :memory: test
    // can't catch a runner missing WAL support. The whole point of the
    // CI compatibility gate is to verify the prebuild on the runner
    // actually exposes WAL, so use a tmp file.
    const dbPath = join(tmpDir, 'wal-spike.db');
    const db = new Database(dbPath);
    try {
      const journalMode = db.pragma('journal_mode = WAL', {
        simple: true,
      });
      expect(journalMode).toBe('wal');

      db.pragma('synchronous = NORMAL');
      const sync = db.pragma('synchronous', { simple: true });
      // synchronous=NORMAL is integer 1 in SQLite's PRAGMA output.
      expect(sync).toBe(1);
    } finally {
      db.close();
    }
  });
});
