import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FULL_SCAN_STEPS,
  formatStepLabel,
  runFullScan,
  runOneStep,
  type FullScanStep,
  type FullScanUi,
} from '../../src/scripts/fullScan.ts';
import { REQUIRED_HEADER as RESCAN_HEADER } from '../../src/pages/api/rescan.ts';
import { REQUIRED_HEADER as MINE_HEADER } from '../../src/pages/api/mine-corrections.ts';
import { REQUIRED_HEADER as CURATE_HEADER } from '../../src/pages/api/curate.ts';
import { REQUIRED_HEADER as FALSIFY_HEADER } from '../../src/pages/api/falsify.ts';
import { REQUIRED_HEADER as PERSONA_HEADER } from '../../src/pages/api/mine-persona.ts';
import { REQUIRED_HEADER as NARRATIVES_HEADER } from '../../src/pages/api/mine-narratives.ts';

// Phase β review-loop iter-1 fix: fullScan.ts docstring (line 42)
// promises "the test alongside this file pins both sides" of the
// header⇔REQUIRED_HEADER mapping. No such test existed — a silent
// typo in any header value would 403 the chain with no test to
// catch it.
//
// This file covers two contracts:
//   1. Header pinning — each FULL_SCAN_STEPS entry's `header` must
//      equal the corresponding endpoint's `REQUIRED_HEADER` export
//      verbatim. A bidirectional check (both sides imported) means
//      drift in either direction breaks here.
//   2. Chain semantics — runFullScan honours the failure-halts-chain
//      contract documented at fullScan.ts:21-23. We mock fetch and
//      drive each terminal-state path: all-ok, HTTP 4xx, terminal
//      done.ok=false, transport throw, stream-without-done.

// -----------------------------------------------------------------
// 1. HEADER PINNING (load-bearing — drift here silently 403s the chain)
// -----------------------------------------------------------------

describe('FULL_SCAN_STEPS header pinning (vs. endpoint REQUIRED_HEADER)', () => {
  const byId = new Map(FULL_SCAN_STEPS.map((s) => [s.id, s]));

  it('rescan step matches /api/rescan REQUIRED_HEADER', () => {
    expect(byId.get('rescan')?.header).toBe(RESCAN_HEADER);
  });

  it('mine step matches /api/mine-corrections REQUIRED_HEADER', () => {
    expect(byId.get('mine')?.header).toBe(MINE_HEADER);
  });

  it('curate step matches /api/curate REQUIRED_HEADER', () => {
    expect(byId.get('curate')?.header).toBe(CURATE_HEADER);
  });

  it('falsify step matches /api/falsify REQUIRED_HEADER', () => {
    expect(byId.get('falsify')?.header).toBe(FALSIFY_HEADER);
  });

  it('persona step matches /api/mine-persona REQUIRED_HEADER', () => {
    expect(byId.get('persona')?.header).toBe(PERSONA_HEADER);
  });

  it('narratives step matches /api/mine-narratives REQUIRED_HEADER', () => {
    expect(byId.get('narratives')?.header).toBe(NARRATIVES_HEADER);
  });

  it('exposes exactly 6 steps in the canonical order', () => {
    expect(FULL_SCAN_STEPS.map((s) => s.id)).toEqual([
      'rescan',
      'mine',
      'curate',
      'falsify',
      'persona',
      'narratives',
    ]);
  });

  it('every step has a non-empty url + label', () => {
    for (const s of FULL_SCAN_STEPS) {
      expect(s.url.startsWith('/api/')).toBe(true);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
});

describe('formatStepLabel', () => {
  it('formats as "STEP N OF M: <label>" (1-indexed)', () => {
    const fakeStep: FullScanStep = {
      id: 'x',
      label: 'do thing',
      url: '/api/x',
      header: 'h',
    };
    expect(formatStepLabel(0, 4, fakeStep)).toBe('STEP 1 OF 4: do thing');
    expect(formatStepLabel(3, 4, fakeStep)).toBe('STEP 4 OF 4: do thing');
  });
});

// -----------------------------------------------------------------
// 2. CHAIN SEMANTICS
// -----------------------------------------------------------------

interface CapturedCallbacks {
  starts: { stepIx: number; totalSteps: number; step: FullScanStep }[];
  stepDones: { step: FullScanStep; ok: boolean; errSummary: string | null }[];
  chainDones: { success: boolean; lastError: string | null }[];
}

function makeCapturingUi(): { ui: FullScanUi; cap: CapturedCallbacks } {
  const cap: CapturedCallbacks = {
    starts: [],
    stepDones: [],
    chainDones: [],
  };
  const ui: FullScanUi = {
    onStepStart(stepIx, totalSteps, step) {
      cap.starts.push({ stepIx, totalSteps, step });
    },
    onPhase() {},
    onLine() {},
    onStepDone(step, ok, errSummary) {
      cap.stepDones.push({ step, ok, errSummary });
    },
    onChainDone(success, lastError) {
      cap.chainDones.push({ success, lastError });
    },
  };
  return { ui, cap };
}

/** Build a `Response`-like object whose body streams the given NDJSON lines. */
function ndjsonResponse(lines: readonly string[], opts: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200 });
}

function plainResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  // @ts-expect-error — install on globalThis for the duration of the test.
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — restore.
  delete globalThis.fetch;
});

describe('runFullScan chain semantics', () => {
  it('all 6 steps succeed → onChainDone(true, null) and 6 step labels start', async () => {
    // Each step returns a stream that ends with done.ok=true.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(ndjsonResponse(['{"type":"done","ok":true}'])),
    );
    const { ui, cap } = makeCapturingUi();

    const ok = await runFullScan(ui);

    expect(ok).toBe(true);
    expect(cap.starts.map((s) => s.step.id)).toEqual([
      'rescan',
      'mine',
      'curate',
      'falsify',
      'persona',
      'narratives',
    ]);
    expect(cap.stepDones.map((s) => s.ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(cap.chainDones).toEqual([{ success: true, lastError: null }]);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('step 6 (narratives) does NOT POST until step 5 (persona) NDJSON stream closes', async () => {
    // Track POST order across all 6 steps.
    const postOrder: string[] = [];
    let resolveStep5: ((value: Response) => void) | null = null;

    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      postOrder.push(url);
      if (url.includes('/api/mine-persona')) {
        // Hold step 5's response open until we manually resolve it.
        return new Promise<Response>((res) => {
          resolveStep5 = res;
        });
      }
      // Other steps complete immediately.
      return Promise.resolve(ndjsonResponse(['{"type":"done","ok":true}']));
    });

    const { ui } = makeCapturingUi();
    const chainPromise = runFullScan(ui);

    // Let the chain progress through steps 1-4, then pause at step 5.
    await new Promise((res) => setTimeout(res, 50));

    // At this point, the chain MUST have posted /api/rescan, /api/mine-corrections,
    // /api/curate, /api/falsify, /api/mine-persona — but NOT /api/mine-narratives.
    expect(
      postOrder.some((u) => u.includes('/api/mine-narratives')),
    ).toBe(false);
    expect(postOrder.some((u) => u.includes('/api/mine-persona'))).toBe(true);

    // Now release step 5's response. Step 6 should fire.
    resolveStep5!(ndjsonResponse(['{"type":"done","ok":true}']));
    const ok = await chainPromise;

    expect(ok).toBe(true);
    expect(
      postOrder.some((u) => u.includes('/api/mine-narratives')),
    ).toBe(true);
  });

  it('step 2 returns HTTP 409 → chain halts, steps 3+4+5 never started', async () => {
    let call = 0;
    fetchSpy.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(ndjsonResponse(['{"type":"done","ok":true}']));
      }
      if (call === 2) {
        return Promise.resolve(plainResponse('busy', 409));
      }
      return Promise.reject(new Error('should not reach step 3+'));
    });
    const { ui, cap } = makeCapturingUi();

    const ok = await runFullScan(ui);

    expect(ok).toBe(false);
    // Only two starts (rescan + mine); falsify/curate never began.
    expect(cap.starts.map((s) => s.step.id)).toEqual(['rescan', 'mine']);
    // Step 2 (mine) failed.
    expect(cap.stepDones[1]?.ok).toBe(false);
    expect(cap.stepDones[1]?.errSummary).toMatch(/HTTP 409/);
    expect(cap.chainDones).toHaveLength(1);
    expect(cap.chainDones[0]?.success).toBe(false);
    // The chain-done error surfaces the failing step's label.
    expect(cap.chainDones[0]?.lastError).toMatch(/mine corrections/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('step 1 stream ends with done.ok=false + stderrTail → error surfaces tail', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        ndjsonResponse([
          '{"type":"start"}',
          '{"type":"done","ok":false,"stderrTail":"something broke"}',
        ]),
      ),
    );
    const { ui, cap } = makeCapturingUi();

    const ok = await runFullScan(ui);

    expect(ok).toBe(false);
    expect(cap.starts).toHaveLength(1);
    expect(cap.stepDones).toHaveLength(1);
    expect(cap.stepDones[0]?.ok).toBe(false);
    expect(cap.stepDones[0]?.errSummary).toMatch(/something broke/);
    expect(cap.chainDones[0]?.lastError).toMatch(/something broke/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('transport throws (fetch rejects) → chain halts with `transport:` prefix', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    const { ui, cap } = makeCapturingUi();

    const ok = await runFullScan(ui);

    expect(ok).toBe(false);
    expect(cap.starts).toHaveLength(1);
    expect(cap.stepDones[0]?.ok).toBe(false);
    expect(cap.stepDones[0]?.errSummary).toMatch(/^transport:/);
    expect(cap.stepDones[0]?.errSummary).toMatch(/ECONNREFUSED/);
    expect(cap.chainDones[0]?.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('final `done` event with NO trailing newline is still parsed (buf-drain)', async () => {
    // Producer flushes the terminal event without the closing `\n`.
    // Without the post-stream buffer drain in runOneStep, that line
    // would stay in `buf` and the chain would report "stream ended
    // without done" even though the producer completed cleanly — the
    // symptom Bryce hit where SCAN only fired /api/rescan and the
    // chain silently halted at step 1.
    const noNewlineStream = (): Response => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"start"}\n'));
          // Final `done` event WITHOUT trailing newline.
          controller.enqueue(encoder.encode('{"type":"done","ok":true}'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    fetchSpy.mockImplementation(() => Promise.resolve(noNewlineStream()));
    const { ui, cap } = makeCapturingUi();

    const ok = await runFullScan(ui);

    expect(ok).toBe(true);
    expect(cap.stepDones.map((s) => s.ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(cap.chainDones).toEqual([{ success: true, lastError: null }]);
  });

  it('stream ends without a done event → reports "stream ended without done"', async () => {
    // No terminal { type: 'done' } row — the producer crashed silently.
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(ndjsonResponse(['{"type":"start"}', '{"type":"phase","phase":"writing"}'])),
    );
    const { ui, cap } = makeCapturingUi();

    const ok = await runFullScan(ui);

    expect(ok).toBe(false);
    expect(cap.stepDones[0]?.errSummary).toMatch(/stream ended without done/);
  });

  it('step error summary clipping — HTTP-body branch truncates at 200 chars', async () => {
    // runOneStep slices the HTTP body to .slice(0, 200) when building the
    // error string. Document the current behavior (the spec asks for a
    // TODO if needed — none needed; the cap is intentional, per the
    // streamNdjson sister-path in index.astro which uses the same 200
    // figure for its user-facing message).
    const longBody = 'x'.repeat(500);
    fetchSpy.mockImplementationOnce(() => Promise.resolve(plainResponse(longBody, 500)));
    const result = await runOneStep(FULL_SCAN_STEPS[0]!, {
      onPhase() {},
      onLine() {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    // "HTTP 500: " (10 chars) + 200 body chars max.
    expect(result.error!.length).toBeLessThanOrEqual(10 + 200);
  });
});
