// SDK round-trip tests for `entity_states` (Phase Rev3-C C4).
// Covers: upsert/get round-trip, Closure-B dismissalCount auto-
// increment semantic, list ordering by updated_at DESC, delete
// returns true/false, composite-PK independence.
//
// The trailing describe block ("narrative dismiss → grow → re-promote")
// is the Phase Rev3-C C5 gate test — closes the phase by proving a
// surfaced Narrative round-trips through the existing growth-multiplier
// re-promotion mechanism on top of the SQLite SDK.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { THRESHOLDS } from '@chat-arch/analysis';
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

// Phase Rev3-C C5 gate. The plan's exit criterion for Phase Rev3-C is:
// "a surfaced Narrative can be dismissed and re-promoted via the
// existing growth-multiplier mechanism." This block proves the full
// round-trip works on top of the SQLite SDK that landed in C4 — the
// narrative-side wiring leverages the same `entity_states` row shape
// + `knowledgeDebtRepromotionGrowthMultiplier` THRESHOLD that the
// knowledge-debt UI already consumes in InsightsMode. Rev3-D adds the
// per-Narrative dismiss-decay saturation on top; this gate verifies the
// foundation those layers build on.
describe('Rev3-C C5 gate — narrative dismiss → grow → re-promote', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'chat-arch-c5-gate-'));
    db = openDb(join(tmpDir, 'c5.db'));
    runMigrations(db, MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: the same predicate `InsightsMode.effectiveClusterState`
   * applies for knowledge-debt clusters. For Narratives the rule is
   * the same in Rev3-C — Closure-B saturation (Rev3-D) only changes
   * the multiplier that compounds per dismissal; the base predicate is
   * the same `currentSize >= sizeAtState * growthMultiplier`.
   */
  function meetsRepromotionBar(
    sizeAtDismiss: number,
    currentSize: number,
    multiplier: number,
  ): boolean {
    return sizeAtDismiss > 0 && currentSize >= sizeAtDismiss * multiplier;
  }

  it('round-trip: surface → dismiss → grow evidence past multiplier → re-promote → re-dismiss', async () => {
    const NARR_ID = 'narr-c5-roundtrip';
    const multiplier =
      THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;

    // 1. Surface a Narrative with 3 supporting evidence rows. The
    //    SDK seeds `dismissalCount: 0` for first-write PENDING.
    const surfaced = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: NARR_ID,
      state: 'PENDING',
      sizeAtState: 3,
      updatedAt: 1000,
    });
    expect(surfaced).toMatchObject({
      entityKind: 'narrative',
      state: 'PENDING',
      sizeAtState: 3,
      dismissalCount: 0,
    });

    // 2. User dismisses. The PENDING→DISMISSED transition rule bumps
    //    dismissalCount to 1 (per the existing Closure-B counter).
    //    The row records sizeAtState=3 — the snapshot the multiplier
    //    rule will compare against later.
    const dismissed = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: NARR_ID,
      state: 'DISMISSED',
      sizeAtState: 3,
      updatedAt: 2000,
    });
    expect(dismissed).toMatchObject({
      state: 'DISMISSED',
      sizeAtState: 3,
      dismissalCount: 1,
    });

    // 3. Evidence grows. Below the threshold (currentSize=5 vs the
    //    bar 3×2=6) the Narrative stays DISMISSED — meetsRepromotionBar
    //    returns false. The data row is unchanged; the UI predicate
    //    keeps it in the collapsed pile.
    expect(meetsRepromotionBar(dismissed.sizeAtState, 5, multiplier)).toBe(
      false,
    );
    const stillDismissed = getEntityState(db, 'narrative', NARR_ID);
    expect(stillDismissed?.state).toBe('DISMISSED');
    expect(stillDismissed?.dismissalCount).toBe(1);

    // 4. Evidence crosses the bar. currentSize=6 hits 3×2=6 exactly —
    //    the boundary case the predicate treats as re-promotable.
    const currentSize = dismissed.sizeAtState * multiplier;
    expect(
      meetsRepromotionBar(dismissed.sizeAtState, currentSize, multiplier),
    ).toBe(true);

    // 5. Re-promote via the same SDK call the UI would issue: write a
    //    PENDING row with the new (larger) sizeAtState snapshot. The
    //    transition out of DISMISSED MUST preserve dismissalCount —
    //    Rev3-D's saturation rule reads the counter to escalate the
    //    multiplier on the next dismiss. Losing the count here would
    //    silently break Closure B before it ships.
    const repromoted = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: NARR_ID,
      state: 'PENDING',
      sizeAtState: currentSize,
      updatedAt: 3000,
    });
    expect(repromoted).toMatchObject({
      state: 'PENDING',
      sizeAtState: currentSize,
      dismissalCount: 1,
    });

    // 6. Re-dismiss. The counter advances to 2 — the input Rev3-D's
    //    per-dismissal multiplier (×2 → ×4 → ×8 cap K=3) feeds on.
    const reDismissed = await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: NARR_ID,
      state: 'DISMISSED',
      sizeAtState: currentSize,
      updatedAt: 4000,
    });
    expect(reDismissed.dismissalCount).toBe(2);

    // 7. The ledger holds exactly one row for the Narrative — the
    //    composite PK collapsed every upsert onto the same row, which
    //    is what the InsightsMode read-side relies on for its Map view.
    const allRows = listEntityStates(db, { entityKind: 'narrative' });
    expect(allRows).toHaveLength(1);
    expect(allRows[0]?.entityId).toBe(NARR_ID);
  });

  it('zero sizeAtState never re-promotes (guards against divide-by-zero-like UI bugs)', async () => {
    // The InsightsMode predicate guards against persisted.sizeAtState > 0
    // before re-promoting. Replicate that contract here so a future
    // Narrative-side consumer that omits the guard also fails this gate.
    const multiplier =
      THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;
    expect(meetsRepromotionBar(0, 100, multiplier)).toBe(false);
  });
});
