import type { ChatAnswerRequest, ChatStreamEvent } from '@chat-arch/schema';

/**
 * Network seam for the chat page. The viewer never calls `fetch()` for
 * `/api/chat-answer` directly — it goes through `streamChatAnswer` so the
 * NDJSON parsing, CSRF header, and event dispatch live in one place.
 *
 * Same pattern as `fetch.ts` (the manifest seam) and
 * `mineCorrectionsClient.ts` (the corrections mining seam).
 */

const ENDPOINT = '/api/chat-answer';
const REQUIRED_HEADER = 'chat-arch-chat-answer';

export interface StreamChatAnswerOptions {
  /** Called once per parsed NDJSON line. */
  onEvent: (ev: ChatStreamEvent) => void;
  /** Abort signal for user-initiated cancel ("stop" button). */
  signal?: AbortSignal;
}

export interface StreamChatAnswerResult {
  /** True iff a `final` event was observed in the stream. */
  finalSeen: boolean;
  /**
   * When the request was rejected before streaming started (4xx / 5xx
   * status), the parsed error body. Null when the stream was reached.
   */
  rejected: { status: number; error: string } | null;
}

/**
 * POST a single chat turn and stream the NDJSON response through
 * `onEvent`. Rejected requests (CSRF, validation, concurrency caps)
 * return early with `rejected` populated; the stream path always returns
 * with `finalSeen` reflecting whether the agent finished cleanly.
 */
export async function streamChatAnswer(
  body: ChatAnswerRequest,
  opts: StreamChatAnswerOptions,
): Promise<StreamChatAnswerResult> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': REQUIRED_HEADER,
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    opts.onEvent({
      type: 'error',
      message: `network error contacting ${ENDPOINT}: ${String(err)}`,
      retryable: true,
    });
    return { finalSeen: false, rejected: { status: 0, error: 'network' } };
  }

  if (!res.ok) {
    let errText = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === 'string') errText = j.error;
    } catch {
      // not JSON; keep status text
    }
    opts.onEvent({ type: 'error', message: errText, retryable: res.status >= 500 || res.status === 429 });
    return { finalSeen: false, rejected: { status: res.status, error: errText } };
  }

  const reader = res.body?.getReader();
  if (!reader) {
    opts.onEvent({ type: 'error', message: 'response had no body', retryable: false });
    return { finalSeen: false, rejected: null };
  }

  const decoder = new TextDecoder();
  let buf = '';
  let finalSeen = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          const ev = parseEvent(line);
          if (ev) {
            opts.onEvent(ev);
            if (ev.type === 'final') finalSeen = true;
          }
        }
        nl = buf.indexOf('\n');
      }
    }
    // Flush any trailing partial.
    if (buf.trim().length > 0) {
      const ev = parseEvent(buf.trim());
      if (ev) {
        opts.onEvent(ev);
        if (ev.type === 'final') finalSeen = true;
      }
    }
  } catch (err) {
    opts.onEvent({
      type: 'error',
      message: `stream interrupted: ${String(err)}`,
      retryable: true,
    });
  }

  return { finalSeen, rejected: null };
}

function parseEvent(line: string): ChatStreamEvent | null {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return null;
    // Trust the server's typing — we control the endpoint. Defensive
    // validation here would mostly fail open anyway.
    return obj as ChatStreamEvent;
  } catch {
    return null;
  }
}

/**
 * One-shot availability probe used on ChatMode mount. Returns false when
 * the endpoint is unavailable (static-only deploy, server down) so the
 * UI can render an empty state instead of a non-functional input.
 */
export async function probeChatAnswerAvailability(): Promise<boolean> {
  try {
    const res = await fetch(ENDPOINT, { method: 'GET' });
    if (!res.ok) return false;
    const j = (await res.json()) as { available?: unknown };
    return j.available === true;
  } catch {
    return false;
  }
}
