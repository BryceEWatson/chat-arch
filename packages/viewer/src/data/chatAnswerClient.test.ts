import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatStreamEvent } from '@chat-arch/schema';
import { streamChatAnswer } from './chatAnswerClient.js';

/**
 * Build a Response whose body is a ReadableStream that emits the given
 * NDJSON lines, then either closes normally or throws an Error. Used to
 * simulate both the happy path and the cancellation / network-error
 * branches of `streamChatAnswer`.
 */
function makeStreamResponse(opts: {
  status?: number;
  lines?: readonly string[];
  /** When set, the stream throws this on `.read()` after the lines drain. */
  throwAfter?: Error;
}): Response {
  const { status = 200, lines = [], throwAfter } = opts;
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(encoder.encode(lines[i] + '\n'));
        i += 1;
        return;
      }
      if (throwAfter) {
        controller.error(throwAfter);
        return;
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/x-ndjson' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamChatAnswer — AbortError handling (review-loop iter-2 SR1)', () => {
  it('does NOT emit a visible error event when the stream throws AbortError', async () => {
    // Simulate a user clicking STOP mid-stream: the underlying fetch's
    // ReadableStream surfaces an AbortError DOMException. The client
    // must treat this as a clean exit and not pop a banner.
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse({
        lines: ['{"type":"chunk","text":"partial"}'],
        throwAfter: abortError,
      }),
    );
    const events: ChatStreamEvent[] = [];
    const controller = new AbortController();
    const result = await streamChatAnswer(
      { chatId: 'c1', messages: [] },
      { onEvent: (ev) => events.push(ev), signal: controller.signal },
    );
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(0);
    expect(result.finalSeen).toBe(false);
    expect(result.rejected).toBeNull();
  });

  it('does NOT emit a visible error event when signal.aborted is true even if the error name is different', async () => {
    // Some browsers / polyfills surface aborts as TypeError rather than
    // AbortError. The signal.aborted check is the belt to the AbortError
    // name's suspenders.
    const ac = new AbortController();
    ac.abort();
    const genericError = new TypeError('Fetch failed');
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse({ throwAfter: genericError }),
    );
    const events: ChatStreamEvent[] = [];
    const result = await streamChatAnswer(
      { chatId: 'c1', messages: [] },
      { onEvent: (ev) => events.push(ev), signal: ac.signal },
    );
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(0);
    expect(result.rejected).toBeNull();
  });

  it('DOES emit an error event for a non-abort network failure mid-stream', async () => {
    // Regression guard: the abort-suppression branch must not swallow
    // genuine network failures.
    const netErr = new Error('NetworkError when attempting to fetch resource.');
    fetchMock.mockResolvedValueOnce(
      makeStreamResponse({ throwAfter: netErr }),
    );
    const events: ChatStreamEvent[] = [];
    const result = await streamChatAnswer(
      { chatId: 'c1', messages: [] },
      { onEvent: (ev) => events.push(ev) },
    );
    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
    // errorToUserMessage translates the network-layer string into a
    // user-facing message; verify that translator is in the path.
    expect((errorEvents[0] as { message: string }).message).toMatch(
      /local backend isn't reachable/i,
    );
    expect(result.rejected).toBeNull();
  });
});
