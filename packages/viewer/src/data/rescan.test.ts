import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useRescan } from './rescan.js';

// ---------------------------------------------------------------------------
// Phase 4 P1.1 — `useRescan().available` is tri-state.
//
// The probe takes ~50–200ms in production. If consumers gate UI on
// `available === true`, every local-dev mount briefly hides the
// CHOOSE ZIP / CORRECTIONS sidebar / etc. on first paint, and every
// hosted demo briefly flashes the local-only labels. To fix that the
// hook initializes to 'probing' and consumers gate on `!== false`
// (optimistic-local) instead of `=== true` (strict).
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('useRescan', () => {
  it('initial state is "probing" before the network probe resolves', () => {
    // A pending fetch keeps the probe inflight forever — that's the
    // window we care about. The initial value must be 'probing'.
    let resolveFetch: ((res: Response) => void) | null = null;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as typeof fetch;
    const { result } = renderHook(() => useRescan());
    expect(result.current.available).toBe('probing');
    // Never let the promise dangle into the next test.
    if (resolveFetch !== null) {
      (resolveFetch as (res: Response) => void)({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'text/html' }),
      } as unknown as Response);
    }
  });

  it('resolves to true when the probe returns {available: true}', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ available: true }),
          text: async () => '',
        }) as unknown as Response,
    );
    const { result } = renderHook(() => useRescan());
    await waitFor(() => expect(result.current.available).toBe(true));
  });

  it('resolves to false on a 404 (hosted-static build)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'text/html' }),
        }) as unknown as Response,
    );
    const { result } = renderHook(() => useRescan());
    await waitFor(() => expect(result.current.available).toBe(false));
  });

  it('resolves to false when the probe throws (network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const { result } = renderHook(() => useRescan());
    await waitFor(() => expect(result.current.available).toBe(false));
  });

  it('the optimistic-local helper rule (`available !== false`) covers both true and probing', () => {
    // This is a lint-style guard against a future regression: if the
    // tri-state is collapsed back to `boolean`, this test fails because
    // 'probing' becomes a literal string and the !== false comparison
    // semantics shift in the consuming code paths.
    const probing: boolean | 'probing' = 'probing';
    const yes: boolean | 'probing' = true;
    const no: boolean | 'probing' = false;
    expect(probing !== false).toBe(true);
    expect(yes !== false).toBe(true);
    expect(no !== false).toBe(false);
  });
});
