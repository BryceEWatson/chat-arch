import { useMemo } from 'react';
import type { ChatCitation } from '@chat-arch/schema';
import { CitationChip } from './CitationChip.js';

export interface ChatStreamedMessageProps {
  /** Full markdown text accumulated so far (or final). */
  text: string;
  /** Citations the endpoint validated for this message. */
  citations: readonly ChatCitation[];
  /**
   * Click handler for citation chips. Explicit `| undefined` so callers
   * forwarding an already-optional prop don't need a conditional spread.
   */
  onCitationClick?: ((sessionId: string) => void) | undefined;
  /** Render variant. `live` adds a typing caret at end; `final` does not. */
  variant: 'live' | 'final';
}

const SID_RE = /\[SID:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/**
 * Render assistant markdown with inline citation chips. Phase 1: a tight
 * subset of markdown is supported inline (paragraphs, line breaks,
 * bold, italic, inline code, code blocks, headers, bullet lists). Full
 * markdown (links, images, tables) is deferred — the agent's prompt is
 * tuned to emit this subset.
 *
 * Sanitization model: we never inject raw HTML. The renderer walks the
 * text and produces React elements directly — there's no `dangerouslySet
 * InnerHTML` anywhere, so a token containing `<img onerror=...>` is
 * rendered as literal text, not executed. This makes the streamed-
 * markdown XSS surface from the adversarial review (A12) a non-issue
 * by construction.
 */
export function ChatStreamedMessage({
  text,
  citations,
  onCitationClick,
  variant,
}: ChatStreamedMessageProps) {
  const citationBySid = useMemo(() => {
    const m = new Map<string, ChatCitation>();
    for (const c of citations) m.set(c.sessionId.toLowerCase(), c);
    return m;
  }, [citations]);

  const nodes = useMemo(() => renderMarkdown(text, citationBySid, onCitationClick), [
    text,
    citationBySid,
    onCitationClick,
  ]);

  return (
    <div className="lcars-chat-message lcars-chat-message--assistant">
      {nodes}
      {variant === 'live' && <span className="lcars-chat-message__caret" aria-hidden="true">▍</span>}
    </div>
  );
}

interface Block {
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'code' | 'ul';
  content: string;
  items?: string[];
  lang?: string;
}

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Code block
    const codeFence = /^```(\w+)?$/.exec(line);
    if (codeFence) {
      const lang = codeFence[1] ?? '';
      const start = i + 1;
      let end = start;
      while (end < lines.length && !/^```$/.test(lines[end]!)) end += 1;
      blocks.push({ kind: 'code', content: lines.slice(start, end).join('\n'), lang });
      i = end + 1;
      continue;
    }
    // Headers
    if (/^# /.test(line)) {
      blocks.push({ kind: 'h1', content: line.slice(2) });
      i += 1;
      continue;
    }
    if (/^## /.test(line)) {
      blocks.push({ kind: 'h2', content: line.slice(3) });
      i += 1;
      continue;
    }
    if (/^### /.test(line)) {
      blocks.push({ kind: 'h3', content: line.slice(4) });
      i += 1;
      continue;
    }
    // Bullet list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i]!)) {
        items.push(lines[i]!.slice(2));
        i += 1;
      }
      blocks.push({ kind: 'ul', content: '', items });
      continue;
    }
    // Skip blank lines between blocks
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    // Paragraph — collect until blank line or block-starter
    const paraStart = i;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim().length === 0) break;
      if (/^```/.test(l) || /^#{1,3} /.test(l) || /^[-*] /.test(l)) break;
      i += 1;
    }
    blocks.push({ kind: 'p', content: lines.slice(paraStart, i).join('\n') });
  }
  return blocks;
}

function renderMarkdown(
  text: string,
  citationBySid: Map<string, ChatCitation>,
  onCitationClick: ((sid: string) => void) | undefined,
): React.ReactNode[] {
  const blocks = parseBlocks(text);
  return blocks.map((block, ix) => {
    const key = `b${ix}`;
    if (block.kind === 'code') {
      return (
        <pre key={key} className="lcars-chat-message__code">
          <code data-lang={block.lang || undefined}>{block.content}</code>
        </pre>
      );
    }
    if (block.kind === 'h1') return <h1 key={key} className="lcars-chat-message__h1">{renderInline(block.content, citationBySid, onCitationClick)}</h1>;
    if (block.kind === 'h2') return <h2 key={key} className="lcars-chat-message__h2">{renderInline(block.content, citationBySid, onCitationClick)}</h2>;
    if (block.kind === 'h3') return <h3 key={key} className="lcars-chat-message__h3">{renderInline(block.content, citationBySid, onCitationClick)}</h3>;
    if (block.kind === 'ul') {
      return (
        <ul key={key} className="lcars-chat-message__ul">
          {(block.items ?? []).map((item, jx) => (
            <li key={jx}>{renderInline(item, citationBySid, onCitationClick)}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={key} className="lcars-chat-message__p">
        {renderInline(block.content, citationBySid, onCitationClick)}
      </p>
    );
  });
}

/**
 * Walk an inline text segment producing React nodes for plain text,
 * `[SID:...]` chips, **bold**, *italic*, and `inline code`. The walker
 * is intentionally simple — overlapping syntax (bold-inside-italic-
 * inside-code) falls through to plain text rather than going down a
 * full parser rabbit hole. Markdown produced by the chat-answer skill
 * is well-behaved enough that this trade-off doesn't bite in practice.
 */
function renderInline(
  text: string,
  citationBySid: Map<string, ChatCitation>,
  onCitationClick: ((sid: string) => void) | undefined,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  SID_RE.lastIndex = 0;
  const matches: { start: number; end: number; sid: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = SID_RE.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, sid: m[1]!.toLowerCase() });
  }
  // Walk matches; render non-match runs via renderTextRun (handles
  // bold/italic/code), interleaved with citation chips.
  let key = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      out.push(...renderTextRun(text.slice(cursor, match.start), () => key++));
    }
    const cit = citationBySid.get(match.sid);
    if (cit) {
      out.push(<CitationChip key={`c${key++}`} citation={cit} onActivate={onCitationClick} verified={true} />);
    } else {
      out.push(
        <CitationChip
          key={`c${key++}`}
          citation={{ sessionId: match.sid, source: 'cowork' }}
          onActivate={onCitationClick}
          verified={false}
        />,
      );
    }
    cursor = match.end;
  }
  if (cursor < text.length) {
    out.push(...renderTextRun(text.slice(cursor), () => key++));
  }
  return out;
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

function renderTextRun(text: string, nextKey: () => number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={`s${nextKey()}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={`e${nextKey()}`}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith('`')) {
      out.push(<code key={`k${nextKey()}`}>{tok.slice(1, -1)}</code>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
