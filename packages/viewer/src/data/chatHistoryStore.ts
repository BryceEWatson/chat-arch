import { createStore, get, set, del, type UseStore } from 'idb-keyval';
import type { ChatConversation, ChatHistoryFile } from '@chat-arch/schema';

/**
 * IndexedDB persistence for the chat page's conversation history.
 *
 * One IndexedDB DB (`chat-arch-chat-history`) → one store (`chats`) →
 * single key (`active`) that holds the versioned envelope. Same pattern
 * as `uploadedDataStore.ts` (one DB per store, idb-keyval's createStore
 * doesn't expose schema-migration without a custom openDB dance).
 *
 * Chat history persists across reloads — questions asked, agent traces,
 * and citations survive a page refresh. The `claudeSessionId` on each
 * conversation is what powers `--resume` on subsequent turns; if the
 * Claude Code session has been cleaned up between turns (rare) the
 * endpoint detects the resume failure and a fresh session id replaces
 * the stale one.
 *
 * **PII reminder (per CLAUDE.md):** the data in this store contains the
 * user's natural-language questions, which can include sensitive
 * context. Treat it like the uploaded archive — never write it to disk,
 * include it in the NuclearReset wipe sequence, and don't surface it
 * outside the user's own browser.
 */

const DB_NAME = 'chat-arch-chat-history';
const STORE_NAME = 'chats';
const KEY = 'active';

let cachedStore: UseStore | null = null;
function storeHandle(): UseStore {
  if (!cachedStore) cachedStore = createStore(DB_NAME, STORE_NAME);
  return cachedStore;
}

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/**
 * Runtime guard — a corrupt entry must not poison the viewer mount.
 * Validates the envelope shape but not deep into each turn (defensive
 * deep validation would mostly fail open on the wire). A bad shape is
 * treated as "no history yet" rather than thrown.
 */
function isChatHistoryFile(v: unknown): v is ChatHistoryFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1) return false;
  if (!Array.isArray(o['chats'])) return false;
  return true;
}

/** Load persisted chat history, or null if absent / unreadable. */
export async function loadChatHistory(): Promise<ChatHistoryFile | null> {
  if (!indexedDbAvailable()) return null;
  try {
    const v = await get<unknown>(KEY, storeHandle());
    if (!isChatHistoryFile(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/** Persist the full chat history envelope (idempotent overwrite). */
export async function saveChatHistory(file: ChatHistoryFile): Promise<void> {
  if (!indexedDbAvailable()) return;
  try {
    await set(KEY, file, storeHandle());
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('chat-arch: failed to persist chat history', err);
    }
  }
}

/**
 * Wipe all chat history. Called from `NuclearReset` alongside the other
 * three DBs (uploaded-cloud-data, semantic-labels, bench-results) so a
 * "delete cloud data" action wipes EVERY personal-data store.
 */
export async function clearChatHistory(): Promise<void> {
  if (!indexedDbAvailable()) return;
  try {
    await del(KEY, storeHandle());
  } catch {
    // best-effort
  }
}

/**
 * Upsert a single conversation into history. Used after each successful
 * turn. Conversations are stored most-recently-updated first so the
 * chat list renders without sorting work in the UI.
 */
export async function upsertConversation(conv: ChatConversation): Promise<ChatHistoryFile> {
  const existing = (await loadChatHistory()) ?? { version: 1 as const, chats: [] };
  const others = existing.chats.filter((c: ChatConversation) => c.chatId !== conv.chatId);
  const next: ChatHistoryFile = {
    version: 1,
    chats: [conv, ...others].sort((a, b) => b.updatedAt - a.updatedAt),
  };
  await saveChatHistory(next);
  return next;
}

/** Test-only: forget the cached store handle so a fresh DB can be opened. */
export function _resetChatHistoryStoreForTest(): void {
  cachedStore = null;
}
