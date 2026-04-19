/**
 * Pure mapping from raw cloud-export JSON payloads to UnifiedSessionEntry.
 *
 * ZERO Node imports — this module must run unchanged in the browser so the
 * viewer can accept a user-uploaded Settings→Privacy cloud ZIP directly.
 * If you add a `node:fs`, `node:path`, or similar import here, the viewer's
 * upload path breaks and bundling will drag Node polyfills in.
 *
 * Node-specific concerns (ZIP extraction, temp dirs, file I/O, slim manifest
 * writing) live in `src/sources/cloud.ts` and call into this module.
 */

import type {
  CloudConversation,
  CloudContentBlock,
  CloudToolUseBlock,
  CloudProject,
  CloudUser,
  CloudMemories,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import { UNTITLED_SESSION } from '@chat-arch/schema';

const MAX_PREVIEW_CHARS = 200;

/**
 * Raw payloads read from a cloud export ZIP. Only `conversations` is required;
 * the rest are reserved for future enrichments (projects list, user card,
 * saved memories).
 */
export interface CloudSourceData {
  conversations: readonly CloudConversation[];
  projects?: readonly CloudProject[];
  users?: readonly CloudUser[];
  memories?: readonly CloudMemories[];
}

export interface CloudMappingResult {
  /** UnifiedSessionEntry array, sorted by `updatedAt` desc. */
  entries: UnifiedSessionEntry[];
  /** Lookup map (conversation.uuid → conversation) for in-memory drill-in. */
  conversationsById: Map<string, CloudConversation>;
  /** How many conversations carry a non-empty summary. */
  summaryCount: number;
  /** How many conversations were skipped due to unparseable timestamps. */
  conversationsSkipped: number;
}

/**
 * Pure conversion from raw cloud JSON payloads to the unified entry array +
 * the lookup map the viewer uses for drill-in. No I/O, no side effects,
 * deterministic for the same input.
 */
export function buildCloudEntries(data: CloudSourceData): CloudMappingResult {
  const entries: UnifiedSessionEntry[] = [];
  const conversationsById = new Map<string, CloudConversation>();
  let summaryCount = 0;
  let skipped = 0;

  for (const conv of data.conversations) {
    const built = buildEntry(conv);
    if (built === null) {
      skipped += 1;
      continue;
    }
    if (typeof conv.summary === 'string' && conv.summary.length > 0) {
      summaryCount += 1;
    }
    conversationsById.set(conv.uuid, conv);
    entries.push(built);
  }

  entries.sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    entries,
    conversationsById,
    summaryCount,
    conversationsSkipped: skipped,
  };
}

/**
 * Field mapping per doc 06 §8 + R1. Returns `null` when the conversation
 * lacks parseable `created_at` / `updated_at` — callers should count it as
 * a skip and (optionally) warn.
 *
 * Exported separately so the Node `runCloudExport` path can reuse it.
 */
export function buildEntry(conv: CloudConversation): UnifiedSessionEntry | null {
  const startedAt = Date.parse(conv.created_at);
  const updatedAt = Date.parse(conv.updated_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt)) {
    return null;
  }
  const durationMs = Math.max(0, updatedAt - startedAt);

  const name = typeof conv.name === 'string' ? conv.name : '';
  const hasName = name.length > 0;
  const title = hasName ? name : UNTITLED_SESSION;
  const titleSource: 'cloud-name' | 'fallback' = hasName ? 'cloud-name' : 'fallback';

  const summary = typeof conv.summary === 'string' ? conv.summary : '';
  const hasSummary = summary.length > 0;

  // Preview: summary if present, else first human message text.
  const previewSource = hasSummary ? summary : (firstHumanText(conv.chat_messages) ?? null);
  const preview = buildPreview(previewSource);

  // Turn counts + tool-use histogram — walk chat_messages once.
  let userTurns = 0;
  let assistantTurns = 0;
  const topTools: Record<string, number> = {};
  const chatMessages: readonly CloudConversation['chat_messages'][number][] = Array.isArray(
    conv.chat_messages,
  )
    ? conv.chat_messages
    : [];
  for (const msg of chatMessages) {
    if (msg.sender === 'human') userTurns += 1;
    else if (msg.sender === 'assistant') assistantTurns += 1;
    // Unknown senders are ignored silently — the Node path used to emit a
    // warnOnce, but warnings belong on the Node side. The browser-safe path
    // produces a deterministic entry and lets the caller report as needed.

    const blocks: readonly CloudContentBlock[] = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type !== 'tool_use') continue;
      const tu = b as CloudToolUseBlock;
      if (typeof tu.name !== 'string' || tu.name.length === 0) continue;
      topTools[tu.name] = (topTools[tu.name] ?? 0) + 1;
    }
  }

  const hasTools = Object.keys(topTools).length > 0;

  // EOP conditional-spread — only required + required-nullable are guaranteed.
  const entry: UnifiedSessionEntry = {
    // REQUIRED
    id: conv.uuid,
    source: 'cloud',
    rawSessionId: conv.uuid,
    startedAt,
    updatedAt,
    durationMs,
    title,
    titleSource,
    preview,
    userTurns,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,

    // OPTIONAL
    ...(assistantTurns > 0 ? { assistantTurns } : {}),
    ...(hasSummary ? { summary } : {}),
    ...(hasTools ? { topTools } : {}),
    transcriptPath: `cloud-conversations/${conv.uuid}.json`,
  };

  return entry;
}

/** First `text` block text from the first human message, or `undefined`. */
function firstHumanText(
  messages: readonly CloudConversation['chat_messages'][number][] | undefined,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const msg of messages) {
    if (msg.sender !== 'human') continue;
    // Prefer structured text block; fall back to flat `text` field.
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && typeof b === 'object' && b.type === 'text') {
          const t = (b as { text?: unknown }).text;
          if (typeof t === 'string' && t.length > 0) return t;
        }
      }
    }
    if (typeof msg.text === 'string' && msg.text.length > 0) return msg.text;
    return undefined; // first human message had no usable text
  }
  return undefined;
}

/**
 * Build a preview string from a raw user-facing string. Local copy of the
 * Node-side helper so this module has no Node imports.
 *
 * - Trims leading/trailing whitespace.
 * - Collapses internal whitespace runs to single spaces for card display.
 * - Truncates to 200 chars (no ellipsis — avoids silently implying "more").
 * - Returns `null` for empty / missing input so the schema's required-nullable
 *   `preview` contract is honored.
 */
function buildPreview(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const collapsed = trimmed.replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_PREVIEW_CHARS) return collapsed;
  return collapsed.slice(0, MAX_PREVIEW_CHARS);
}
