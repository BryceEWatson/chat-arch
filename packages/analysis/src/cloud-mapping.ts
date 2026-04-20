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
 * Minimum length for a project name to qualify as a matching pattern. Short
 * names ("Art", "AI") collide with common English words across arbitrary
 * conversation titles and produce false positives. Five characters is the
 * threshold that survives the noise on a validation run against a real
 * 1041-conversation export (see the conversation log adjacent to this file
 * for the measurement methodology).
 */
const MIN_PROJECT_NAME_LEN = 5;

/**
 * Common-word denylist — project names that are also ordinary English
 * words would pull in conversations that merely mention the concept
 * without being about that project. Expand cautiously; false negatives
 * (a real project we fail to label) are strictly preferable to false
 * positives (dozens of unrelated conversations tagged with a project
 * they're not about).
 */
const PROJECT_NAME_DENYLIST = new Set<string>([
  'art',
  'design',
  'research',
  'notes',
  'ideas',
  'draft',
  'drafts',
  'demo',
  'test',
  'tests',
  'project',
  'projects',
  'script',
  'scripts',
  'chat',
  'main',
  'code',
  'work',
  'tasks',
  'todo',
  'personal',
  'general',
  'misc',
]);

interface CompiledProjectPattern {
  id: string;
  displayName: string;
  re: RegExp;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIALS, '\\$&');
}

/**
 * Compile a regex list from the cloud export's own `projects.json`. Used
 * by `buildCloudEntries` to populate `session.project` for conversations
 * whose title mentions a user-created project by name.
 *
 * Filters: minimum name length (`MIN_PROJECT_NAME_LEN`), common-word
 * denylist (`PROJECT_NAME_DENYLIST`). The remaining names are matched
 * against the conversation title with a case-insensitive word-boundary
 * regex. Title-only match (not summary / preview) — the validation run
 * showed summary content is too noisy and the coverage too low to be
 * worth the extra false-positive surface.
 */
export function compileProjectPatterns(
  projects: readonly CloudProject[] | undefined,
): readonly CompiledProjectPattern[] {
  if (!projects || projects.length === 0) return [];
  const out: CompiledProjectPattern[] = [];
  for (const p of projects) {
    if (typeof p.name !== 'string') continue;
    const name = p.name.trim();
    if (name.length < MIN_PROJECT_NAME_LEN) continue;
    if (PROJECT_NAME_DENYLIST.has(name.toLowerCase())) continue;
    out.push({
      id: name,
      displayName: name,
      re: new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'),
    });
  }
  return out;
}

/**
 * First-match-wins resolution against the compiled pattern list. We check
 * the title first, then fall back to the summary when no title match.
 *
 * Why two passes instead of one concatenated haystack: the title carries
 * significantly higher signal (user-authored, short, declarative) while
 * the summary is Claude-authored prose that occasionally uses user-role
 * words like "researcher" / "architect" that collide with project names.
 * Title-first + summary-fallback gives title matches priority without
 * forfeiting coverage on the ~60% of conversations where titles are
 * generic (on a real 1041-conversation corpus, this roughly doubles
 * coverage from 4.9% to 10.8% — mostly true positives, with a handful
 * of role-word collisions we accept as a worthwhile trade).
 */
function matchProject(
  patterns: readonly CompiledProjectPattern[],
  title: string,
  summary: string,
): string | null {
  for (const p of patterns) {
    if (p.re.test(title)) return p.id;
  }
  if (summary.length === 0) return null;
  for (const p of patterns) {
    if (p.re.test(summary)) return p.id;
  }
  return null;
}

/**
 * Pure conversion from raw cloud JSON payloads to the unified entry array +
 * the lookup map the viewer uses for drill-in. No I/O, no side effects,
 * deterministic for the same input.
 */
export function buildCloudEntries(data: CloudSourceData): CloudMappingResult {
  const entries: UnifiedSessionEntry[] = [];
  const conversationsById = new Map<string, CloudConversation>();
  const projectPatterns = compileProjectPatterns(data.projects);
  let summaryCount = 0;
  let skipped = 0;

  for (const conv of data.conversations) {
    const built = buildEntry(conv, projectPatterns);
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
 *
 * `projectPatterns` is the compiled list from the export's own
 * `projects.json` (see `compileProjectPatterns`). When a conversation's
 * title matches a project name by word-boundary, `entry.project` is set
 * to that project's id. Pass `[]` (or omit) to opt out.
 */
export function buildEntry(
  conv: CloudConversation,
  projectPatterns: readonly CompiledProjectPattern[] = [],
): UnifiedSessionEntry | null {
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

  // Project label — matched against title first (high signal) then summary
  // (fallback), first-match-wins, using the export's own `projects.json`
  // names as the allowlist. Coverage on a real 1041-conversation corpus:
  // ~11% of conversations labeled; the rest stay unlabeled rather than
  // risk noise from generic project names. See `compileProjectPatterns`
  // for the length + denylist safeguards and `matchProject` for the
  // title-first/summary-fallback ordering rationale.
  const matchedProject = hasName
    ? matchProject(projectPatterns, name, hasSummary ? summary : '')
    : null;

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
    ...(matchedProject !== null ? { project: matchedProject } : {}),
    transcriptPath: `cloud-conversations/${conv.uuid}.json`,
  };

  return entry;
}

/**
 * First `text` block from the first human message, or `undefined`. Exported
 * so the browser viewer's in-page duplicate pass can extract the same input
 * the Node exporter does. Keeping one implementation avoids the two-code-
 * paths drift the architecture reviewer flagged.
 */
export function firstHumanText(
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
 * All human messages' text, in message order, each as its own string.
 * Skips assistant, tool_use, tool_result, and thinking blocks — those
 * are Claude's side of the conversation and would overwhelm the topic
 * signal of the user's actual asks.
 *
 * Used by the Phase-3 semantic classifier to build a fuller picture of
 * "what this conversation was about" than `firstHumanText` alone. A
 * 20-turn conversation where the user pivoted from "debug this query"
 * to "write tests for it" picks up both topics when all human text is
 * considered; `firstHumanText` would only see "debug this query".
 *
 * Empty-text human messages are skipped rather than returned as blanks
 * so callers can concatenate without accidental empty separators.
 */
export function allHumanText(
  messages: readonly CloudConversation['chat_messages'][number][] | undefined,
): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (const msg of messages) {
    if (msg.sender !== 'human') continue;
    let captured = false;
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b && typeof b === 'object' && b.type === 'text') {
          const t = (b as { text?: unknown }).text;
          if (typeof t === 'string' && t.length > 0) {
            out.push(t);
            captured = true;
          }
        }
      }
    }
    if (!captured && typeof msg.text === 'string' && msg.text.length > 0) {
      out.push(msg.text);
    }
  }
  return out;
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
