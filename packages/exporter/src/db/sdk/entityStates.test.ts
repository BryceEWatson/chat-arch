// SDK round-trip tests for `entity_states` (Phase Rev3-C C4).
// Covers: upsert/get round-trip, Closure-B dismissalCount auto-
// increment semantic, list ordering by updated_at DESC, delete
// returns true/false, composite-PK independence.

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

  it('upsert → get round-trips a new row with default dismissalCount=0', async () => {
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

  it('upsert updates an existing row in-place (composite PK)', async () => {
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

  it('does NOT re-increment on DISMISSED → DISMISSED re-click', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'PENDING',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 2000,
    });
    const stillDismissed = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 3000,
    });
    expect(stillDismissed.dismissalCount).toBe(1);
  });

  it('Closure-B dismiss → revive → re-dismiss cycle increments correctly', async () => {
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

    // Revive (evidence grew → re-promote to PENDING)
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

  it('first-write DISMISSED starts dismissalCount at 1 (no prior to be non-DISMISSED)', async () => {
    const r = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'narr-1',
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    // `prior?.state !== 'DISMISSED'` is true when prior is null too,
    // so first-write DISMISSED is treated as a fresh dismissal → +1.
    expect(r.dismissalCount).toBe(1);
  });

  it('listEntityStates orders most-recently-updated first', async () => {
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
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 3000,
    });
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'n3',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 2000,
    });
    const ids = listEntityStates(db).map((r) => r.entityId);
    expect(ids).toEqual(['n2', 'n3', 'n1']);
  });

  it('listEntityStates filters by entityKind', async () => {
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: 'n1',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 1000,
    });
    await upsertEntityState(db, {
      entityKind: 'knowledge-debt',
      entityId: 'kd1',
      state: 'PENDING',
      sizeAtState: 1,
      updatedAt: 2000,
    });
    expect(listEntityStates(db)).toHaveLength(2);
    expect(listEntityStates(db, { entityKind: 'narrative' })).toEqual([
      expect.objectContaining({ entityId: 'n1' }),
    ]);
    expect(listEntityStates(db, { entityKind: 'knowledge-debt' })).toEqual([
      expect.objectContaining({ entityId: 'kd1' }),
    ]);
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
});
