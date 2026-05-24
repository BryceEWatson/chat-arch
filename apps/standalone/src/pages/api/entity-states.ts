/**
 * Rev3-C C4 — `/api/entity-states` endpoint, SQLite-backed.
 *
 * Persistence cutover from C1+C2: the v2 JSON sidecar
 * (`analysis/entity-states.json`) is no longer the source of truth.
 * All reads + writes go through the `entity_states` table via the
 * `@chat-arch/exporter/db` SDK. The legacy JSON files
 * (`knowledge-debt-states.json` v1 + `entity-states.json` v2) are
 * folded into the SQLite table on first DB access — see
 * `apps/standalone/src/lib/chatArchDb.ts` for the fold + move-aside.
 *
 * Endpoint shape:
 *   POST /api/entity-states  — upsert one entry. CSRF-gated +
 *     single-flight. Same body shape as PR #70.
 *   GET  /api/entity-states  — return the full ledger as
 *     `{ ok, available, entries: EntityStateEntry[] }`. The viewer's
 *     `loadEntityStates` client fetches this in place of the prior
 *     static JSON sidecar.
 *
 * The POST validator + composite-key semantics still live here
 * (pure functions, easy to unit-test); the SDK handles persistence
 * including the dismissalCount transition rule (same semantics as
 * the in-memory upsertEntityState that landed in C1+C2 iter-1).
 */

import type { APIRoute } from 'astro';

import {
  getChatArchDb,
} from '../../lib/chatArchDb.js';
import {
  listEntityStates,
  upsertEntityState,
  type EntityStateKind,
  type EntityStateRow,
  type EntityStateValue,
} from '@chat-arch/exporter/db';

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-entity-state';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

function csrfReject(reason: string): Response {
  return new Response(
    JSON.stringify({ ok: false, error: `Forbidden: ${reason}` }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  );
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let inFlight: Promise<Response> | null = null;

const KNOWN_KINDS: ReadonlySet<EntityStateKind> = new Set([
  'knowledge-debt',
  'narrative',
]);
const KNOWN_STATES: ReadonlySet<EntityStateValue> = new Set([
  'PENDING',
  'INSTALLED',
  'DISMISSED',
]);
const MAX_ID_LEN = 256;

export interface ValidatedEntityState {
  entityKind: EntityStateKind;
  entityId: string;
  state: EntityStateValue;
  sizeAtState: number;
}

export function validateEntityStateBody(
  body: unknown,
): ValidatedEntityState | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.entityKind !== 'string' ||
    !KNOWN_KINDS.has(b.entityKind as EntityStateKind)
  ) {
    return {
      error: `entityKind must be one of: ${[...KNOWN_KINDS].join(', ')}`,
    };
  }
  if (typeof b.entityId !== 'string' || b.entityId.length === 0) {
    return { error: 'entityId is required' };
  }
  if (b.entityId.length > MAX_ID_LEN) {
    return { error: `entityId exceeds ${MAX_ID_LEN} chars` };
  }
  if (
    typeof b.state !== 'string' ||
    !KNOWN_STATES.has(b.state as EntityStateValue)
  ) {
    return {
      error: `state must be one of: ${[...KNOWN_STATES].join(', ')}`,
    };
  }
  if (typeof b.sizeAtState !== 'number' || !Number.isFinite(b.sizeAtState)) {
    return { error: 'sizeAtState must be a finite number' };
  }
  return {
    entityKind: b.entityKind as EntityStateKind,
    entityId: b.entityId,
    state: b.state as EntityStateValue,
    sizeAtState: b.sizeAtState,
  };
}

/**
 * Snake_case-to-camelCase shape exposed to clients. The SDK already
 * returns camelCase; this just narrows the type for the wire format.
 */
function rowToWire(row: EntityStateRow): EntityStateRow {
  return row;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }
  if (inFlight) {
    return jsonResponse(
      {
        ok: false,
        error:
          'Another state change is already writing the ledger. Retry in a moment.',
      },
      409,
    );
  }

  let resolveSlot!: (r: Response) => void;
  const slot = new Promise<Response>((res) => {
    resolveSlot = res;
  });
  inFlight = slot;

  try {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      const r = badRequest('invalid JSON body');
      resolveSlot(r);
      return r;
    }
    const validation = validateEntityStateBody(parsed);
    if ('error' in validation) {
      const r = badRequest(validation.error);
      resolveSlot(r);
      return r;
    }
    try {
      const db = await getChatArchDb();
      const row = await upsertEntityState(db, {
        entityKind: validation.entityKind,
        entityId: validation.entityId,
        state: validation.state,
        sizeAtState: validation.sizeAtState,
        updatedAt: Date.now(),
      });
      const r = jsonResponse(
        { ok: true, entry: rowToWire(row) },
        200,
      );
      resolveSlot(r);
      return r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const r = jsonResponse({ ok: false, error: message }, 500);
      resolveSlot(r);
      return r;
    }
  } finally {
    if (inFlight === slot) inFlight = null;
  }
};

export const GET: APIRoute = async () => {
  // Always include `entries` so the viewer client doesn't need a
  // separate static fetch. The `available` field stays for legacy
  // health-check callers; the cost of always listing is bounded by
  // the table size, which never exceeds the user's count of touched
  // narratives + knowledge-debt clusters (low hundreds in steady
  // state, indexed by updated_at).
  try {
    const db = await getChatArchDb();
    const entries = listEntityStates(db).map(rowToWire);
    return jsonResponse({ ok: true, available: true, entries }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { ok: false, available: false, error: message, entries: [] },
      500,
    );
  }
};
