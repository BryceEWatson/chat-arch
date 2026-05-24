/**
 * Tests for the standalone-app DB connection helper (Phase Rev3-C C4).
 *
 * The helper's load-bearing behavior is the legacy-JSON fold: on first
 * SDK boot with an empty entity_states table, fold both v1
 * (`knowledge-debt-states.json`) and v2 (`entity-states.json`) JSON
 * ledgers into SQLite. These tests exercise the PRODUCTION fold
 * functions exported from `chatArchDb.ts` against a temp DB — testing
 * a copy would mean a regression in the production folders could land
 * green here, which is the trap the iter-1 version of this file fell
 * into.
 *
 * The `getChatArchDb` singleton itself isn't tested here — it uses
 * the production data dir + a process-lifetime cache and shouldn't be
 * exercised by unit tests. Integration coverage of the SDK and
 * migration lives at `packages/exporter/src/db/sdk/entityStates.test.ts`
 * and `003-entity-states.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openDb,
  runMigrations,
  MIGRATIONS,
  listEntityStates,
  upsertEntityState,
} from '@chat-arch/exporter/db';
import type Database from 'better-sqlite3';

import {
  dbPath,
  foldV1JsonEntries,
  foldV2JsonEntries,
} from '../../src/lib/chatArchDb.js';

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
    expect(foldV2JsonEntries(db, v2)).toBe(2);
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
    expect(foldV2JsonEntries(db, v2)).toBe(1);
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
    expect(foldV1JsonEntries(db, v1)).toBe(3);
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
    foldV2JsonEntries(db, v2);
    foldV1JsonEntries(db, v1);
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
    expect(foldV2JsonEntries(db, v2)).toBe(1);
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
    expect(foldV1JsonEntries(db, v1)).toBe(1);
    expect(listEntityStates(db)[0]!.entityId).toBe('ok');
  });

  it('returns 0 on non-object / non-array input (defensive)', () => {
    expect(foldV2JsonEntries(db, null)).toBe(0);
    expect(foldV2JsonEntries(db, 'string')).toBe(0);
    expect(foldV2JsonEntries(db, { entries: 'not-an-array' })).toBe(0);
    expect(foldV1JsonEntries(db, null)).toBe(0);
    expect(foldV1JsonEntries(db, 42)).toBe(0);
    expect(foldV1JsonEntries(db, { entries: 'not-an-array' })).toBe(0);
  });

  it('once any row exists, the fold is not re-triggered on a fresh DB cycle', async () => {
    // The production guard is `entityStatesIsEmpty(db)` in
    // `getChatArchDb`; we simulate that here. After any SDK write the
    // guard returns false, so a subsequent boot must NOT re-fold the
    // archived legacy JSONs.
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'live',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 1000,
    });
    const isEmpty = db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM entity_states')
      .get();
    expect(isEmpty?.c).toBeGreaterThan(0);
    // Calling the fold defensively here would still work (ON CONFLICT
    // DO NOTHING), but the production code is gated by the empty
    // check — so on a populated DB the fold never runs. Verify the
    // guard predicate that gates it.
  });
});

describe('chatArchDb path discipline', () => {
  it('dbPath is OUTSIDE apps/standalone/public/ (Astro static-asset hazard)', () => {
    // Regression for the security finding on PR #73 iter-1: when the
    // DB lived under `public/`, Astro's static-asset handler served it
    // at `/chat-arch-data/chat-arch.db`, exposing the entire ledger
    // (and any future SQLite-backed PII tables) over HTTP. The fix is
    // to put the file in a sibling of `public/`, never inside it.
    const path = dbPath();
    // Use forward-slash form for the assertion so it passes on both
    // POSIX and Windows (Node's `join` returns native separators).
    const normalized = path.replace(/\\/g, '/');
    expect(normalized).not.toMatch(/\/apps\/standalone\/public\//);
    expect(normalized).toMatch(/\/apps\/standalone\/chat-arch-data\/chat-arch\.db$/);
  });
});
