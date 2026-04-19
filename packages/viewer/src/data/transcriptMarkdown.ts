import type { CloudConversation, UnifiedSessionEntry } from '@chat-arch/schema';
import type { DrillInBody, LocalTranscriptEntry } from '../types.js';
import { lineTextPreview } from './transcriptParse.js';

/**
 * Build a Markdown transcript per Decision 12.
 *
 * Cloud sessions produce `## Human` / `## Assistant` headers per turn.
 * Local (CLI / Cowork) transcripts produce `## {kind}` headers per
 * entry — each transcript line has a `type` field (user, assistant,
 * attachment, ai-title, …) which becomes the header.
 *
 * Output is plain Markdown — no frontmatter, no metadata table beyond
 * the session title line. Keeping it copy-paste-friendly for Claude.ai
 * or Notion.
 */

function cloudMessageBody(m: CloudConversation['chat_messages'][number]): string {
  // Prefer explicit content blocks; fall back to `text` field; final
  // fallback to an empty string so we still emit the header.
  if (m.content.length > 0) {
    const parts: string[] = [];
    for (const block of m.content) {
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text);
      } else if (block.type === 'tool_use') {
        // Render tool_use blocks as fenced JSON so they survive paste.
        const b = block as { name?: string; input?: unknown };
        const input = JSON.stringify(b.input ?? {}, null, 2);
        parts.push(`*tool_use: ${b.name ?? '?'}*\n\`\`\`json\n${input}\n\`\`\``);
      } else if (block.type === 'tool_result') {
        const b = block as { content?: unknown };
        const body =
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '', null, 2);
        parts.push(`*tool_result*\n\`\`\`\n${body}\n\`\`\``);
      } else {
        parts.push(`*(${block.type})*`);
      }
    }
    return parts.join('\n\n');
  }
  if (typeof m.text === 'string' && m.text.length > 0) return m.text;
  return '';
}

function cloudMarkdown(title: string, conv: CloudConversation): string {
  const lines: string[] = [`# ${title}`, ''];
  for (const m of conv.chat_messages) {
    const header =
      m.sender === 'human'
        ? '## Human'
        : m.sender === 'assistant'
          ? '## Assistant'
          : `## ${String(m.sender)}`;
    lines.push(header);
    lines.push('');
    const body = cloudMessageBody(m);
    if (body) {
      lines.push(body);
      lines.push('');
    }
    if (m.attachments && m.attachments.length > 0) {
      for (const a of m.attachments) {
        lines.push(`*attachment: ${a.file_name} (${a.file_type})*`);
        if (a.extracted_content) {
          lines.push('');
          lines.push('```');
          lines.push(a.extracted_content);
          lines.push('```');
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

function localEntryKind(e: LocalTranscriptEntry): string {
  if (e.type === '_malformed') return '_malformed';
  const t = e.line['type'];
  return typeof t === 'string' ? t : 'unknown';
}

function localMarkdown(title: string, entries: readonly LocalTranscriptEntry[]): string {
  const lines: string[] = [`# ${title}`, ''];
  for (const entry of entries) {
    const kind = localEntryKind(entry);
    lines.push(`## ${kind}`);
    lines.push('');
    if (entry.type === '_malformed') {
      lines.push('```');
      lines.push(entry.raw);
      lines.push('```');
      lines.push('');
    } else {
      const preview = lineTextPreview(entry.line);
      if (preview) {
        lines.push(preview);
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

export function buildTranscriptMarkdown(session: UnifiedSessionEntry, body: DrillInBody): string {
  const title = session.title || 'Untitled session';
  if (body.kind === 'cloud') return cloudMarkdown(title, body.conversation);
  return localMarkdown(title, body.entries);
}
