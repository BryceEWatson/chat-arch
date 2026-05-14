/**
 * Chat-page types — shared by the `chat-answer` skill, the `/api/chat-answer`
 * endpoint, the browser network seam (`chatAnswerClient.ts`), and the
 * `ChatMode` component.
 *
 * Two intents flow through the same agentic skill:
 *   - `ask` — grounded Q&A over the corpus ("are you using any workflow…")
 *   - `find-opportunities` — proactive surfacing of blog/post ideas
 *
 * The browser is a thin renderer over a Claude Code session: it does not do
 * its own retrieval. The endpoint spawns `claude -p --output-format=stream-json`
 * (with `--resume <id>` on subsequent turns), and the skill — running as
 * Claude Code with `Read Grep Glob Task` granted — explores the corpus on
 * its own using sub-agents. Stream-json events are re-emitted by the
 * endpoint as NDJSON for the browser to render.
 */

/**
 * What the user is asking the chat to do. The skill branches on this to
 * pick its workflow (retrieval shape, sub-agent dispatch strategy,
 * synthesis tone). Kept as a closed string union — the endpoint validates
 * incoming requests against it.
 */
export type ChatIntent = 'ask' | 'find-opportunities';

/**
 * A single turn in a chat conversation. Order is significant — turns are
 * persisted as an array in insertion order; the assistant turn for a given
 * user turn always immediately follows it.
 */
export interface ChatTurn {
  /** Stable per-turn id; UUID. */
  id: string;
  role: 'user' | 'assistant';
  /** ms-since-epoch when the turn was created (user) or completed (assistant). */
  createdAt: number;
  /**
   * For user turns: the question text the user typed.
   * For assistant turns: the final synthesized answer text (markdown).
   * Streamed token events are NOT stored here individually — only the
   * concatenated final text once the stream closes. Mid-stream the UI
   * renders from in-memory state; persistence happens after `final`.
   */
  content: string;
  /**
   * Citations the assistant emitted, validated against the corpus the
   * agent actually read during this turn (the endpoint validates inline
   * `[SID:...]` against the `tool_use` events for `Read` — a hallucinated
   * id never reaches the persisted turn). Empty for user turns.
   */
  citations?: readonly ChatCitation[];
  /**
   * Structured trace of what the agent did during this turn — tool calls,
   * sub-agent spawns, errors. Persisted so a future "why did it answer
   * that?" debug surface can replay the trace without re-running the
   * agent. Optional because turns that errored before any tool call have
   * nothing to record.
   */
  trace?: readonly ChatTraceEvent[];
}

/**
 * A citation pointing at a specific session in the manifest. The agent
 * cites by `(source, id)` because the manifest's primary key is composite
 * — `id` alone collides across sources. Snippet is optional and short
 * (≤200 chars) so the UI can render a hover-preview without re-fetching
 * the transcript.
 */
export interface ChatCitation {
  /** Manifest session id (UUID). */
  sessionId: string;
  /** Manifest session source — disambiguates collisions across sources. */
  source: 'cloud' | 'cowork' | 'cli-direct' | 'cli-desktop';
  /** Optional preview snippet from the corpus the agent grounded on. */
  snippet?: string;
}

/**
 * One entry in the per-turn agent trace. These mirror Claude Code's
 * `--output-format=stream-json` shapes after the endpoint normalizes
 * them (drops envelope, keeps the parts the UI renders).
 *
 * Kept as a closed union so the UI doesn't render unknown kinds — when
 * new event shapes are added in Claude Code, they need a deliberate
 * mapping here.
 */
export type ChatTraceEvent =
  | {
      kind: 'tool_use';
      /** Tool name as Claude Code reports it (`Read`, `Grep`, `Glob`, `Task`). */
      tool: string;
      /** One-line summary the UI renders ("Grep `workflow|/loop` in transcripts"). */
      summary: string;
      ts: number;
    }
  | {
      kind: 'sub_agent';
      /** Sub-agent name (`Explore`, `general-purpose`, or a custom type). */
      agent: string;
      summary: string;
      ts: number;
    }
  | {
      kind: 'thinking';
      /** Inline thinking text from the agent — rendered collapsed. */
      preview: string;
      ts: number;
    }
  | {
      kind: 'error';
      message: string;
      ts: number;
    };

/**
 * Persisted shape of a single chat conversation. Stored in IndexedDB
 * (`chat-arch-chat-history` → `chats` → key = `chatId`). One IndexedDB
 * entry per chat session so the user can have multiple conversations
 * without juggling them in a single blob.
 *
 * `claudeSessionId` is what powers free multi-turn memory: the first
 * turn's stream-json `system.init` event carries the Claude Code session
 * id; subsequent turns pass it via `claude -p --resume <id>`. When the
 * id goes stale (Claude Code session cleanup, user wiped state), the
 * endpoint detects the resume failure and starts a fresh session — the
 * UI surfaces "context reset" but the user's question still runs.
 */
export interface ChatConversation {
  /** Stable chat-conversation id (UUID), created on first turn. */
  chatId: string;
  /**
   * Claude Code session id from the most recent successful turn. Null
   * when no turn has completed yet (first-turn pending), or when the
   * prior session has been invalidated and a fresh start is required
   * on the next turn.
   */
  claudeSessionId: string | null;
  /** When the first turn was sent. */
  createdAt: number;
  /** When the last turn was completed. Drives sort order in the chat list. */
  updatedAt: number;
  /**
   * The intent of the most recent turn — drives the UI's mode label and
   * the skill's branching on the next turn. A single conversation can
   * mix intents (user can ask a Q after a find-opportunities pass).
   */
  intent: ChatIntent;
  /** All turns in order. */
  turns: readonly ChatTurn[];
  /**
   * User-supplied or auto-generated short label for the chat-list. Auto-
   * generation: first ~60 chars of the first user turn, truncated at the
   * last whitespace. Editable in a future UI; for Phase 1 it's auto only.
   */
  title: string;
}

/** Schema-versioned envelope for the IndexedDB chat-history store. */
export interface ChatHistoryFile {
  /**
   * Bump on any change to ChatConversation shape that would break
   * the runtime guard in `chatHistoryStore.ts`.
   *
   * History:
   *   1 — initial schema (ask + find-opportunities intents).
   */
  version: 1;
  /** All chats, newest-updated first. */
  chats: readonly ChatConversation[];
}

/**
 * What the browser POSTs to `/api/chat-answer` for a single turn.
 * The endpoint never receives a context bundle — retrieval is the
 * skill's job (per the v3 first-principles reframe). The browser only
 * supplies the question, the intent, and the session id to resume
 * (if any).
 */
export interface ChatAnswerRequest {
  /** Per-conversation id; the endpoint's per-chat single-flight gate keys on this. */
  chatId: string;
  /** What the user typed. Validated server-side (length cap, etc.). */
  question: string;
  /** Intent for this turn. */
  intent: ChatIntent;
  /**
   * Claude Code session id from the prior turn, if any. Omitted on the
   * first turn of a conversation. When present, the endpoint passes
   * `--resume <id>` to `claude -p`.
   */
  resumeSessionId?: string;
}

/**
 * NDJSON event shapes streamed back from `/api/chat-answer`. The browser
 * parses these into UI updates. The endpoint produces this stream by
 * normalizing Claude Code's `--output-format=stream-json` plus emitting
 * a few endpoint-level events (`start`, `claude-session`, `final`,
 * `error`).
 */
export type ChatStreamEvent =
  | {
      type: 'start';
      requestId: string;
      chatId: string;
      startedAt: number;
    }
  | {
      /**
       * The Claude Code session id for this turn. Emitted once, near the
       * top of the stream, after the agent's `system.init` event. The
       * browser persists this on the conversation so the NEXT turn can
       * pass it as `resumeSessionId`.
       */
      type: 'claude-session';
      claudeSessionId: string;
    }
  | {
      type: 'trace';
      event: ChatTraceEvent;
    }
  | {
      /**
       * Partial assistant text — emit-as-you-go. The browser concatenates
       * these into the current assistant turn's content. May arrive
       * interleaved with `trace` events (the agent reads a file, prints
       * a paragraph, grep, prints more, etc.).
       */
      type: 'token';
      text: string;
    }
  | {
      /**
       * A validated citation parsed from the assistant's emitted text.
       * "Validated" = the endpoint confirmed (via the agent's prior
       * `Read` tool_use events) that the SID was actually read during
       * this turn — hallucinated ids are dropped before reaching here.
       */
      type: 'citation';
      citation: ChatCitation;
    }
  | {
      /**
       * End-of-turn sentinel. The browser uses this both to mark the
       * assistant turn complete (and persist it) and to detect silent
       * abort: if the stream closes without a `final` event, the turn
       * is treated as errored.
       */
      type: 'final';
      ok: true;
      answerChars: number;
      citationsCount: number;
      durationMs: number;
    }
  | {
      type: 'error';
      message: string;
      /** Hint for the UI: should this turn be retryable, or is it a hard fail? */
      retryable: boolean;
    };

/**
 * Maximum length of the user's question (in characters). Beyond this the
 * endpoint 400s rather than spawning Claude. Kept generous — long
 * questions with pasted context are legitimate — but bounded so a
 * runaway paste can't OOM the spawn.
 */
export const CHAT_QUESTION_MAX_CHARS = 16_000;

/**
 * Maximum turns we send Claude as "prior conversation" context for a
 * resumed session. Claude Code maintains its own context for resumes,
 * so we don't need to re-stitch the entire history — this cap exists
 * only to bound the prompt's prelude when the resume fails and we have
 * to send fresh context.
 */
export const CHAT_MAX_PRIOR_TURNS = 4;
