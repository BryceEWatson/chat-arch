// `entity_states` table SDK (Phase Rev3-C C4).
//
// Backs the unified entity-states ledger introduced in Rev3-C C1+C2
// (PR #70) — knowledge-debt clusters AND narratives share one shape
// with composite key `(entity_kind, entity_id)`. JSON sidecar
// (`analysis/entity-states.json`) goes away as the source of truth;
// SQLite is authoritative going forward.
//
// Mirrors the v2 JSON shape exactly:
//   entityKind     ∈ {'knowledge-debt', 'narrative'}
//   entityId       string ≤ 256 chars
//   state          ∈ {'PENDING', 'INSTALLED', 'DISMISSED'}
//   updatedAt      ms since epoch
//   sizeAtState    snapshot of the entity's "size" at upsert time
//   dismissalCount Closure-B counter, incremented on transitions INTO
//                  DISMISSED from a non-DISMISSED state. Re-clicks on
//                  DISMISSED preserve the count.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';

export type EntityStateKind = 'knowledge-debt' | 'narrative';
export type EntityStateValue = 'PENDING' | 'INSTALLED' | 'DISMISSED';

export interface EntityStateRow {
  readonly entityKind: EntityStateKind;
  readonly entityId: string;
  readonly state: EntityStateValue;
  readonly updatedAt: number;
  readonly sizeAtState: number;
  readonly dismissalCount: number;
}

interface RawEntityStateRow {
  readonly entity_kind: EntityStateKind;
  readonly entity_id: string;
  readonly state: EntityStateValue;
  readonly updated_at: number;
  readonly size_at_state: number;
  readonly dismissal_count: number;
}

function rowFromRaw(raw: RawEntityStateRow): EntityStateRow {
  return {
    entityKind: raw.entity_kind,
    entityId: raw.entity_id,
    state: raw.state,
    updatedAt: raw.updated_at,
    sizeAtState: raw.size_at_state,
    dismissalCount: raw.dismissal_count,
  };
}

const SELECT_COLUMNS =
  'entity_kind, entity_id, state, updated_at, size_at_state, dismissal_count';

export function getEntityState(
  db: Database,
  entityKind: EntityStateKind,
  entityId: string,
): EntityStateRow | null {
  const raw = db
    .prepare<[EntityStateKind, string], RawEntityStateRow>(
      `SELECT ${SELECT_COLUMNS} FROM entity_states WHERE entity_kind = ? AND entity_id = ?`,
    )
    .get(entityKind, entityId);
  return raw ? rowFromRaw(raw) : null;
}

export interface ListEntityStatesFilter {
  readonly entityKind?: EntityStateKind;
}

/**
 * List entries, most-recently-updated first. The `idx_entity_states_updated_at`
 * index makes this O(log n) regardless of table size.
 */
export function listEntityStates(
  db: Database,
  filter: ListEntityStatesFilter = {},
): readonly EntityStateRow[] {
  const where = filter.entityKind !== undefined ? ' WHERE entity_kind = ?' : '';
  const args = filter.entityKind !== undefined ? [filter.entityKind] : [];
  const sql = `SELECT ${SELECT_COLUMNS} FROM entity_states${where} ORDER BY updated_at DESC, entity_kind, entity_id`;
  const rows = db.prepare<unknown[], RawEntityStateRow>(sql).all(...args);
  return rows.map(rowFromRaw);
}

export interface UpsertEntityStateInput {
  readonly entityKind: EntityStateKind;
  readonly entityId: string;
  readonly state: EntityStateValue;
  readonly sizeAtState: number;
  readonly updatedAt: number;
}

/**
 * Upsert an entry keyed by `(entityKind, entityId)`. Tracks
 * `dismissalCount` per the Closure-B semantics:
 *
 *   - first write OR transition INTO `DISMISSED` from a non-DISMISSED
 *     state → counter += 1
 *   - any other transition (incl. re-click on already-DISMISSED) →
 *     counter preserved
 *
 * The whole upsert runs inside a single `BEGIN IMMEDIATE` so the read
 * of the prior state and the write of the new state cannot be torn by
 * a concurrent writer.
 */
export async function upsertEntityState(
  db: Database,
  input: UpsertEntityStateInput,
): Promise<EntityStateRow> {
  return withWriteTransaction(db, (tx) => {
    const prior = getEntityState(tx, input.entityKind, input.entityId);
    const priorCount = prior?.dismissalCount ?? 0;
    const isFreshDismissal =
      input.state === 'DISMISSED' && prior?.state !== 'DISMISSED';
    const dismissalCount = isFreshDismissal ? priorCount + 1 : priorCount;

    tx.prepare(
      `INSERT INTO entity_states
         (entity_kind, entity_id, state, updated_at, size_at_state, dismissal_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at,
         size_at_state = excluded.size_at_state,
         dismissal_count = excluded.dismissal_count`,
    ).run(
      input.entityKind,
      input.entityId,
      input.state,
      input.updatedAt,
      input.sizeAtState,
      dismissalCount,
    );

    const fresh = getEntityState(tx, input.entityKind, input.entityId);
    if (!fresh) {
      throw new Error(
        `entity_states row vanished mid-transaction (kind=${input.entityKind}, id=${input.entityId})`,
      );
    }
    return fresh;
  });
}

export async function deleteEntityState(
  db: Database,
  entityKind: EntityStateKind,
  entityId: string,
): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(
        'DELETE FROM entity_states WHERE entity_kind = ? AND entity_id = ?',
      )
      .run(entityKind, entityId);
    return info.changes > 0;
  });
}
