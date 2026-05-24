/**
 * Phase Rev3-C C5 — gate test.
 *
 * Plan gate: "a surfaced Narrative can be dismissed and re-promoted
 * via the existing growth-multiplier mechanism."
 *
 * What this test exercises end-to-end on the entity-states substrate:
 *
 *   1. Validation helper (`validateEntityStateBody`) accepts a
 *      well-formed Narrative state change.
 *   2. SDK `upsertEntityState` persists the row with correct
 *      composite-key + dismissalCount semantics.
 *   3. SDK `listEntityStates` reads it back through the same wire
 *      shape the GET endpoint exposes.
 *   4. The growth-multiplier rule (defined in THRESHOLDS for
 *      knowledge-debt clusters in Wave 7 P2 #9, generalized to
 *      narratives by C1+C2) correctly flips a DISMISSED entry's
 *      *effective* state back to PENDING once
 *      `current_size >= sizeAtState * multiplier`.
 *   5. A fresh DISMISSED transition after the re-promotion increments
 *      the dismissalCount to 2 — confirming Closure-B saturation is
 *      observable across the round-trip.
 *
 * The test composes the same call paths the standalone POST + GET
 * handlers compose, against a temp DB. Doing it through HTTP
 * machinery would just add brittle mock-Request scaffolding; the
 * load-bearing surface is the validation + SDK + threshold rule, all
 * of which are pure functions or DB calls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { THRESHOLDS } from '@chat-arch/analysis';
import {
  MIGRATIONS,
  listEntityStates,
  openDb,
  runMigrations,
  upsertEntityState,
  type Database,
  type EntityStateRow,
  type EntityStateValue,
} from '@chat-arch/exporter/db';

import { validateEntityStateBody } from '../../src/pages/api/entity-states.js';

/**
 * Generalization of the knowledge-debt growth-multiplier rule (lives
 * in `InsightsMode.tsx` as `effectiveClusterState`) to narratives.
 * When DISMISSED, an entity re-promotes once its live size has grown
 * by ≥ `knowledgeDebtRepromotionGrowthMultiplier` × `sizeAtState`.
 * The same threshold is used for both kinds in Rev3-C until D1
 * introduces per-narrative saturation tuning.
 */
function effectiveState(
  persisted: { state: EntityStateValue; sizeAtState: number },
  currentSize: number,
): EntityStateValue {
  if (persisted.state !== 'DISMISSED') return persisted.state;
  const repromotionMin =
    persisted.sizeAtState *
    THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;
  if (currentSize >= repromotionMin && persisted.sizeAtState > 0) {
    return 'PENDING';
  }
  return 'DISMISSED';
}

describe('Rev3-C C5 — narrative dismiss → evidence-grows → re-promote round-trip', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rev3c-c5-round-trip-'));
    db = openDb(join(tmpDir, 'rev3c-c5.db'));
    runMigrations(db, MIGRATIONS);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('completes the full round-trip with correct state + counter semantics', async () => {
    const narrativeId = 'narrative-fixture-1';
    const baselineSize = 3;
    const grownSize =
      baselineSize *
      THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier;
    // ── Step 1: validate + persist initial PENDING state ─────────────
    const v1 = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: narrativeId,
      state: 'PENDING',
      sizeAtState: baselineSize,
    });
    expect('error' in v1).toBe(false);
    if ('error' in v1) throw new Error('unreachable');
    const row1 = await upsertEntityState(db, {
      entityKind: v1.entityKind,
      entityId: v1.entityId,
      state: v1.state,
      sizeAtState: v1.sizeAtState,
      updatedAt: 1000,
    });
    expect(row1.state).toBe('PENDING');
    expect(row1.dismissalCount).toBe(0);

    // ── Step 2: user dismisses ───────────────────────────────────────
    const v2 = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: narrativeId,
      state: 'DISMISSED',
      sizeAtState: baselineSize,
    });
    if ('error' in v2) throw new Error('unreachable');
    const row2 = await upsertEntityState(db, { ...v2, updatedAt: 2000 });
    expect(row2.state).toBe('DISMISSED');
    expect(row2.dismissalCount).toBe(1);

    // ── Step 3: GET-equivalent list shows the DISMISSED row ─────────
    const listed1 = listEntityStates(db);
    expect(listed1).toHaveLength(1);
    expect(listed1[0]!.entityId).toBe(narrativeId);
    expect(listed1[0]!.state).toBe('DISMISSED');
    expect(listed1[0]!.dismissalCount).toBe(1);

    // ── Step 4: growth-multiplier rule — below threshold stays DISMISSED
    const persistedAfterDismiss: Pick<EntityStateRow, 'state' | 'sizeAtState'> =
      { state: 'DISMISSED', sizeAtState: baselineSize };
    expect(
      effectiveState(persistedAfterDismiss, baselineSize),
    ).toBe('DISMISSED');
    expect(
      effectiveState(persistedAfterDismiss, baselineSize + 1),
    ).toBe('DISMISSED');

    // ── Step 5: growth-multiplier rule — at threshold re-promotes ──
    expect(effectiveState(persistedAfterDismiss, grownSize)).toBe('PENDING');
    expect(
      effectiveState(persistedAfterDismiss, grownSize + 100),
    ).toBe('PENDING');

    // ── Step 6: user re-promotes (POST PENDING with grown size) ─────
    //
    // This simulates the viewer (a) seeing the re-promoted effective
    // state from step 5 and (b) the user re-engaging — the next click
    // would write a fresh PENDING entry. The counter must PERSIST so
    // that Closure-B's per-narrative saturation rule (Phase Rev3-D)
    // has the history it needs.
    const v3 = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: narrativeId,
      state: 'PENDING',
      sizeAtState: grownSize,
    });
    if ('error' in v3) throw new Error('unreachable');
    const row3 = await upsertEntityState(db, { ...v3, updatedAt: 3000 });
    expect(row3.state).toBe('PENDING');
    expect(row3.dismissalCount).toBe(1); // PRESERVED across re-promotion

    // ── Step 7: user dismisses again — counter increments to 2 ──────
    const v4 = validateEntityStateBody({
      entityKind: 'narrative',
      entityId: narrativeId,
      state: 'DISMISSED',
      sizeAtState: grownSize,
    });
    if ('error' in v4) throw new Error('unreachable');
    const row4 = await upsertEntityState(db, { ...v4, updatedAt: 4000 });
    expect(row4.state).toBe('DISMISSED');
    expect(row4.dismissalCount).toBe(2);

    // ── Step 8: GET-equivalent final read confirms the durable state
    const listed2 = listEntityStates(db);
    expect(listed2).toHaveLength(1);
    expect(listed2[0]!.entityId).toBe(narrativeId);
    expect(listed2[0]!.state).toBe('DISMISSED');
    expect(listed2[0]!.sizeAtState).toBe(grownSize);
    expect(listed2[0]!.dismissalCount).toBe(2);
  });

  it('row stays composite-keyed across the round-trip (no narrative bleed)', async () => {
    // Two narratives, independent state transitions. Validates the
    // C1+C2 composite-key claim survives the full pipeline.
    const a = 'narrative-a';
    const b = 'narrative-b';

    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: a,
      state: 'DISMISSED',
      sizeAtState: 5,
      updatedAt: 1000,
    });
    await upsertEntityState(db, {
      entityKind: 'narrative',
      entityId: b,
      state: 'INSTALLED',
      sizeAtState: 8,
      updatedAt: 2000,
    });

    const listed = listEntityStates(db);
    expect(listed).toHaveLength(2);

    const byId = new Map(listed.map((r) => [r.entityId, r]));
    expect(byId.get(a)?.state).toBe('DISMISSED');
    expect(byId.get(a)?.dismissalCount).toBe(1);
    expect(byId.get(b)?.state).toBe('INSTALLED');
    expect(byId.get(b)?.dismissalCount).toBe(0);
  });

  it('round-trip works equivalently for knowledge-debt entityKind', async () => {
    // The same shape works for both kinds — verifies the C1+C2
    // generalization didn't introduce a kind-specific code path.
    const kdId = 'kd-cluster-1';

    await upsertEntityState(db, {
      entityKind: 'knowledge-debt',
      entityId: kdId,
      state: 'PENDING',
      sizeAtState: 4,
      updatedAt: 1000,
    });
    const dismissed = await upsertEntityState(db, {
      entityKind: 'knowledge-debt',
      entityId: kdId,
      state: 'DISMISSED',
      sizeAtState: 4,
      updatedAt: 2000,
    });
    expect(dismissed.dismissalCount).toBe(1);

    const persisted = { state: 'DISMISSED' as const, sizeAtState: 4 };
    expect(effectiveState(persisted, 4)).toBe('DISMISSED');
    expect(
      effectiveState(
        persisted,
        4 * THRESHOLDS.actionBanner.knowledgeDebtRepromotionGrowthMultiplier,
      ),
    ).toBe('PENDING');
  });
});
