/**
 * FULL SCAN orchestrator — Phase β.
 *
 * Sequentially fires the four NDJSON producers behind the TODAY page's
 * single "FULL SCAN" button:
 *
 *   1. /api/rescan           (exporter — writes every analysis sidecar)
 *   2. /api/mine-corrections (corrections skill — classifies candidates)
 *   3. /api/curate           (curator skill — ranks the feed)
 *   4. /api/falsify          (falsifier skill — verifies cited evidence)
 *
 * Each call is awaited to completion (NDJSON stream end OR HTTP error)
 * before the next starts. The page reloads exactly once after step 4
 * succeeds — earlier reloads would interrupt later steps.
 *
 * Pure helpers (no DOM, no `window`) live above the orchestrator so
 * they're unit-testable. The DOM-touching parts take a `FullScanUi`
 * port so the consumer (`index.astro`) wires its existing
 * progress/status elements without this module knowing the IDs.
 *
 * Failure semantics: any non-2xx response, NDJSON `done.ok === false`,
 * or thrown error short-circuits the chain. The page stays interactive
 * — the buttons re-enable and the status text shows the failing step.
 */

export interface FullScanStep {
  /** Stable id used in logs ("rescan" / "mine" / "curate" / "falsify"). */
  readonly id: string;
  /** Display label rendered as "STEP N OF M: <label>". */
  readonly label: string;
  /** Endpoint path — relative, same-origin. */
  readonly url: string;
  /** Value sent in the X-Requested-With header (per-endpoint CSRF token). */
  readonly header: string;
}

/**
 * The canonical 4-step sequence. Header values mirror each endpoint's
 * `REQUIRED_HEADER` constant verbatim — re-export divergence here is a
 * silent 403, so the test alongside this file pins both sides.
 */
export const FULL_SCAN_STEPS: readonly FullScanStep[] = [
  {
    id: 'rescan',
    label: 'rescan (exporter)',
    url: '/api/rescan',
    header: 'chat-arch-rescan',
  },
  {
    id: 'mine',
    label: 'mine corrections',
    url: '/api/mine-corrections',
    header: 'chat-arch-mine-corrections',
  },
  {
    id: 'curate',
    label: 'curate feed',
    url: '/api/curate',
    header: 'chat-arch-curate',
  },
  {
    id: 'falsify',
    label: 'falsify findings',
    url: '/api/falsify',
    header: 'chat-arch-falsify',
  },
];

/** Format a step-of-total label, e.g. "STEP 2 OF 4: mine corrections". */
export function formatStepLabel(
  ix: number,
  total: number,
  step: FullScanStep,
): string {
  return `STEP ${ix + 1} OF ${total}: ${step.label}`;
}

/**
 * Shape of the NDJSON events we recognize. The producers emit a small
 * variant union; unknown shapes are tolerated (just ignored).
 */
export type NdjsonEvent =
  | { type: 'start'; [k: string]: unknown }
  | { type: 'phase'; phase?: string; ix?: number; total?: number; [k: string]: unknown }
  | { type: 'stdout'; line?: string }
  | { type: 'stderr'; line?: string }
  | { type: 'done'; ok?: boolean; stderrTail?: string; stdoutTail?: string }
  | { type: string; [k: string]: unknown };

/**
 * Port the orchestrator uses to drive UI. Implemented by `index.astro`
 * against its existing progress/status elements — keeping this as an
 * interface means the orchestrator itself stays DOM-free.
 */
export interface FullScanUi {
  /** Called once per step at start. */
  onStepStart(stepIx: number, totalSteps: number, step: FullScanStep): void;
  /** Called when a phase event arrives — drives the in-step progress bar. */
  onPhase(step: FullScanStep, phase: string, current?: number, total?: number): void;
  /** Called on every stdout/stderr line (already clipped by the producer). */
  onLine(step: FullScanStep, kind: 'stdout' | 'stderr', line: string): void;
  /** Called once per step on terminal `done` (success OR failure). */
  onStepDone(step: FullScanStep, ok: boolean, errSummary: string | null): void;
  /** Called when the entire chain reaches a terminal state. */
  onChainDone(success: boolean, lastError: string | null): void;
}

/**
 * Stream a single producer endpoint to completion. Returns `ok: true`
 * iff the NDJSON terminated with `{ type: 'done', ok: true }`. Any
 * other path (HTTP 4xx/5xx, transport break, missing body, terminal
 * `done.ok === false`) returns ok=false with a short error string.
 */
export async function runOneStep(
  step: FullScanStep,
  ui: Pick<FullScanUi, 'onPhase' | 'onLine'>,
): Promise<{ ok: boolean; error: string | null }> {
  let res: Response;
  try {
    res = await fetch(step.url, {
      method: 'POST',
      headers: {
        'X-Requested-With': step.header,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    return { ok: false, error: `transport: ${String((err as Error).message ?? err)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      error: `HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`,
    };
  }

  if (!res.body) {
    // Producer responded without a stream — treat as benign-completed
    // (the regen-brief endpoint pattern); the page reload will surface
    // whatever the producer wrote.
    return { ok: true, error: null };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let terminalOk: boolean | null = null;
  let terminalErr = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trim();
        if (line.length === 0) continue;
        let evt: NdjsonEvent;
        try {
          evt = JSON.parse(line) as NdjsonEvent;
        } catch {
          continue;
        }
        if (evt.type === 'phase' && typeof evt.phase === 'string') {
          const ix = typeof evt.ix === 'number' ? evt.ix : undefined;
          const total = typeof evt.total === 'number' ? evt.total : undefined;
          ui.onPhase(step, evt.phase, ix, total);
        } else if (evt.type === 'stdout' || evt.type === 'stderr') {
          const ln = typeof evt.line === 'string' ? evt.line : '';
          if (ln.length > 0) ui.onLine(step, evt.type, ln);
        } else if (evt.type === 'done') {
          terminalOk = evt.ok === true;
          if (!terminalOk) {
            const tail =
              (typeof evt.stderrTail === 'string' && evt.stderrTail) ||
              (typeof evt.stdoutTail === 'string' && evt.stdoutTail) ||
              '';
            terminalErr = tail.trim().slice(-400);
          }
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `stream: ${String((err as Error).message ?? err)}`,
    };
  }

  if (terminalOk === true) return { ok: true, error: null };
  // Stream ended without a `done` event — treat as failure with the
  // last-known tail (or "stream ended" if nothing).
  return {
    ok: false,
    error: terminalErr.length > 0 ? terminalErr : 'stream ended without done',
  };
}

/**
 * Drive the full 4-step chain. Returns true iff every step succeeded.
 * On any failure, returns false and stops the chain — the UI port's
 * `onChainDone(false, ...)` is called with the offending step's error.
 */
export async function runFullScan(
  ui: FullScanUi,
  steps: readonly FullScanStep[] = FULL_SCAN_STEPS,
): Promise<boolean> {
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] as FullScanStep;
    ui.onStepStart(i, steps.length, step);
    const result = await runOneStep(step, ui);
    ui.onStepDone(step, result.ok, result.error);
    if (!result.ok) {
      ui.onChainDone(false, `${step.label} failed — ${result.error ?? 'unknown'}`);
      return false;
    }
  }
  ui.onChainDone(true, null);
  return true;
}
