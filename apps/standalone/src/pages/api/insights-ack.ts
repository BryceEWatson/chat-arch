/**
 * Wave 6 #3c — `/api/insights-ack` endpoint.
 *
 * Records the user's ACK on a CONFIG-IMPACT contrast (or other
 * insights-mode item) so the next session doesn't re-surface it in
 * the "needs attention" banner. Sidecar:
 *
 *   chat-arch-data/analysis/insights-acks.json
 *
 * Shape:
 *   {
 *     schemaVersion: 1,
 *     generatedAt: number,
 *     entries: Array<{ id: string, kind: string, acknowledgedAt: number }>
 *   }
 *
 * Idempotency key: (kind, id). Re-acknowledging is a no-op (timestamp
 * is left at its first-seen value). CSRF + atomic-write posture
 * mirrors apply-correction.ts exactly.
 */

import type { APIRoute } from 'astro';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-insights-ack';
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

export interface InsightsAckEntry {
  id: string;
  kind: string;
  acknowledgedAt: number;
}

export interface InsightsAcksFile {
  schemaVersion: 1;
  generatedAt: number;
  entries: InsightsAckEntry[];
}

const KNOWN_KINDS = new Set([
  'its-contrast',
  'knowledge-debt',
  // Rev3-C C3 — `narrative` joins the ack allow-list for the binary
  // ack case (one-shot "I've seen this Narrative"). The richer
  // PENDING/INSTALLED/DISMISSED state machine for narratives lives
  // in the entity-states ledger (`/api/entity-states`); this one is
  // for the lightweight acknowledge action.
  'narrative',
  'reflexive',
  'other',
]);
const MAX_ID_LEN = 256;

export interface ValidatedAck {
  id: string;
  kind: string;
}

export function validateAckBody(body: unknown): ValidatedAck | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string' || b.id.length === 0) {
    return { error: 'id is required' };
  }
  if (b.id.length > MAX_ID_LEN) {
    return { error: `id exceeds ${MAX_ID_LEN} chars` };
  }
  if (typeof b.kind !== 'string' || b.kind.length === 0) {
    return { error: 'kind is required' };
  }
  if (!KNOWN_KINDS.has(b.kind)) {
    return { error: `kind must be one of: ${[...KNOWN_KINDS].join(', ')}` };
  }
  return { id: b.id, kind: b.kind };
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

export class AckLedgerCorruptError extends Error {
  constructor(public readonly path: string, cause?: unknown) {
    super(
      `insights-acks ledger appears corrupted at ${path}; refusing to overwrite.` +
        (cause instanceof Error ? ` ${cause.message}` : ''),
    );
    this.name = 'AckLedgerCorruptError';
  }
}

export async function loadAckLedger(path: string): Promise<InsightsAcksFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) {
      return { schemaVersion: 1, generatedAt: Date.now(), entries: [] };
    }
    throw new AckLedgerCorruptError(path, err);
  }
  let parsed: Partial<InsightsAcksFile> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<InsightsAcksFile>;
  } catch (err) {
    throw new AckLedgerCorruptError(path, err);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new AckLedgerCorruptError(path);
  }
  return {
    schemaVersion: 1,
    generatedAt:
      typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(),
    entries: parsed.entries as InsightsAckEntry[],
  };
}

async function atomicWriteAckLedger(
  ledgerPath: string,
  next: InsightsAcksFile,
): Promise<void> {
  // Stamped tmp name so concurrent writers never race rename(). (S3)
  const tmpPath = join(
    dirname(ledgerPath),
    `.insights-acks.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmpPath, ledgerPath);
}

/**
 * Pure ack-mutation core. Re-acknowledging the same (kind, id) pair is
 * a no-op — the original `acknowledgedAt` is preserved so the UI's
 * "first acknowledged" timestamp stays stable across re-clicks.
 *
 * Exported for unit tests.
 */
export function ackToLedger(
  prev: InsightsAcksFile,
  payload: ValidatedAck,
  now: number,
): { next: InsightsAcksFile; entry: InsightsAckEntry; existed: boolean } {
  const existingIx = prev.entries.findIndex(
    (e) => e.kind === payload.kind && e.id === payload.id,
  );
  if (existingIx >= 0) {
    const entry = prev.entries[existingIx]!;
    return { next: prev, entry, existed: true };
  }
  const entry: InsightsAckEntry = {
    id: payload.id,
    kind: payload.kind,
    acknowledgedAt: now,
  };
  const next: InsightsAcksFile = {
    schemaVersion: 1,
    generatedAt: now,
    entries: [...prev.entries, entry],
  };
  return { next, entry, existed: false };
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
      { ok: false, error: 'Another ack is already writing the ledger. Retry in a moment.' },
      409,
    );
  }

  let resolveSlot!: (r: Response) => void;
  let rejectSlot!: (e: unknown) => void;
  const slot = new Promise<Response>((res, rej) => {
    resolveSlot = res;
    rejectSlot = rej;
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
    const validation = validateAckBody(parsed);
    if ('error' in validation) {
      const r = badRequest(validation.error);
      resolveSlot(r);
      return r;
    }
    const sidecarDir = join(standaloneDataDir(), 'analysis');
    const ledgerPath = join(sidecarDir, 'insights-acks.json');
    try {
      await mkdir(sidecarDir, { recursive: true });
      const prev = await loadAckLedger(ledgerPath);
      const { next, entry, existed } = ackToLedger(prev, validation, Date.now());
      if (!existed) await atomicWriteAckLedger(ledgerPath, next);
      const r = jsonResponse(
        {
          ok: true,
          ledgerPath,
          entriesCount: next.entries.length,
          entry,
          existed,
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
  } catch (err) {
    rejectSlot(err);
    throw err;
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
