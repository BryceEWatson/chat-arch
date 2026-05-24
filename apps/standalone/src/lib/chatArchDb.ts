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
 *
 * Path discipline: the SQLite file lives in `apps/standalone/
 * chat-arch-data/` — a SIBLING of `public/`, NEVER inside it. Astro
 * serves `public/` as static assets at the URL root, so a DB under
 * `public/chat-arch-data/` would be reachable at `/chat-arch-data/
 * chat-arch.db` and expose the entire ledger (plus any future
 * SQLite-backed PII tables) to anyone who can reach the dev server.
 * The legacy JSON sidecars stay in `public/` because the viewer
 * fetches them via static GET; the binary DB does not need to be
 * web-reachable.
 */

import {
  backfillNarrativeProvenance,
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

function dbDir(): string {
  return join(repoRoot(), 'apps', 'standalone', 'chat-arch-data');
}

export function dbPath(): string {
  return join(dbDir(), 'chat-arch.db');
}

function legacyDbPath(): string {
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
 * Fold a v2-shape parsed JSON ledger into the SQLite `entity_states`
 * table. Each entry already carries `entityKind` + `dismissalCount`,
 * so the fold is straightforward — we just replay each entry as a
 * single INSERT … ON CONFLICT DO NOTHING. Exported so the test file
 * can exercise the same code path the production wrapper calls.
 *
 * Why a direct INSERT instead of `upsertEntityState`: the SDK's
 * transition rule would re-set dismissalCount to 1 for any DISMISSED
 * entry being folded — but the v2 JSON already tracks the cumulative
 * counter (possibly >1 across re-promotions). Replay-via-upsert
 * would clobber that history.
 */
export function foldV2JsonEntries(db: Database, parsed: unknown): number {
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
 * Fold a v1-shape parsed JSON ledger. v1 had only `clusterId` +
 * cluster semantics — synthesize `entityKind: 'knowledge-debt'`,
 * default the `dismissalCount` floor to 1 for DISMISSED entries and 0
 * otherwise (matches the v1→v2 fallback path in PR #70's iter-1 fix).
 */
export function foldV1JsonEntries(db: Database, parsed: unknown): number {
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
  const v2Folded = foldV2JsonEntries(db, await safeReadJson(v2JsonLedgerPath()));
  const v1Folded = foldV1JsonEntries(db, await safeReadJson(v1LegacyLedgerPath()));
  if (v2Folded > 0) await archiveAfterMigration(v2JsonLedgerPath());
  if (v1Folded > 0) await archiveAfterMigration(v1LegacyLedgerPath());
}

/**
 * Best-effort relocation of a SQLite DB that landed at the previous
 * (vulnerable) path under `public/`. Anyone who ran an earlier build
 * of this branch has populated rows at the old location; opening a
 * fresh DB at the new path would orphan them. Moves the main file +
 * the WAL + SHM siblings if present. Skipped if the new path already
 * holds a DB (keeps the new state authoritative).
 */
async function relocateLegacyDbIfPresent(): Promise<void> {
  const legacy = legacyDbPath();
  const target = dbPath();
  // Two cases:
  //   1. target empty + legacy present → relocate (one-shot move).
  //   2. target non-empty + legacy present → UNLINK the legacy file
  //      unconditionally. Per the final review-loop on rev3-start..
  //      main: if a chat-arch.db (or .db-wal / .db-shm) is ever re-
  //      introduced under `public/chat-arch-data/` (restored backup,
  //      external tool, mismatched branch checkout), Astro would
  //      serve the entire entity-states ledger at /chat-arch-data/
  //      chat-arch.db until the new-path DB is wiped. The Rev3-A.A2
  //      gitignore + Rev3-C.C4 security promise protects against
  //      repo accidents; this runtime unlink protects against fresh
  //      drops at boot time.
  const relocate = existsSync(legacy) && !existsSync(target);
  for (const suffix of ['', '-wal', '-shm']) {
    const src = legacy + suffix;
    const dst = target + suffix;
    if (!existsSync(src)) continue;
    if (relocate) {
      try {
        await rename(src, dst);
      } catch {
        // Rename failed (cross-device, in-use). Fall through to
        // unlink — better to drop the legacy data than to keep
        // serving it from public/.
        try {
          await unlink(src);
        } catch {
          // Best-effort: log silently. The .gitignore wildcard
          // prevents accidental commits.
        }
      }
    } else {
      try {
        await unlink(src);
      } catch {
        // As above — best-effort.
      }
    }
  }
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
    await mkdir(dbDir(), { recursive: true });
    await relocateLegacyDbIfPresent();
    const db = openDb(dbPath());
    runMigrations(db, MIGRATIONS);
    if (entityStatesIsEmpty(db)) {
      await migrateLegacyJsonIfPresent(db);
    }
    // B5 backfill — promotes any v1 narratives to v2 with default-
    // prior provenance. Idempotent (SELECT WHERE schema_version=1
    // filter); cheap when the table is empty or already-v2.
    // Per the final review-loop on rev3-start..main: this was dead
    // code (kernel + tests existed but no production caller), so the
    // B5 plan promise ("auto-promote v1→v2 on first DB access") was
    // structurally unfulfilled.
    await backfillNarrativeProvenance(db);
    cachedDb = db;
    initInFlight = null;
    return db;
  })();

  return initInFlight;
}

/**
 * Close + drop the cached handle. The next `getChatArchDb` call will
 * re-open and re-run migrations. Used by:
 *   - Test code (formerly named `_resetChatArchDbForTests`; aliased
 *     below for back-compat with existing tests).
 *   - The `/api/clear` POST handler, which calls this before
 *     `wipeSqliteDbFiles` so a stale handle doesn't hold the DB file
 *     open while we delete it (matters on Windows where open files
 *     can't be unlinked).
 */
export function closeChatArchDb(): void {
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

/** @deprecated Use `closeChatArchDb`. Retained for test back-compat. */
export const _resetChatArchDbForTests = closeChatArchDb;

/**
 * Remove the SQLite DB file + its `-wal` / `-shm` siblings from disk.
 * No-op if the file doesn't exist. Caller is responsible for calling
 * `closeChatArchDb()` first so the OS releases the file handles
 * (especially important on Windows).
 *
 * Used by `/api/clear` POST handler to extend the orphan-sweep
 * (Rev3-A.A9) into the new SQLite substrate now that the DB lives
 * outside `apps/standalone/public/chat-arch-data/` (Rev3-C C4
 * iter-1 security fix).
 */
export async function wipeSqliteDbFiles(): Promise<{ removed: number }> {
  const base = dbPath();
  let removed = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    const path = base + suffix;
    if (!existsSync(path)) continue;
    try {
      await unlink(path);
      removed += 1;
    } catch {
      // Best-effort — a leftover file doesn't break correctness
      // (next `getChatArchDb` reopens, migrations are idempotent).
    }
  }
  return { removed };
}
