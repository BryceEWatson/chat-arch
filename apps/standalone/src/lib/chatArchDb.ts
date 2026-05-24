/**
 * Lazy connection helper for the standalone app's access to the
 * chat-arch SQLite substrate (Phase Rev3-C C4).
 *
 * Lifecycle:
 *
 *   - First call → open the DB at the canonical path, run pending
 *     migrations, fold any legacy `knowledge-debt-states.json` rows
 *     into the new `entity_states` table on first use, return the
 *     handle.
 *   - Subsequent calls → return the cached handle.
 *
 * Per-request opening was the alternative; rejected because the
 * legacy-JSON migration pass would re-run on every request (cheap but
 * a needless I/O probe), and process-lifetime caching matches how the
 * exporter pipeline already treats its own handles. `better-sqlite3`
 * keeps prepared-statement caches on the handle, so reuse is also
 * marginally faster.
 *
 * Astro's @astrojs/node adapter runs a single Node process per dev/
 * preview/start; the handle lives for the life of that process and
 * closes when the process exits (the OS reclaims FDs; the WAL file
 * is checkpointed on idle).
 */

import {
  openDb,
  runMigrations,
  MIGRATIONS,
  type Database,
} from '@chat-arch/exporter/db';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import type {
  EntityStateKind,
  EntityStateValue,
} from '@chat-arch/exporter/db';

let cachedDb: Database | null = null;
let initInFlight: Promise<Database> | null = null;

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..');
}

function dataDir(): string {
  return join(repoRoot(), 'apps', 'standalone', 'public', 'chat-arch-data');
}

function dbPath(): string {
  return join(dataDir(), 'chat-arch.db');
}

function v1LegacyLedgerPath(): string {
  return join(dataDir(), 'analysis', 'knowledge-debt-states.json');
}

function v2JsonLedgerPath(): string {
  return join(dataDir(), 'analysis', 'entity-states.json');
}

const KNOWN_STATES: ReadonlySet<EntityStateValue> = new Set([
  'PENDING',
  'INSTALLED',
  'DISMISSED',
]);
const KNOWN_KINDS: ReadonlySet<EntityStateKind> = new Set([
  'knowledge-debt',
  'narrative',
]);

async function safeReadJson(path: string): Promise<unknown> {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Best-effort move-aside: rename `path` to `path + ".migrated-to-sqlite"`
 * so a user inspecting the data dir post-migration can see what
 * happened. Falls back to unlink so the migration doesn't re-run.
 */
async function archiveAfterMigration(path: string): Promise<void> {
  const archivePath = path + '.migrated-to-sqlite';
  try {
    await rename(path, archivePath);
  } catch {
    try {
      await unlink(path);
    } catch {
      // Best-effort — the empty-table guard prevents re-fold on next
      // boot regardless of whether the file lingers.
    }
  }
}

/**
 * Fold the v2 JSON shape written by the C1+C2 endpoint (PR #70). Each
 * entry already carries `entityKind` + `dismissalCount`, so the fold
 * is straightforward — we just replay each entry as a single upsert.
 * Returns the count of folded entries (used to gate the move-aside).
 */
async function foldV2JsonLedger(db: Database): Promise<number> {
  const parsed = await safeReadJson(v2JsonLedgerPath());
  if (!parsed || typeof parsed !== 'object') return 0;
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return 0;

  let folded = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const ent = e as {
      entityKind?: unknown;
      entityId?: unknown;
      state?: unknown;
      updatedAt?: unknown;
      sizeAtState?: unknown;
      dismissalCount?: unknown;
    };
    if (
      typeof ent.entityKind !== 'string' ||
      !KNOWN_KINDS.has(ent.entityKind as EntityStateKind)
    ) {
      continue;
    }
    if (typeof ent.entityId !== 'string' || ent.entityId.length === 0) continue;
    if (
      typeof ent.state !== 'string' ||
      !KNOWN_STATES.has(ent.state as EntityStateValue)
    ) {
      continue;
    }
    if (typeof ent.updatedAt !== 'number' || !Number.isFinite(ent.updatedAt)) {
      continue;
    }
    if (
      typeof ent.sizeAtState !== 'number' ||
      !Number.isFinite(ent.sizeAtState)
    ) {
      continue;
    }
    // The upsert path's transition rule would set dismissalCount to 1
    // for any DISMISSED entry being folded — but the v2 JSON already
    // tracks the cumulative counter (possibly >1 across re-promotions).
    // Replay-via-upsert would clobber that history. Use a direct INSERT
    // to preserve the original counter when present and well-formed.
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
      ent.entityKind as string,
      ent.entityId,
      ent.state as string,
      ent.updatedAt,
      ent.sizeAtState,
      dismissalCount,
    );
    folded += 1;
  }
  return folded;
}

/**
 * Fold the v1 JSON shape written by the pre-C1+C2 endpoint
 * (knowledge-debt-states.json). v1 had only `clusterId` + cluster
 * semantics — synthesize `entityKind: 'knowledge-debt'`, default the
 * `dismissalCount` floor to 1 for DISMISSED entries and 0 otherwise
 * (matches the v1→v2 fallback path in PR #70's iter-1 fix).
 */
async function foldV1LegacyLedger(db: Database): Promise<number> {
  const parsed = await safeReadJson(v1LegacyLedgerPath());
  if (!parsed || typeof parsed !== 'object') return 0;
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return 0;

  let folded = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const ent = e as {
      clusterId?: unknown;
      state?: unknown;
      updatedAt?: unknown;
      sizeAtState?: unknown;
    };
    if (typeof ent.clusterId !== 'string' || ent.clusterId.length === 0) continue;
    if (
      typeof ent.state !== 'string' ||
      !KNOWN_STATES.has(ent.state as EntityStateValue)
    ) {
      continue;
    }
    if (typeof ent.updatedAt !== 'number' || !Number.isFinite(ent.updatedAt)) {
      continue;
    }
    if (
      typeof ent.sizeAtState !== 'number' ||
      !Number.isFinite(ent.sizeAtState)
    ) {
      continue;
    }
    const dismissalCount = ent.state === 'DISMISSED' ? 1 : 0;
    db.prepare(
      `INSERT INTO entity_states
         (entity_kind, entity_id, state, updated_at, size_at_state, dismissal_count)
       VALUES ('knowledge-debt', ?, ?, ?, ?, ?)
       ON CONFLICT (entity_kind, entity_id) DO NOTHING`,
    ).run(
      ent.clusterId,
      ent.state as string,
      ent.updatedAt,
      ent.sizeAtState,
      dismissalCount,
    );
    folded += 1;
  }
  return folded;
}

/**
 * One-shot legacy JSON fold. Called when `entity_states` is empty.
 * Tries v2 JSON first (newer + has the cumulative counter); v1 JSON
 * fills any holes. Both files are moved aside on success so a
 * subsequent boot doesn't re-fold and the data dir stays auditable.
 */
async function migrateLegacyJsonIfPresent(db: Database): Promise<void> {
  const v2Folded = await foldV2JsonLedger(db);
  const v1Folded = await foldV1LegacyLedger(db);
  if (v2Folded > 0) await archiveAfterMigration(v2JsonLedgerPath());
  if (v1Folded > 0) await archiveAfterMigration(v1LegacyLedgerPath());
}

function entityStatesIsEmpty(db: Database): boolean {
  const row = db
    .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM entity_states')
    .get();
  return (row?.c ?? 0) === 0;
}

/**
 * Get the cached DB handle, creating + migrating it on first call.
 *
 * Concurrent first-callers share the same init promise so the
 * migration / legacy-fold sequence runs exactly once even under
 * request fan-out.
 */
export async function getChatArchDb(): Promise<Database> {
  if (cachedDb !== null) return cachedDb;
  if (initInFlight !== null) return initInFlight;

  initInFlight = (async () => {
    await mkdir(dataDir(), { recursive: true });
    const db = openDb(dbPath());
    runMigrations(db, MIGRATIONS);
    if (entityStatesIsEmpty(db)) {
      await migrateLegacyJsonIfPresent(db);
    }
    cachedDb = db;
    initInFlight = null;
    return db;
  })();

  return initInFlight;
}

/**
 * Test hook — close + drop the cached handle. The next `getChatArchDb`
 * call will re-open and re-run migrations. Production callers don't
 * need this; process-exit cleans up.
 */
export function _resetChatArchDbForTests(): void {
  if (cachedDb !== null) {
    try {
      cachedDb.close();
    } catch {
      // Already closed — ignore.
    }
    cachedDb = null;
  }
  initInFlight = null;
}
