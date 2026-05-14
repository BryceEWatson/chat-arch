import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatCitation,
  ChatConversation,
  ChatIntent,
  ChatStreamEvent,
  ChatTraceEvent,
  ChatTurn,
} from '@chat-arch/schema';
import { CHAT_QUESTION_MAX_CHARS } from '@chat-arch/schema';
import {
  loadChatHistory,
  upsertConversation,
  clearChatHistory,
} from '../../data/chatHistoryStore.js';
import {
  streamChatAnswer,
  probeChatAnswerAvailability,
} from '../../data/chatAnswerClient.js';
import {
  DisclosureModal,
  chatDisclosureAcknowledged,
  markChatDisclosureAcknowledged,
} from './chat/DisclosureModal.js';
import { AgentTrace } from './chat/AgentTrace.js';
import { ChatStreamedMessage } from './chat/ChatStreamedMessage.js';

export interface ChatModeProps {
  /**
   * Called when the user activates a citation chip — navigates to
   * `#session/<id>` so the existing hash router opens DetailMode.
   */
  onSelectSession?: ((sessionId: string) => void) | undefined;
}

interface ActiveTurnState {
  startedAt: number;
  text: string;
  trace: ChatTraceEvent[];
  citations: ChatCitation[];
  /** Captured from the stream so the next turn can `--resume <id>`. */
  claudeSessionId: string | null;
  /** Final error message, if any. */
  error: string | null;
}

const EMPTY_ACTIVE: ActiveTurnState = {
  startedAt: 0,
  text: '',
  trace: [],
  citations: [],
  claudeSessionId: null,
  error: null,
};

const SEED_QUESTIONS: { label: string; question: string; intent: ChatIntent }[] = [
  {
    label: 'PRODUCTIVITY PATTERNS',
    question:
      'Are you using any workflow or tools that multiplies your productivity in a reliable manner?',
    intent: 'ask',
  },
  {
    label: 'BLOG IDEAS',
    question: 'What blog post opportunities does my corpus suggest?',
    intent: 'find-opportunities',
  },
  {
    label: 'CORRECTIONS',
    question: 'What corrections has Claude received from me that I haven’t addressed yet?',
    intent: 'ask',
  },
];

function uuid(): string {
  // crypto.randomUUID exists in all modern browsers + jsdom 22+. Fall
  // back to a Math.random-based variant so old test environments don't
  // crash on import.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function autoTitle(question: string): string {
  const compact = question.trim().replace(/\s+/g, ' ');
  if (compact.length <= 60) return compact;
  const cut = compact.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + '…';
}

export function ChatMode({ onSelectSession }: ChatModeProps) {
  const [available, setAvailable] = useState<'checking' | 'yes' | 'no'>('checking');
  const [conversations, setConversations] = useState<readonly ChatConversation[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [intent, setIntent] = useState<ChatIntent>('ask');
  const [input, setInput] = useState('');
  const [inFlight, setInFlight] = useState<ActiveTurnState | null>(null);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const pendingSendRef = useRef<{ question: string; intent: ChatIntent } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Probe + load history on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await probeChatAnswerAvailability();
      if (cancelled) return;
      setAvailable(ok ? 'yes' : 'no');
      const hist = await loadChatHistory();
      if (cancelled) return;
      if (hist) {
        setConversations(hist.chats);
        if (hist.chats.length > 0 && hist.chats[0]) {
          setActiveChatId(hist.chats[0].chatId);
          setIntent(hist.chats[0].intent);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeChat = useMemo(
    () => conversations.find((c) => c.chatId === activeChatId) ?? null,
    [conversations, activeChatId],
  );

  const startNewChat = useCallback(() => {
    setActiveChatId(null);
    setInput('');
    setInFlight(null);
    inputRef.current?.focus();
  }, []);

  const sendTurn = useCallback(
    async (question: string, turnIntent: ChatIntent) => {
      if (available !== 'yes') return;
      if (inFlight) return;
      if (question.trim().length === 0) return;
      if (question.length > CHAT_QUESTION_MAX_CHARS) return;

      // Resolve target conversation (existing or new).
      const isNewChat = activeChatId === null;
      const chatId = activeChatId ?? uuid();
      const now = Date.now();
      const userTurn: ChatTurn = {
        id: uuid(),
        role: 'user',
        createdAt: now,
        content: question,
      };
      // Optimistically insert/update so the user sees their turn instantly.
      let baseConv: ChatConversation;
      if (isNewChat) {
        baseConv = {
          chatId,
          claudeSessionId: null,
          createdAt: now,
          updatedAt: now,
          intent: turnIntent,
          turns: [userTurn],
          title: autoTitle(question),
        };
      } else {
        const prior = conversations.find((c) => c.chatId === chatId);
        if (!prior) return;
        baseConv = {
          ...prior,
          intent: turnIntent,
          updatedAt: now,
          turns: [...prior.turns, userTurn],
        };
      }
      setActiveChatId(chatId);
      setConversations((prev) => {
        const others = prev.filter((c) => c.chatId !== chatId);
        return [baseConv, ...others];
      });
      setInput('');
      const active: ActiveTurnState = { ...EMPTY_ACTIVE, startedAt: now };
      setInFlight(active);

      const onEvent = (ev: ChatStreamEvent): void => {
        setInFlight((curr) => {
          if (!curr) return curr;
          if (ev.type === 'token') {
            return { ...curr, text: curr.text + ev.text };
          }
          if (ev.type === 'trace') {
            return { ...curr, trace: [...curr.trace, ev.event] };
          }
          if (ev.type === 'citation') {
            // Dedup citations by sessionId — the stream may emit a SID
            // more than once if the assistant repeats it.
            const seen = new Set(curr.citations.map((c) => c.sessionId));
            if (seen.has(ev.citation.sessionId)) return curr;
            return { ...curr, citations: [...curr.citations, ev.citation] };
          }
          if (ev.type === 'claude-session') {
            return { ...curr, claudeSessionId: ev.claudeSessionId };
          }
          if (ev.type === 'error') {
            return { ...curr, error: ev.message };
          }
          return curr;
        });
      };

      const result = await streamChatAnswer(
        {
          chatId,
          question,
          intent: turnIntent,
          ...(baseConv.claudeSessionId
            ? { resumeSessionId: baseConv.claudeSessionId }
            : {}),
        },
        { onEvent },
      );

      // After the stream completes, commit the assistant turn and persist.
      setInFlight((finalActive) => {
        if (!finalActive) return null;
        const assistantContent = finalActive.error
          ? `_(error: ${finalActive.error})_`
          : finalActive.text;
        const assistantTurn: ChatTurn = {
          id: uuid(),
          role: 'assistant',
          createdAt: Date.now(),
          content: assistantContent,
          citations: finalActive.citations.length > 0 ? finalActive.citations : undefined,
          trace: finalActive.trace.length > 0 ? finalActive.trace : undefined,
        } as ChatTurn;
        const completedConv: ChatConversation = {
          ...baseConv,
          claudeSessionId:
            finalActive.claudeSessionId ?? baseConv.claudeSessionId ?? null,
          updatedAt: Date.now(),
          turns: [...baseConv.turns, assistantTurn],
        };
        setConversations((prev) => {
          const others = prev.filter((c) => c.chatId !== chatId);
          return [completedConv, ...others];
        });
        if (!result.rejected && (result.finalSeen || finalActive.text.length > 0)) {
          // Persist only when we got something useful out — a hard CSRF
          // reject or an immediate 4xx doesn't deserve a history row.
          void upsertConversation(completedConv);
        }
        return null;
      });
    },
    [activeChatId, available, conversations, inFlight],
  );

  const handleSendClick = useCallback(() => {
    const question = input.trim();
    if (question.length === 0) return;
    if (!chatDisclosureAcknowledged()) {
      pendingSendRef.current = { question, intent };
      setDisclosureOpen(true);
      return;
    }
    void sendTurn(question, intent);
  }, [input, intent, sendTurn]);

  const handleDisclosureAck = useCallback(() => {
    markChatDisclosureAcknowledged();
    setDisclosureOpen(false);
    const pending = pendingSendRef.current;
    pendingSendRef.current = null;
    if (pending) void sendTurn(pending.question, pending.intent);
  }, [sendTurn]);

  const handleDisclosureCancel = useCallback(() => {
    pendingSendRef.current = null;
    setDisclosureOpen(false);
  }, []);

  const handleSeedClick = useCallback(
    (q: { question: string; intent: ChatIntent }) => {
      setIntent(q.intent);
      setInput(q.question);
      inputRef.current?.focus();
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter to send; plain Enter inserts a newline.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSendClick();
      }
    },
    [handleSendClick],
  );

  const handleClearAll = useCallback(async () => {
    await clearChatHistory();
    setConversations([]);
    setActiveChatId(null);
    setConfirmClear(false);
  }, []);

  if (available === 'checking') {
    return (
      <div className="lcars-chat lcars-chat--probing">
        <div className="lcars-chat__probe">Checking backend availability…</div>
      </div>
    );
  }

  if (available === 'no') {
    return (
      <div className="lcars-chat lcars-chat--unavailable">
        <div className="lcars-chat__empty">
          <h2>CHAT REQUIRES THE LOCAL BACKEND</h2>
          <p>
            The chat page talks to your local Claude Code CLI via{' '}
            <code>/api/chat-answer</code>, which only runs when you&apos;ve started the chat-
            arch dev server (<code>pnpm dev</code> at the repo root). The static-only
            build doesn&apos;t include the endpoint.
          </p>
          <p>Open a terminal in the repo and run:</p>
          <pre>
            <code>pnpm dev</code>
          </pre>
          <p>Then refresh this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lcars-chat">
      <aside className="lcars-chat__list" aria-label="chat conversations">
        <button
          type="button"
          className="lcars-chat__new"
          onClick={startNewChat}
          aria-label="start a new chat"
        >
          + NEW CHAT
        </button>
        <ul className="lcars-chat__list-items">
          {conversations.map((c) => (
            <li key={c.chatId}>
              <button
                type="button"
                className={`lcars-chat__list-item${
                  c.chatId === activeChatId ? ' lcars-chat__list-item--active' : ''
                }`}
                onClick={() => setActiveChatId(c.chatId)}
              >
                <span className="lcars-chat__list-intent">
                  {c.intent === 'find-opportunities' ? 'OPPS' : 'ASK'}
                </span>
                <span className="lcars-chat__list-title">{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
        {conversations.length > 0 && (
          <button
            type="button"
            className="lcars-chat__clear"
            onClick={() => setConfirmClear(true)}
          >
            CLEAR ALL HISTORY
          </button>
        )}
      </aside>

      <section className="lcars-chat__panel" aria-label="active conversation">
        <header className="lcars-chat__header">
          <div className="lcars-chat__intent" role="group" aria-label="conversation intent">
            <label className={`lcars-chat__intent-opt${intent === 'ask' ? ' lcars-chat__intent-opt--active' : ''}`}>
              <input
                type="radio"
                name="chat-intent"
                value="ask"
                checked={intent === 'ask'}
                onChange={() => setIntent('ask')}
                disabled={!!inFlight}
              />
              ASK
            </label>
            <label className={`lcars-chat__intent-opt${intent === 'find-opportunities' ? ' lcars-chat__intent-opt--active' : ''}`}>
              <input
                type="radio"
                name="chat-intent"
                value="find-opportunities"
                checked={intent === 'find-opportunities'}
                onChange={() => setIntent('find-opportunities')}
                disabled={!!inFlight}
              />
              FIND OPPORTUNITIES
            </label>
          </div>
        </header>

        <div className="lcars-chat__transcript" aria-live="polite">
          {!activeChat && (
            <div className="lcars-chat__seed">
              <h2>Ask your corpus.</h2>
              <p>
                The chat page hands your question to your local Claude Code CLI, which
                explores your archived conversations (<code>chat-arch-data/</code>) and
                answers with citations. Try one of these to get started:
              </p>
              <ul className="lcars-chat__seed-list">
                {SEED_QUESTIONS.map((q) => (
                  <li key={q.label}>
                    <button
                      type="button"
                      className="lcars-chat__seed-button"
                      onClick={() => handleSeedClick(q)}
                    >
                      <span className="lcars-chat__seed-label">{q.label}</span>
                      <span className="lcars-chat__seed-q">{q.question}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {activeChat &&
            activeChat.turns.map((t: ChatTurn) =>
              t.role === 'user' ? (
                <div key={t.id} className="lcars-chat-message lcars-chat-message--user">
                  <pre className="lcars-chat-message__user-text">{t.content}</pre>
                </div>
              ) : (
                <div key={t.id} className="lcars-chat-message__wrap">
                  {t.trace && t.trace.length > 0 && (
                    <AgentTrace events={t.trace} mode="archived" />
                  )}
                  <ChatStreamedMessage
                    text={t.content}
                    citations={t.citations ?? []}
                    onCitationClick={onSelectSession}
                    variant="final"
                  />
                </div>
              ),
            )}
          {inFlight && (
            <div className="lcars-chat-message__wrap">
              <AgentTrace events={inFlight.trace} mode="live" />
              <ChatStreamedMessage
                text={inFlight.text}
                citations={inFlight.citations}
                onCitationClick={onSelectSession}
                variant="live"
              />
              {inFlight.error && (
                <div className="lcars-chat-message__error">{inFlight.error}</div>
              )}
            </div>
          )}
        </div>

        <form
          className="lcars-chat__inputbar"
          onSubmit={(e) => {
            e.preventDefault();
            handleSendClick();
          }}
        >
          <textarea
            ref={inputRef}
            className="lcars-chat__input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              intent === 'ask'
                ? 'Ask a question about your archived conversations…'
                : 'Ask for blog post / content ideas, or other opportunities…'
            }
            rows={3}
            maxLength={CHAT_QUESTION_MAX_CHARS}
            disabled={!!inFlight}
            aria-label="chat input"
          />
          <button
            type="submit"
            className="lcars-chat__send"
            disabled={!!inFlight || input.trim().length === 0}
          >
            {inFlight ? 'THINKING…' : 'SEND ⌘↵'}
          </button>
        </form>
      </section>

      <DisclosureModal
        open={disclosureOpen}
        onAcknowledge={handleDisclosureAck}
        onCancel={handleDisclosureCancel}
      />

      {confirmClear && (
        <div className="lcars-chat-disclosure" role="dialog" aria-modal="true">
          <div
            className="lcars-chat-disclosure__backdrop"
            onClick={() => setConfirmClear(false)}
          />
          <div className="lcars-chat-disclosure__panel">
            <h2 className="lcars-chat-disclosure__title">CLEAR ALL CHAT HISTORY?</h2>
            <p>This wipes every conversation from this browser. Cannot be undone.</p>
            <div className="lcars-chat-disclosure__actions">
              <button
                type="button"
                className="lcars-chat-disclosure__cancel"
                onClick={() => setConfirmClear(false)}
              >
                CANCEL
              </button>
              <button
                type="button"
                className="lcars-chat-disclosure__confirm"
                onClick={() => void handleClearAll()}
              >
                CLEAR
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
