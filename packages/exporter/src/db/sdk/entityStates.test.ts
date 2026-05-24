// SDK round-trip tests for `entity_states` (Phase Rev3-C C4 foundation).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDb } from '../connection.js';
import { MIGRATIONS, runMigrations } from '../migrations/index.js';
import {
  deleteEntityState,
  getEntityState,
  listEntityStates,
  upsertEntityState,
} from './entityStates.js';

describe('entity_states SDK round-trip', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-es-sdk-test-'));
    db = openDb(join(tmpDir, 'es.db'));
    runMigrations(db, MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsert → get round-trips a new row with defaults', async () => {
    const fresh = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'PENDING',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    expect(fresh).toEqual({
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'PENDING',
      sizeAtState: 5,
      dismissalCount: 0,
      updatedAt: 1000,
    });
    expect(getEntityState(db, 'narrative', 'narr-1')).toEqual(fresh);
  });

  it('upsert updates an existing row (composite PK)', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'PENDING',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    const after = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'INSTALLED',
      sizeAtState: 6,
      updatedAt: 2000,
    });
    expect(after.state).toBe('INSTALLED');
    expect(after.sizeAtState).toBe(6);
    expect(after.updatedAt).toBe(2000);
    expect(after.dismissalCount).toBe(0); // no DISMISSED transition yet
    expect(listEntityStates(db)).toHaveLength(1);
  });

  it('auto-increments dismissalCount on PENDING/INSTALLED → DISMISSED transition', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'PENDING',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    const dismissed = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 2000,
    });
    expect(dismissed.dismissalCount).toBe(1);
  });

  it('does NOT increment dismissalCount on DISMISSED → DISMISSED self-transition', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    const stillDismissed = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 2000,
    });
    expect(stillDismissed.dismissalCount).toBe(1); // first write started at 1
  });

  it('Closure-B dismiss-then-revive-then-dismiss-again cycles counter', async () => {
    // First dismiss
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'PENDING',
      sizeAtState: 3,
      updatedAt: 1000,
    });
    let r = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 3,
      updatedAt: 2000,
    });
    expect(r.dismissalCount).toBe(1);

    // Revive (evidence grew → re-promote)
    r = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'PENDING',
      sizeAtState: 6,
      updatedAt: 3000,
    });
    expect(r.dismissalCount).toBe(1); // unchanged on non-DISMISSED transitions

    // Dismiss again
    r = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 6,
      updatedAt: 4000,
    });
    expect(r.dismissalCount).toBe(2);
  });

  it('explicit dismissalCount override bypasses auto-increment (JSON-import path)', async () => {
    const r = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 1000,
      dismissalCount: 4, // import-time value
    });
    expect(r.dismissalCount).toBe(4);
  });

  it('listEntityStates filters by kind + state', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'n1',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 1000,
    });
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'n2',
      state: 'DISMISSED',
      sizeAtState: 1,
      updatedAt: 1000,
    });
    await upsertEntityState(db, {
      entityKind: 'knowledge-debt',
      entityId: 'kd1',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 1000,
    });

    expect(listEntityStates(db)).toHaveLength(3);
    expect(listEntityStates(db, { kind: 'narrative' })).toHaveLength(2);
    expect(listEntityStates(db, { kind: 'knowledge-debt' })).toHaveLength(1);
    expect(listEntityStates(db, { state: 'PENDING' })).toHaveLength(2);
    expect(
      listEntityStates(db, { kind: 'narrative', state: 'DISMISSED' }),
    ).toHaveLength(1);
  });

  it('deleteEntityState removes the row and returns true; false on missing', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'n1',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 1000,
    });
    expect(await deleteEntityState(db, 'narrative', 'n1')).toBe(true);
    expect(await deleteEntityState(db, 'narrative', 'n1')).toBe(false);
    expect(getEntityState(db, 'narrative', 'n1')).toBeNull();
  });

  it('same entity_id under two kinds is independent (composite PK)', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'shared',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 1000,
    });
    await upsertEntityState(db, {
      entityKind: 'knowledge-debt',
      entityId: 'shared',
      state: 'INSTALLED',
      sizeAtState: 1,
      updatedAt: 2000,
    });
    const n = getEntityState(db, 'narrative', 'shared');
    const k = getEntityState(db, 'knowledge-debt', 'shared');
    expect(n?.state).toBe('PENDING');
    expect(k?.state).toBe('INSTALLED');
  });

  it('first-write DISMISSED starts dismissalCount at 1 (not 0)', async () => {
    const r = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'n1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    expect(r.dismissalCount).toBe(1);
  });
});
