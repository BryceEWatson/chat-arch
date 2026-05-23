import type { APIRoute } from 'astro';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AppliedImprovement,
  AppliedImprovementsFile,
  ProposedUpgrade,
  UpgradeTarget,
} from '@chat-arch/schema';

/**
 * Phase 1 corrections-loop closure. Persists APPLY clicks to
 * `analysis/applied-improvements.json` — a sidecar the viewer's
 * loader merges over the canonical `corrections.json` at read time.
 * `corrections.json` itself is never mutated, so the next mining
 * pass can overwrite it cleanly without losing apply history.
 *
 * Idempotency key: `(patternId, proposedUpgrade.target,
 * proposedUpgrade.targetPath)`. Re-applying the same upgrade
 * REPLACES the existing entry rather than duplicating it.
 *
 * CSRF posture mirrors `/api/encode-pattern.ts` exactly:
 *   1. `Origin` must parse to a loopback hostname.
 *   2. `X-Requested-With: chat-arch-apply-correction`.
 */
export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-apply-correction';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const VALID_TARGETS: ReadonlySet<UpgradeTarget> = new Set<UpgradeTarget>([
  'global-claude-md',
  'project-claude-md',
  'settings-hook',
  'skill',
  'agent',
  'command',
  'prompt-snippet',
]);

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
  return new Response(JSON.stringify({ ok: false, error: `Forbidden: ${reason}` }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Serializes concurrent ledger writes. Two parallel applies would
 * race the `read → splice → write` cycle and one would silently
 * clobber the other. Concurrent callers get 409, matching the
 * `inFlight` posture in `/api/mine-corrections.ts`.
 *
 * IMPORTANT (TOCTOU): `inFlight` is set SYNCHRONOUSLY at handler entry,
 * before any `await` (including `request.json()`), so two POSTs that
 * arrive in the same microtask cannot both pass the gate. Earlier
 * versions of this handler set `inFlight` after parsing the body; both
 * concurrent calls saw `null`, parsed in parallel, and raced the
 * read-modify-write of the ledger.
 */
let inFlight: Promise<Response> | null = null;

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

function standaloneDataDir(): string {
  return join(repoRoot(), 'apps', 'standalone', 'public', 'chat-arch-data');
}

interface ApplyCorrectionRequest {
  patternId?: unknown;
  proposedUpgrade?: unknown;
  ruleSummary?: unknown;
  targetFiles?: unknown;
  notes?: unknown;
}

export interface ApplyCorrectionPayload {
  patternId: string;
  proposedUpgrade: ProposedUpgrade;
  ruleSummary: string;
  targetFiles?: string[];
  notes?: string;
}

const MAX_NOTES_LEN = 4_000;
const MAX_FILES_COUNT = 16;
const MAX_FILE_PATH_LEN = 1_024;

export function isValidProposedUpgrade(p: unknown): p is ProposedUpgrade {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.target !== 'string') return false;
  if (!VALID_TARGETS.has(o.target as UpgradeTarget)) return false;
  if (typeof o.targetPath !== 'string' || o.targetPath.length === 0) return false;
  if (typeof o.patch !== 'string') return false;
  if (typeof o.rationale !== 'string') return false;
  if (typeof o.applied !== 'boolean') return false;
  if (o.appliedAt !== null && typeof o.appliedAt !== 'number') return false;
  return true;
}

/**
 * Validate the POST body and coerce to a strongly-typed payload.
 * Returns `{ ok: false, error }` on any validation miss so the
 * handler can surface a 400 with a useful message.
 */
export function validateApplyBody(
  body: unknown,
):
  | { ok: true; payload: ApplyCorrectionPayload }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as ApplyCorrectionRequest;
  if (typeof b.patternId !== 'string' || b.patternId.length === 0) {
    return { ok: false, error: 'patternId is required' };
  }
  if (typeof b.ruleSummary !== 'string' || b.ruleSummary.length === 0) {
    return { ok: false, error: 'ruleSummary is required' };
  }
  if (!isValidProposedUpgrade(b.proposedUpgrade)) {
    return { ok: false, error: 'proposedUpgrade is missing required fields' };
  }
  let targetFiles: string[] | undefined;
  if (b.targetFiles !== undefined && b.targetFiles !== null) {
    if (!Array.isArray(b.targetFiles)) {
      return { ok: false, error: 'targetFiles must be an array of strings' };
    }
    if (b.targetFiles.length > MAX_FILES_COUNT) {
      return { ok: false, error: `targetFiles exceeds ${MAX_FILES_COUNT} entries` };
    }
    const cleaned: string[] = [];
    for (const entry of b.targetFiles) {
      if (typeof entry !== 'string') {
        return { ok: false, error: 'targetFiles entries must be strings' };
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length > MAX_FILE_PATH_LEN) {
        return { ok: false, error: 'targetFiles entry too long' };
      }
      cleaned.push(trimmed);
    }
    if (cleaned.length > 0) targetFiles = cleaned;
  }
  let notes: string | undefined;
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== 'string') {
      return { ok: false, error: 'notes must be a string' };
    }
    if (b.notes.length > MAX_NOTES_LEN) {
      return { ok: false, error: `notes exceeds ${MAX_NOTES_LEN} chars` };
    }
    const trimmed = b.notes.trim();
    if (trimmed.length > 0) notes = trimmed;
  }
  const payload: ApplyCorrectionPayload = {
    patternId: b.patternId,
    proposedUpgrade: b.proposedUpgrade,
    ruleSummary: b.ruleSummary,
    ...(targetFiles ? { targetFiles } : {}),
    ...(notes ? { notes } : {}),
  };
  return { ok: true, payload };
}

/**
 * `(patternId, proposedUpgrade.target, proposedUpgrade.targetPath)`
 * is the idempotency key — re-applying replaces, never duplicates.
 */
export function isSameApplyKey(
  a: AppliedImprovement,
  patternId: string,
  upgrade: Pick<ProposedUpgrade, 'target' | 'targetPath'>,
): boolean {
  return (
    a.patternId === patternId &&
    a.proposedUpgrade.target === upgrade.target &&
    a.proposedUpgrade.targetPath === upgrade.targetPath
  );
}

/**
 * Sentinel error thrown when the ledger file exists but is unreadable
 * (parse failure, wrong shape, …). The POST handler converts this to
 * a 500 with a recovery hint rather than silently overwriting the file
 * — silently producing a fresh empty envelope on parse failure is how
 * apply history would get erased by a single write following a crash
 * or partial save.
 */
export class LedgerCorruptError extends Error {
  constructor(public readonly path: string, cause?: unknown) {
    super(
      `ledger appears corrupted at ${path}; refusing to overwrite. ` +
        `Inspect manually${cause instanceof Error ? `: ${cause.message}` : ''}.`,
    );
    this.name = 'LedgerCorruptError';
  }
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

export async function loadLedger(path: string): Promise<AppliedImprovementsFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) {
      // First-ever apply for this repo — fresh envelope is correct.
      return { schemaVersion: 1, generatedAt: Date.now(), entries: [] };
    }
    // Permission errors etc. — surface, don't silently overwrite.
    throw new LedgerCorruptError(path, err);
  }
  let parsed: Partial<AppliedImprovementsFile> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<AppliedImprovementsFile>;
  } catch (err) {
    throw new LedgerCorruptError(path, err);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.entries)
  ) {
    throw new LedgerCorruptError(path);
  }
  return {
    schemaVersion: 1,
    generatedAt:
      typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(),
    entries: parsed.entries as AppliedImprovement[],
  };
}

/**
 * Atomic ledger write. Writes to a sibling `.tmp` file and renames
 * over the destination — `fs.promises.rename` is atomic on both POSIX
 * and Windows (NTFS rename overwrites the target in a single syscall).
 * A kill mid-write leaves the original ledger intact rather than
 * truncating it to zero bytes, which (combined with the strict
 * `loadLedger` parse) would erase apply history on next read.
 */
export async function atomicWriteLedger(
  ledgerPath: string,
  next: AppliedImprovementsFile,
): Promise<void> {
  const tmpPath = join(
    dirname(ledgerPath),
    '.applied-improvements.json.tmp',
  );
  await writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmpPath, ledgerPath);
}

/**
 * Pure ledger-mutation core. Exported for unit tests so the
 * idempotency contract can be exercised without touching disk or the
 * Astro runtime.
 *
 * Behavior:
 *   - If an entry with the same `(patternId, target, targetPath)`
 *     exists, REPLACE it (preserving its id).
 *   - Otherwise append a new entry with a fresh UUID.
 *
 * Returns the next ledger and the entry that landed (so callers can
 * surface its id in the response).
 */
export function applyToLedger(
  prev: AppliedImprovementsFile,
  payload: ApplyCorrectionPayload,
  now: number,
  newId: string,
): { next: AppliedImprovementsFile; entry: AppliedImprovement } {
  const existingIx = prev.entries.findIndex((e) =>
    isSameApplyKey(e, payload.patternId, payload.proposedUpgrade),
  );
  const existing = existingIx >= 0 ? prev.entries[existingIx] : null;
  // Mark the persisted ProposedUpgrade as applied — the merge step
  // expects this on disk too, so a viewer reading the ledger directly
  // sees consistent state. The live `corrections.json` is untouched.
  const stampedUpgrade: ProposedUpgrade = {
    ...payload.proposedUpgrade,
    applied: true,
    appliedAt: now,
  };
  const entry: AppliedImprovement = {
    id: existing ? existing.id : newId,
    patternId: payload.patternId,
    appliedAt: now,
    ruleSummary: payload.ruleSummary,
    proposedUpgrade: stampedUpgrade,
    ...(payload.targetFiles ? { targetFiles: payload.targetFiles } : {}),
    ...(payload.notes ? { notes: payload.notes } : {}),
  };
  const nextEntries = prev.entries.slice();
  if (existingIx >= 0) {
    nextEntries[existingIx] = entry;
  } else {
    nextEntries.push(entry);
  }
  const next: AppliedImprovementsFile = {
    schemaVersion: 1,
    generatedAt: now,
    entries: nextEntries,
  };
  return { next, entry };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isLocalOrigin(request.headers.get('origin'))) {
    return csrfReject('cross-origin or missing Origin');
  }
  if (request.headers.get('x-requested-with') !== REQUIRED_HEADER) {
    return csrfReject('missing X-Requested-With token');
  }

  // Fast-fail concurrent callers BEFORE we touch the body. Two POSTs
  // arriving in the same microtask must not both observe `inFlight ===
  // null`; see the TOCTOU note above the `inFlight` declaration.
  if (inFlight) {
    return jsonResponse(
      {
        ok: false,
        error:
          'Another apply is already writing the ledger. Retry in a moment.',
      },
      409,
    );
  }

  // Claim the slot synchronously (no `await` between this assignment
  // and the gate above). The deferred-promise pattern lets us resolve
  // the slot with the actual response when the body finishes — same
  // shape as `mine-corrections.ts`'s `completed` promise but inlined
  // because this handler is request/response, not streaming.
  let resolveInFlight!: (r: Response) => void;
  let rejectInFlight!: (e: unknown) => void;
  const slot = new Promise<Response>((res, rej) => {
    resolveInFlight = res;
    rejectInFlight = rej;
  });
  inFlight = slot;

  try {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      const r = badRequest('invalid JSON body');
      resolveInFlight(r);
      return r;
    }
    const validation = validateApplyBody(parsed);
    if (!validation.ok) {
      const r = badRequest(validation.error);
      resolveInFlight(r);
      return r;
    }

    const sidecarDir = join(standaloneDataDir(), 'analysis');
    const ledgerPath = join(sidecarDir, 'applied-improvements.json');

    try {
      await mkdir(sidecarDir, { recursive: true });
      const prev = await loadLedger(ledgerPath);
      const { next, entry } = applyToLedger(
        prev,
        validation.payload,
        Date.now(),
        randomUUID(),
      );
      await atomicWriteLedger(ledgerPath, next);
      const r = jsonResponse(
        {
          ok: true,
          appliedImprovementId: entry.id,
          ledgerPath,
          entriesCount: next.entries.length,
        },
        200,
      );
      resolveInFlight(r);
      return r;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const r = jsonResponse({ ok: false, error: message }, 500);
      resolveInFlight(r);
      return r;
    }
  } catch (err) {
    // Resolve the slot with a 500 (don't reject it). The slot promise
    // has no .catch attached anywhere — rejecting it surfaces as an
    // unhandled rejection and on Node 15+ the default handler exits
    // the process. Matches the inner-catch behavior above. (S4)
    const message = err instanceof Error ? err.message : String(err);
    const r = jsonResponse({ ok: false, error: message }, 500);
    resolveInFlight(r);
    return r;
  } finally {
    // Clear the slot only AFTER the response is resolved/rejected so
    // any second POST that observed the slot (and got 409) gets that
    // 409 immediately rather than blocking on `slot`. The slot promise
    // itself is GC'd once nothing references it.
    if (inFlight === slot) inFlight = null;
  }
};

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true, available: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
