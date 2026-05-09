/**
 * Integration tests for the apply-correction POST handler that exercise
 * the concurrency gate and the atomic-write / corruption-recovery
 * paths. The pure helpers live next door in `apply-correction.test.ts`;
 * this file targets the request/response shape and the global
 * `inFlight` slot that serializes ledger writes.
 *
 * fs is mocked at the module boundary so the tests don't touch the
 * real `apps/standalone/public/chat-arch-data/analysis/` ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────
// In-memory fs mock. We replicate just enough of `node:fs/promises` to
// drive the handler (readFile / writeFile / rename / mkdir). Each test
// resets the store via beforeEach.
// ─────────────────────────────────────────────────────────────────────
interface FsState {
  files: Map<string, string>;
  /**
   * When set, the next writeFile call awaits this promise BEFORE
   * actually writing. Used by the race test to hold the first POST
   * mid-write while the second one races the gate.
   */
  writeGate: Promise<void> | null;
  writeGateResolve: (() => void) | null;
}

const fs: FsState = {
  files: new Map(),
  writeGate: null,
  writeGateResolve: null,
};

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fs.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file '${path}'`) as Error & {
        code: string;
      };
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    if (fs.writeGate) await fs.writeGate;
    fs.files.set(path, content);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    const content = fs.files.get(from);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file '${from}'`) as Error & {
        code: string;
      };
      err.code = 'ENOENT';
      throw err;
    }
    fs.files.set(to, content);
    fs.files.delete(from);
  }),
  mkdir: vi.fn(async () => undefined),
}));

// Importing AFTER the vi.mock so the handler's `import` resolves to
// the mock. (Vitest hoists vi.mock calls, but the import statement
// must follow the mock declaration in source order to keep this
// readable.)
const handlerModule = await import('../../src/pages/api/apply-correction.js');
const { POST, loadLedger, LedgerCorruptError } = handlerModule;

beforeEach(() => {
  fs.files.clear();
  fs.writeGate = null;
  fs.writeGateResolve = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// Request builder
// ─────────────────────────────────────────────────────────────────────
function makeRequest(body: unknown, init?: { origin?: string; xrw?: string }): Request {
  return new Request('http://localhost:4324/api/apply-correction', {
    method: 'POST',
    headers: {
      origin: init?.origin ?? 'http://localhost:4324',
      'x-requested-with': init?.xrw ?? 'chat-arch-apply-correction',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  patternId: 'p-race',
  ruleSummary: 'no docstrings',
  proposedUpgrade: {
    target: 'global-claude-md',
    targetPath: '~/.claude/CLAUDE.md',
    patch: '- no docstrings',
    rationale: 'because',
    applied: false,
    appliedAt: null,
  },
};

// Astro POST handler signature is ({ request, ... }) — we only need
// `request`, the rest is unused for this endpoint.
function invoke(req: Request): Promise<Response> {
  // The cast mirrors how Astro calls the handler in practice.
  return (POST as unknown as (ctx: { request: Request }) => Promise<Response>)(
    { request: req },
  );
}

// ─────────────────────────────────────────────────────────────────────
// P0.1 — TOCTOU race on inFlight
// ─────────────────────────────────────────────────────────────────────
describe('apply-correction POST — concurrency gate', () => {
  it('serializes concurrent POSTs: exactly one wins, the other gets 409', async () => {
    // Hold the first writer mid-write so the second POST has time to
    // hit the gate. Without the synchronous-claim fix, both POSTs
    // would parse their bodies in parallel, both observe inFlight ===
    // null, and race the read-modify-write — the second one would
    // clobber the first's entry.
    fs.writeGate = new Promise<void>((res) => {
      fs.writeGateResolve = res;
    });

    const p1 = invoke(makeRequest(validBody));
    const p2 = invoke(makeRequest({ ...validBody, patternId: 'p-race-2' }));

    // Drain microtasks so p2 has a chance to run its synchronous
    // gate-check portion. Without this, the test passes trivially
    // (microtask ordering may still serialize, but we want to assert
    // the gate works under contention).
    await new Promise<void>((r) => setImmediate(r));

    // Release the first writer so it can finish.
    fs.writeGateResolve?.();

    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = r1.status === 200 ? r1 : r2;
    const winnerBody = (await winner.json()) as { ok: boolean; entriesCount: number };
    expect(winnerBody.ok).toBe(true);
    expect(winnerBody.entriesCount).toBe(1);

    const loser = r1.status === 409 ? r1 : r2;
    const loserBody = (await loser.json()) as { ok: boolean; error: string };
    expect(loserBody.ok).toBe(false);
    expect(loserBody.error).toMatch(/Another apply is already writing/);
  });

  it('releases the gate after each request so subsequent POSTs succeed', async () => {
    // Sanity: no holds, two sequential POSTs both succeed.
    const r1 = await invoke(makeRequest(validBody));
    expect(r1.status).toBe(200);
    const r2 = await invoke(
      makeRequest({ ...validBody, patternId: 'p-race-second' }),
    );
    expect(r2.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P0.2 — Atomic write + corrupt-file recovery
// ─────────────────────────────────────────────────────────────────────
describe('apply-correction POST — atomic write', () => {
  it('writes to a sibling .tmp and renames over the destination', async () => {
    const r = await invoke(makeRequest(validBody));
    expect(r.status).toBe(200);

    // Final ledger landed at the canonical path.
    const ledgerPath = Array.from(fs.files.keys()).find((k) =>
      k.endsWith('applied-improvements.json'),
    );
    expect(ledgerPath).toBeDefined();

    // The .tmp sibling has been renamed away (rename clears it).
    const tmpPath = Array.from(fs.files.keys()).find((k) =>
      k.endsWith('.applied-improvements.json.tmp'),
    );
    expect(tmpPath).toBeUndefined();
  });

  it('a kill mid-write (writeFile threw) leaves the ledger intact', async () => {
    // Seed a known-good ledger.
    const r1 = await invoke(makeRequest(validBody));
    expect(r1.status).toBe(200);
    const ledgerPath = Array.from(fs.files.keys()).find((k) =>
      k.endsWith('applied-improvements.json'),
    )!;
    const before = fs.files.get(ledgerPath);

    // Force the next writeFile to fail (simulates kill / disk full /
    // fsync error before rename). The atomic-write contract: the
    // original ledger must be untouched.
    const fsmod = (await import('node:fs/promises')) as unknown as {
      writeFile: ReturnType<typeof vi.fn>;
    };
    fsmod.writeFile.mockImplementationOnce(async () => {
      throw new Error('ENOSPC: no space left on device');
    });

    const r2 = await invoke(
      makeRequest({ ...validBody, patternId: 'p-second' }),
    );
    expect(r2.status).toBe(500);
    expect(fs.files.get(ledgerPath)).toBe(before);
  });
});

describe('apply-correction loadLedger — corruption posture', () => {
  it('returns a fresh envelope when the file does not exist (ENOENT)', async () => {
    const r = await loadLedger('/no/such/path/applied-improvements.json');
    expect(r.entries).toEqual([]);
    expect(r.schemaVersion).toBe(1);
  });

  it('throws LedgerCorruptError on parse failure (so POST refuses to overwrite)', async () => {
    fs.files.set('/tmp/garbage.json', '{ not valid json');
    await expect(loadLedger('/tmp/garbage.json')).rejects.toBeInstanceOf(
      LedgerCorruptError,
    );
  });

  it('throws LedgerCorruptError on wrong-shape file', async () => {
    fs.files.set('/tmp/wrong-shape.json', JSON.stringify({ entries: 'not-an-array' }));
    await expect(loadLedger('/tmp/wrong-shape.json')).rejects.toBeInstanceOf(
      LedgerCorruptError,
    );
  });

  it('POST returns 500 (not 200) when the existing ledger is corrupt', async () => {
    // Pre-place a corrupt file at the path the handler writes to.
    const r0 = await invoke(makeRequest(validBody));
    expect(r0.status).toBe(200);
    const ledgerPath = Array.from(fs.files.keys()).find((k) =>
      k.endsWith('applied-improvements.json'),
    )!;
    fs.files.set(ledgerPath, '{ corrupted ');

    const r = await invoke(
      makeRequest({ ...validBody, patternId: 'p-after-corrupt' }),
    );
    expect(r.status).toBe(500);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ledger appears corrupted/);
  });
});
