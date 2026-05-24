/**
 * Wave 7 P2 #9 — `/api/knowledge-debt-state` endpoint.
 *
 * Records the user's PENDING | INSTALLED | DISMISSED selection on a
 * knowledge-debt cluster. Mirrors the apply-correction / insights-ack
 * posture (CSRF, single-flight, atomic write). Ledger:
 *
 *   chat-arch-data/analysis/knowledge-debt-states.json
 */

import type { APIRoute } from 'astro';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const prerender = false;

export const REQUIRED_HEADER = 'chat-arch-knowledge-debt-state';
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

export type KnowledgeDebtStateValue = 'PENDING' | 'INSTALLED' | 'DISMISSED';

export interface KnowledgeDebtStateEntry {
  clusterId: string;
  state: KnowledgeDebtStateValue;
  updatedAt: number;
  sizeAtState: number;
}

export interface KnowledgeDebtStatesFile {
  schemaVersion: 1;
  generatedAt: number;
  entries: KnowledgeDebtStateEntry[];
}

const KNOWN_STATES: ReadonlySet<KnowledgeDebtStateValue> = new Set([
  'PENDING',
  'INSTALLED',
  'DISMISSED',
]);
const MAX_ID_LEN = 256;

export interface ValidatedState {
  clusterId: string;
  state: KnowledgeDebtStateValue;
  sizeAtState: number;
}

export function validateStateBody(body: unknown): ValidatedState | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.clusterId !== 'string' || b.clusterId.length === 0) {
    return { error: 'clusterId is required' };
  }
  if (b.clusterId.length > MAX_ID_LEN) {
    return { error: `clusterId exceeds ${MAX_ID_LEN} chars` };
  }
  if (
    typeof b.state !== 'string' ||
    !KNOWN_STATES.has(b.state as KnowledgeDebtStateValue)
  ) {
    return {
      error: `state must be one of: ${[...KNOWN_STATES].join(', ')}`,
    };
  }
  if (typeof b.sizeAtState !== 'number' || !Number.isFinite(b.sizeAtState)) {
    return { error: 'sizeAtState must be a finite number' };
  }
  return {
    clusterId: b.clusterId,
    state: b.state as KnowledgeDebtStateValue,
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

export class StateLedgerCorruptError extends Error {
  constructor(public readonly path: string, cause?: unknown) {
    super(
      `knowledge-debt-state ledger appears corrupted at ${path}; refusing to overwrite.` +
        (cause instanceof Error ? ` ${cause.message}` : ''),
    );
    this.name = 'StateLedgerCorruptError';
  }
}

export async function loadStateLedger(
  path: string,
): Promise<KnowledgeDebtStatesFile> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isMissingFile(err)) {
      return { schemaVersion: 1, generatedAt: Date.now(), entries: [] };
    }
    throw new StateLedgerCorruptError(path, err);
  }
  let parsed: Partial<KnowledgeDebtStatesFile> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<KnowledgeDebtStatesFile>;
  } catch (err) {
    throw new StateLedgerCorruptError(path, err);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    throw new StateLedgerCorruptError(path);
  }
  return {
    schemaVersion: 1,
    generatedAt:
      typeof parsed.generatedAt === 'number' ? parsed.generatedAt : Date.now(),
    entries: parsed.entries as KnowledgeDebtStateEntry[],
  };
}

async function atomicWriteStateLedger(
  ledgerPath: string,
  next: KnowledgeDebtStatesFile,
): Promise<void> {
  // Stamped tmp name so concurrent writers never race rename(). (S3)
  const tmpPath = join(
    dirname(ledgerPath),
    `.knowledge-debt-states.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmpPath, ledgerPath);
}

/**
 * Upsert a knowledge-debt cluster's state. Always writes — re-clicks
 * update the `updatedAt` so the viewer can see the most recent action.
 *
 * Exported for unit tests.
 */
export function upsertState(
  prev: KnowledgeDebtStatesFile,
  payload: ValidatedState,
  now: number,
): { next: KnowledgeDebtStatesFile; entry: KnowledgeDebtStateEntry } {
  const entry: KnowledgeDebtStateEntry = {
    clusterId: payload.clusterId,
    state: payload.state,
    updatedAt: now,
    sizeAtState: payload.sizeAtState,
  };
  const existingIx = prev.entries.findIndex(
    (e) => e.clusterId === payload.clusterId,
  );
  const entries =
    existingIx >= 0
      ? prev.entries.map((e, i) => (i === existingIx ? entry : e))
      : [...prev.entries, entry];
  const next: KnowledgeDebtStatesFile = {
    schemaVersion: 1,
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
        error: 'Another state change is already writing the ledger. Retry in a moment.',
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
    const validation = validateStateBody(parsed);
    if ('error' in validation) {
      const r = badRequest(validation.error);
      resolveSlot(r);
      return r;
    }
    const sidecarDir = join(standaloneDataDir(), 'analysis');
    const ledgerPath = join(sidecarDir, 'knowledge-debt-states.json');
    try {
      await mkdir(sidecarDir, { recursive: true });
      const prev = await loadStateLedger(ledgerPath);
      const { next, entry } = upsertState(prev, validation, Date.now());
      await atomicWriteStateLedger(ledgerPath, next);
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
