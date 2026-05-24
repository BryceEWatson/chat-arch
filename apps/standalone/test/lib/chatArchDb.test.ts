/**
 * Tests for the standalone-app DB connection helper (Phase Rev3-C C4).
 *
 * The helper's load-bearing behavior is the legacy-JSON fold: on first
 * SDK boot with an empty entity_states table, fold both v1
 * (`knowledge-debt-states.json`) and v2 (`entity-states.json`) JSON
 * ledgers into SQLite. These tests exercise the fold functions
 * directly by setting up a temporary DB + JSON files and asserting
 * the resulting rows.
 *
 * The `getChatArchDb` singleton itself isn't tested here — it uses the
 * production data dir and shouldn't be exercised by unit tests.
 * Integration coverage lives at the SDK level
 * (`packages/exporter/src/db/sdk/entityStates.test.ts`) and the
 * migration level (`003-entity-states.test.ts`).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb, runMigrations, MIGRATIONS, listEntityStates } from '@chat-arch/exporter/db';
import type Database from 'better-sqlite3';

// Re-implementations of the two folder functions from chatArchDb.ts
// (kept private there). We test against a separate copy to keep the
// helper free of test-only exports; if the folders' semantics change,
// these tests should be updated to match.
//
// The functions exist for back-compat with two pre-existing JSON
// shapes. Once Phase Rev3-D ships, neither file will be written
// anymore — the folders become one-shot dead-data importers.

const KNOWN_STATES = new Set(['PENDING', 'INSTALLED', 'DISMISSED']);
const KNOWN_KINDS = new Set(['knowledge-debt', 'narrative']);

function foldV2(db: Database.Database, parsed: { entries?: unknown }): number {
  if (!Array.isArray(parsed.entries)) return 0;
  let folded = 0;
  for (const e of parsed.entries) {
    if (!e || typeof e !== 'object') continue;
    const ent = e as Record<string, unknown>;
    if (typeof ent.entityKind !== 'string' || !KNOWN_KINDS.has(ent.entityKind))
      continue;
    if (typeof ent.entityId !== 'string' || ent.entityId.length === 0) continue;
    if (typeof ent.state !== 'string' || !KNOWN_STATES.has(ent.state)) continue;
    if (typeof ent.updatedAt !== 'number' || !Number.isFinite(ent.updatedAt))
      continue;
    if (typeof ent.sizeAtState !== 'number' || !Number.isFinite(ent.sizeAtState))
      continue;
    const dismissalCount =
      typeof ent.dismissalCount === 'number' &&
      Number.isFinite(ent.dismissalCount) &&
      ent.dismissalCount >= 0
        ? ent.dismissalCount
        : ent.state === 'DISMISSED'
          ? 1
          : 0;
    db.prepare(
      `INSERT INTO entity_states
         (entity_kind, entity_id, state, updated_at, size_at_state, dismissal_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_kind, entity_id) DO NOTHING`,
    ).run(
      ent.entityKind,
      ent.entityId,
      ent.state,
      ent.updatedAt,
      ent.sizeAtState,
      dismissalCount,
    );
    folded += 1;
  }
  return folded;
}

function foldV1(db: Database.Database, parsed: { entries?: unknown }): number {
  if (!Array.isArray(parsed.entries)) return 0;
  let folded = 0;
  for (const e of parsed.entries) {
    if (!e || typeof e !== 'object') continue;
    const ent = e as Record<string, unknown>;
    if (typeof ent.clusterId !== 'string' || ent.clusterId.length === 0) continue;
    if (typeof ent.state !== 'string' || !KNOWN_STATES.has(ent.state)) continue;
    if (typeof ent.updatedAt !== 'number' || !Number.isFinite(ent.updatedAt))
      continue;
    if (typeof ent.sizeAtState !== 'number' || !Number.isFinite(ent.sizeAtState))
      continue;
    const dismissalCount = ent.state === 'DISMISSED' ? 1 : 0;
    db.prepare(
      `INSERT INTO entity_states
         (entity_kind, entity_id, state, updated_at, size_at_state, dismissal_count)
       VALUES ('knowledge-debt', ?, ?, ?, ?, ?)
       ON CONFLICT (entity_kind, entity_id) DO NOTHING`,
    ).run(
      ent.clusterId,
      ent.state,
      ent.updatedAt,
      ent.sizeAtState,
      dismissalCount,
    );
    folded += 1;
  }
  return folded;
}

describe('chatArchDb legacy JSON fold', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chat-arch-db-fold-'));
    db = openDb(join(dir, 'test.db'));
    runMigrations(db, MIGRATIONS);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('foldV2 ingests entries with preserved dismissalCount > 1', () => {
    const v2 = {
      schemaVersion: 2,
      generatedAt: 1000,
      entries: [
        {
          entityKind: 'narrative',
          entityId: 'n1',
          state: 'DISMISSED',
          updatedAt: 1000,
          sizeAtState: 5,
          dismissalCount: 3, // already re-promoted twice
        },
        {
          entityKind: 'knowledge-debt',
          entityId: 'k1',
          state: 'INSTALLED',
          updatedAt: 1200,
          sizeAtState: 8,
          // No dismissalCount → defaults to 0 for non-DISMISSED state.
        },
      ],
    };
    expect(foldV2(db, v2)).toBe(2);
    const list = listEntityStates(db);
    const byId = new Map(list.map((e) => [e.entityId, e]));
    expect(byId.get('n1')?.dismissalCount).toBe(3);
    expect(byId.get('k1')?.dismissalCount).toBe(0);
  });

  it('foldV2 defaults dismissalCount=1 for DISMISSED entries missing the field', () => {
    const v2 = {
      entries: [
        {
          entityKind: 'narrative',
          entityId: 'n1',
          state: 'DISMISSED',
          updatedAt: 1000,
          sizeAtState: 5,
          // no dismissalCount
        },
      ],
    };
    expect(foldV2(db, v2)).toBe(1);
    expect(listEntityStates(db)[0]!.dismissalCount).toBe(1);
  });

  it('foldV1 synthesizes entityKind=knowledge-debt + dismissalCount per state', () => {
    const v1 = {
      schemaVersion: 1,
      generatedAt: 1000,
      entries: [
        { clusterId: 'k-pending', state: 'PENDING', updatedAt: 1, sizeAtState: 2 },
        { clusterId: 'k-gone', state: 'DISMISSED', updatedAt: 2, sizeAtState: 5 },
        { clusterId: 'k-installed', state: 'INSTALLED', updatedAt: 3, sizeAtState: 7 },
      ],
    };
    expect(foldV1(db, v1)).toBe(3);
    const list = listEntityStates(db);
    expect(list.length).toBe(3);
    expect(list.every((e) => e.entityKind === 'knowledge-debt')).toBe(true);
    const byId = new Map(list.map((e) => [e.entityId, e]));
    expect(byId.get('k-pending')?.dismissalCount).toBe(0);
    expect(byId.get('k-gone')?.dismissalCount).toBe(1);
    expect(byId.get('k-installed')?.dismissalCount).toBe(0);
  });

  it('foldV1 + foldV2 are non-clobbering on collision (v2 wins via INSERT OR IGNORE order)', () => {
    // Apply v2 first; v1 then tries to insert under the same composite
    // key but the ON CONFLICT DO NOTHING clause preserves v2's row.
    const v2 = {
      entries: [
        {
          entityKind: 'knowledge-debt',
          entityId: 'shared',
          state: 'INSTALLED',
          updatedAt: 5000,
          sizeAtState: 99,
          dismissalCount: 0,
        },
      ],
    };
    const v1 = {
      entries: [
        { clusterId: 'shared', state: 'DISMISSED', updatedAt: 1, sizeAtState: 1 },
      ],
    };
    foldV2(db, v2);
    foldV1(db, v1);
    const list = listEntityStates(db);
    expect(list.length).toBe(1);
    expect(list[0]!.state).toBe('INSTALLED');
    expect(list[0]!.sizeAtState).toBe(99);
  });

  it('foldV2 drops malformed entries silently', () => {
    const v2 = {
      entries: [
        // valid
        {
          entityKind: 'narrative',
          entityId: 'ok',
          state: 'PENDING',
          updatedAt: 1,
          sizeAtState: 1,
        },
        // unknown kind
        {
          entityKind: 'pattern',
          entityId: 'x',
          state: 'PENDING',
          updatedAt: 1,
          sizeAtState: 1,
        },
        // unknown state
        {
          entityKind: 'narrative',
          entityId: 'y',
          state: 'WAT',
          updatedAt: 1,
          sizeAtState: 1,
        },
        // missing entityId
        {
          entityKind: 'narrative',
          state: 'PENDING',
          updatedAt: 1,
          sizeAtState: 1,
        },
      ],
    };
    expect(foldV2(db, v2)).toBe(1);
    expect(listEntityStates(db).length).toBe(1);
    expect(listEntityStates(db)[0]!.entityId).toBe('ok');
  });

  it('foldV1 drops malformed entries silently', () => {
    const v1 = {
      entries: [
        { clusterId: 'ok', state: 'PENDING', updatedAt: 1, sizeAtState: 1 },
        { clusterId: '', state: 'PENDING', updatedAt: 1, sizeAtState: 1 },
        { clusterId: 'bad-state', state: 'WAT', updatedAt: 1, sizeAtState: 1 },
        {
          clusterId: 'bad-size',
          state: 'PENDING',
          updatedAt: 1,
          sizeAtState: 'huge',
        },
      ],
    };
    expect(foldV1(db, v1)).toBe(1);
    expect(listEntityStates(db)[0]!.entityId).toBe('ok');
  });
});
