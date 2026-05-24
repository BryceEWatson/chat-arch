/**
 * Rev3-C C1+C2 — `/api/entity-states` endpoint.
 *
 * Generalizes the original `/api/knowledge-debt-state` ledger into a
 * shape that handles knowledge-debt clusters AND narratives under one
 * entry shape. Same CSRF + single-flight + atomic-write posture.
 * Ledger:
 *
 *   chat-arch-data/analysis/entity-states.json (v2)
 *
 * Composite key: (entityKind, entityId).
 *
 * Back-compat read: if `entity-states.json` is missing but the legacy
 * `knowledge-debt-states.json` exists on disk, its entries are folded
 * into the in-memory ledger with `entityKind: 'knowledge-debt'` and
 * `entityId = clusterId`. The legacy file is left in place; the first
 * write produces a fresh `entity-states.json` carrying both old and
 * new entries.
 */

import type { APIRoute } from 'astro';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

function standaloneDataDir(): string {
  return join(repoRoot(), 'apps', 'standalone', 'public', 'chat-arch-data');
}

export type EntityStateKind = 'knowledge-debt' | 'narrative';
export type EntityStateValue = 'PENDING' | 'INSTALLED' | 'DISMISSED';

export interface EntityStateEntry {
  entityKind: EntityStateKind;
  entityId: string;
  state: EntityStateValue;
  updatedAt: number;
  sizeAtState: number;
}

export interface EntityStatesFile {
  schemaVersion: 2;
  generatedAt: number;
  entries: EntityStateEntry[];
}

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

interface NodeFsError extends Error {
  code?: string;
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeFsError).code === 'ENOENT'
  );
}

export class EntityStateLedgerCorruptError extends Error {
  constructor(public readonly path: string, cause?: unknown) {
    super(
      `entity-states ledger appears corrupted at ${path}; refusing to overwrite.` +
        (cause instanceof Error ? ` ${cause.message}` : ''),
    );
    this.name = 'EntityStateLedgerCorruptError';
  }
}

/**
 * Legacy v1 entry shape from `knowledge-debt-states.json`. Defined
 * locally (not imported) so removing the legacy endpoint doesn't
 * couple the two files — they're related by file format only.
 */
interface LegacyClusterEntry {
  clusterId: unknown;
  state: unknown;
  updatedAt: unknown;
  sizeAtState: unknown;
}

/**
 * Fold a legacy v1 entry into a v2 entry. Returns null if the entry
 * is malformed; the load path drops such entries silently rather than
 * throwing on otherwise-readable legacy data.
 */
function migrateLegacyEntry(raw: LegacyClusterEntry): EntityStateEntry | null {
  if (typeof raw.clusterId !== 'string' || raw.clusterId.length === 0) return null;
  if (typeof raw.state !== 'string' || !KNOWN_STATES.has(raw.state as EntityStateValue)) {
    return null;
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;
  if (typeof raw.sizeAtState !== 'number' || !Number.isFinite(raw.sizeAtState)) {
    return null;
  }
  return {
    entityKind: 'knowledge-debt',
    entityId: raw.clusterId,
    state: raw.state as EntityStateValue,
    updatedAt: raw.updatedAt,
    sizeAtState: raw.sizeAtState,
  };
}

export async function loadEntityStatesLedger(
  ledgerPath: string,
  legacyPath: string,
): Promise<EntityStatesFile> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) {
      return await readLegacyLedger(legacyPath);
    }
    throw new EntityStateLedgerCorruptError(ledgerPath, err);
  }
  let parsed: Partial<EntityStatesFile> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<EntityStatesFile>;
  } catch (err) {
    throw new EntityStateLedgerCorruptError(ledgerPath, err);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new EntityStateLedgerCorruptError(ledgerPath);
  }
  return {
    schemaVersion: 2,
    generatedAt:
      typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(),
    entries: parsed.entries as EntityStateEntry[],
  };
}

async function readLegacyLedger(legacyPath: string): Promise<EntityStatesFile> {
  let raw: string;
  try {
    raw = await readFile(legacyPath, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) {
      return { schemaVersion: 2, generatedAt: Date.now(), entries: [] };
    }
    // Legacy ledger present but unreadable — surface as corrupt so the
    // user's prior state isn't silently dropped.
    throw new EntityStateLedgerCorruptError(legacyPath, err);
  }
  let parsed: { entries?: unknown; generatedAt?: unknown } | null = null;
  try {
    parsed = JSON.parse(raw) as { entries?: unknown; generatedAt?: unknown };
  } catch (err) {
    throw new EntityStateLedgerCorruptError(legacyPath, err);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new EntityStateLedgerCorruptError(legacyPath);
  }
  const migrated: EntityStateEntry[] = [];
  for (const e of parsed.entries) {
    const m = migrateLegacyEntry(e as LegacyClusterEntry);
    if (m !== null) migrated.push(m);
  }
  return {
    schemaVersion: 2,
    generatedAt:
      typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(),
    entries: migrated,
  };
}

async function atomicWriteEntityStatesLedger(
  ledgerPath: string,
  next: EntityStatesFile,
): Promise<void> {
  const tmpPath = join(
    dirname(ledgerPath),
    `.entity-states.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmpPath, ledgerPath);
}

/**
 * Upsert an entity-state entry keyed by (entityKind, entityId). Always
 * writes — re-clicks update `updatedAt` so the viewer can show the
 * most recent action.
 *
 * Exported for unit tests.
 */
export function upsertEntityState(
  prev: EntityStatesFile,
  payload: ValidatedEntityState,
  now: number,
): { next: EntityStatesFile; entry: EntityStateEntry } {
  const entry: EntityStateEntry = {
    entityKind: payload.entityKind,
    entityId: payload.entityId,
    state: payload.state,
    updatedAt: now,
    sizeAtState: payload.sizeAtState,
  };
  const existingIx = prev.entries.findIndex(
    (e) => e.entityKind === payload.entityKind && e.entityId === payload.entityId,
  );
  const entries =
    existingIx >= 0
      ? prev.entries.map((e, i) => (i === existingIx ? entry : e))
      : [...prev.entries, entry];
  const next: EntityStatesFile = {
    schemaVersion: 2,
    generatedAt: now,
    entries,
  };
  return { next, entry };
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
    const sidecarDir = join(standaloneDataDir(), 'analysis');
    const ledgerPath = join(sidecarDir, 'entity-states.json');
    const legacyPath = join(sidecarDir, 'knowledge-debt-states.json');
    try {
      await mkdir(sidecarDir, { recursive: true });
      const prev = await loadEntityStatesLedger(ledgerPath, legacyPath);
      const { next, entry } = upsertEntityState(prev, validation, Date.now());
      await atomicWriteEntityStatesLedger(ledgerPath, next);
      const r = jsonResponse(
        {
          ok: true,
          ledgerPath,
          entriesCount: next.entries.length,
          entry,
        },
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

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
