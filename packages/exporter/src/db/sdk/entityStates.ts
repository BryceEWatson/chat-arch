// `entity_states` table SDK (Phase Rev3-C C4 foundation).
//
// Generalized dismiss-state ledger covering both knowledge-debt
// clusters and Narratives. Schema lives in
// `packages/exporter/src/db/migrations/003-entity-states.ts`.
//
// The matching legacy JSON shape is in
// `apps/standalone/src/pages/api/entity-states.ts:EntityStateEntry`
// (and its v1 predecessor `knowledge-debt-states.json`). When the API
// rewires to use this SDK (follow-on PR), it'll do a one-shot import
// of any existing JSON ledger entries before switching to SQLite as
// the source of truth.

import type { Database } from 'better-sqlite3';

import { withWriteTransaction } from '../transaction.js';

export type EntityStateKind = 'knowledge-debt' | 'narrative';
export type EntityStateValue = 'PENDING' | 'INSTALLED' | 'DISMISSED';

export interface EntityStateRow {
  readonly entityKind: EntityStateKind;
  readonly entityId: string;
  readonly state: EntityStateValue;
  readonly sizeAtState: number;
  readonly dismissalCount: number;
  /** Unix ms since epoch. */
  readonly updatedAt: number;
}

interface RawEntityStateRow {
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly state: string;
  readonly size_at_state: number;
  readonly dismissal_count: number;
  readonly updated_at: number;
}

function rowFromRaw(raw: RawEntityStateRow): EntityStateRow {
  return {
    entityKind: raw.entity_kind as EntityStateKind,
    entityId: raw.entity_id,
    state: raw.state as EntityStateValue,
    sizeAtState: raw.size_at_state,
    dismissalCount: raw.dismissal_count,
    updatedAt: raw.updated_at,
  };
}

const SELECT_COLUMNS =
  'entity_kind, entity_id, state, size_at_state, dismissal_count, updated_at';

export function getEntityState(
  db: Database,
  kind: EntityStateKind,
  entityId: string,
): EntityStateRow | null {
  const raw = db
    .prepare<[string, string], RawEntityStateRow>(
      `SELECT ${SELECT_COLUMNS} FROM entity_states WHERE entity_kind = ? AND entity_id = ?`,
    )
    .get(kind, entityId);
  return raw ? rowFromRaw(raw) : null;
}

export interface ListEntityStatesFilter {
  readonly kind?: EntityStateKind;
  readonly state?: EntityStateValue;
}

export function listEntityStates(
  db: Database,
  filter: ListEntityStatesFilter = {},
): readonly EntityStateRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.kind !== undefined) {
    where.push('entity_kind = ?');
    args.push(filter.kind);
  }
  if (filter.state !== undefined) {
    where.push('state = ?');
    args.push(filter.state);
  }
  const whereClause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  const sql = `SELECT ${SELECT_COLUMNS} FROM entity_states${whereClause} ORDER BY entity_kind, entity_id`;
  return db
    .prepare<unknown[], RawEntityStateRow>(sql)
    .all(...args)
    .map(rowFromRaw);
}

export interface UpsertEntityStateInput {
  readonly entityKind: EntityStateKind;
  readonly entityId: string;
  readonly state: EntityStateValue;
  readonly sizeAtState: number;
  readonly updatedAt: number;
  /**
   * Optional explicit override. When absent the upsert increments the
   * existing row's `dismissal_count` by 1 if (and only if) the new
   * state is `DISMISSED` AND the previous state was non-DISMISSED.
   * Setting an explicit value bypasses the auto-increment (useful
   * for the JSON-→-SQLite import path that preserves prior counts).
   */
  readonly dismissalCount?: number;
}

/**
 * Insert or update an entity-state row. Returns the resulting row.
 *
 * Auto-increments `dismissal_count` on the PENDING/INSTALLED →
 * DISMISSED transition (Closure B per `narrativeRung.dismissDecay`).
 * Pass `dismissalCount` explicitly to override.
 */
export async function upsertEntityState(
  db: Database,
  input: UpsertEntityStateInput,
): Promise<EntityStateRow> {
  return withWriteTransaction(db, (tx) => {
    let nextDismissalCount: number;
    if (input.dismissalCount !== undefined) {
      nextDismissalCount = input.dismissalCount;
    } else {
      const prev = tx
        .prepare<[string, string], { state: string; dismissal_count: number }>(
          `SELECT state, dismissal_count FROM entity_states WHERE entity_kind = ? AND entity_id = ?`,
        )
        .get(input.entityKind, input.entityId);
      if (!prev) {
        // First write — start at 0 (or 1 if the first state IS DISMISSED).
        nextDismissalCount = input.state === 'DISMISSED' ? 1 : 0;
      } else if (input.state === 'DISMISSED' && prev.state !== 'DISMISSED') {
        nextDismissalCount = prev.dismissal_count + 1;
      } else {
        nextDismissalCount = prev.dismissal_count;
      }
    }
    tx.prepare(
      `INSERT INTO entity_states
         (entity_kind, entity_id, state, size_at_state, dismissal_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
         state = excluded.state,
         size_at_state = excluded.size_at_state,
         dismissal_count = excluded.dismissal_count,
         updated_at = excluded.updated_at`,
    ).run(
      input.entityKind,
      input.entityId,
      input.state,
      input.sizeAtState,
      nextDismissalCount,
      input.updatedAt,
    );
    const fresh = getEntityState(tx, input.entityKind, input.entityId);
    if (!fresh) {
      // Shouldn't happen — we just upserted.
      throw new Error(
        `entity_states row vanished mid-transaction (${input.entityKind}, ${input.entityId})`,
      );
    }
    return fresh;
  });
}

export async function deleteEntityState(
  db: Database,
  kind: EntityStateKind,
  entityId: string,
): Promise<boolean> {
  return withWriteTransaction(db, (tx) => {
    const info = tx
      .prepare(
        'DELETE FROM entity_states WHERE entity_kind = ? AND entity_id = ?',
      )
      .run(kind, entityId);
    return info.changes > 0;
  });
}
