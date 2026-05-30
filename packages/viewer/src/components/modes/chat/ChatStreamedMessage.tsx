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
  /**
   * Click handler for follow-up chips (`→ Question?` lines the agent
   * emits at the end of an answer). Receives the question text exactly
   * as the agent wrote it; the host typically resubmits it as a new turn.
   */
  onFollowUpClick?: ((question: string) => void) | undefined;
  /** Render variant. `live` adds a typing caret at end; `final` does not. */
  variant: 'live' | 'final';
}

const SID_RE = /\[SID:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/**
 * H2 headings whose section should render collapsed-by-default. The
 * skill emits methodology / caveats / risks under these literal labels
 * (see `.claude/skills/chat-answer/SKILL.md` "Style" section). Match
 * is case-insensitive against the trimmed heading text. Anything else
 * renders as a normal H2.
 *
 * Why collapsed-by-default: the answer's headline + evidence is what
 * the user is here for; methodology/caveats/risks are trust artifacts
 * they can opt into. This is a presentation rule only — the prose
 * content itself is unchanged, so cutting the chrome doesn't elide
 * any of the skill's anti-Goodhart disciplines (counts-with-grep-
 * patterns, character-exact quotes) — those still ship in the body.
 */
const COLLAPSIBLE_TITLE_RE =
  /^(?:honest\s+)?(caveats?|negatives?|methodology|calibration|risks?|honest\s+notes?)$/i;

/** Lines that begin with this prefix are turned into follow-up chips. */
const FOLLOWUP_LINE_RE = /^→\s+(.+)$/;

/**
 * Render assistant markdown with inline citation chips, collapsible
 * trust-artifact sections (`## Caveats`, `## Methodology`, `## Risks`),
 * and follow-up chips (lines prefixed with `→ `). Tight subset of
 * markdown otherwise: paragraphs, line breaks, bold, italic, inline
 * code, code blocks, headers, bullet lists. Full markdown (links,
 * images, tables) is deferred — the agent's prompt is tuned to emit
 * this subset.
 *
 * Sanitization model: we never inject raw HTML. The renderer walks
 * the text and produces React elements directly — there's no
 * `dangerouslySetInnerHTML` anywhere, so a token containing
 * `<img onerror=...>` is rendered as literal text, not executed.
 */
export function ChatStreamedMessage({
  text,
  citations,
  onCitationClick,
  onFollowUpClick,
  variant,
}: ChatStreamedMessageProps) {
  const citationBySid = useMemo(() => {
    const m = new Map<string, ChatCitation>();
    for (const c of citations) m.set(c.sessionId.toLowerCase(), c);
    return m;
  }, [citations]);

  const nodes = useMemo(
    () => renderMarkdown(text, citationBySid, onCitationClick, onFollowUpClick),
    [text, citationBySid, onCitationClick, onFollowUpClick],
  );

  return (
    <div className="lcars-chat-message lcars-chat-message--assistant">
      {nodes}
      {variant === 'live' && <span className="lcars-chat-message__caret" aria-hidden="true">▍</span>}
    </div>
  );
}

interface Block {
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'code' | 'ul' | 'followups' | 'collapsible';
  content: string;
  items?: string[];
  lang?: string;
  /** For 'collapsible': summary text rendered in <summary>. */
  title?: string;
  /** For 'collapsible': flat blocks rendered inside <details>. */
  inner?: Block[];
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
    // Follow-up chip lines — consume consecutive `→ ` lines into one
    // block. Treated as a sibling of bullet lists so the renderer can
    // emit a chip group instead of a paragraph wall.
    if (FOLLOWUP_LINE_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = FOLLOWUP_LINE_RE.exec(lines[i]!);
        if (!m) break;
        items.push(m[1]!.trim());
        i += 1;
      }
      blocks.push({ kind: 'followups', content: '', items });
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
      if (FOLLOWUP_LINE_RE.test(l)) break;
      i += 1;
    }
    blocks.push({ kind: 'p', content: lines.slice(paraStart, i).join('\n') });
  }
  return blocks;
}

/**
 * Post-process flat blocks: when an H2 matches the collapsible-title
 * pattern, fold it and the following blocks (until next H1/H2 or end)
 * into a single `collapsible` block. This is a presentation transform
 * only — content is preserved verbatim; only the chrome that wraps it
 * changes.
 *
 * Boundary: any subsequent H1 or H2 closes the section. H3 stays inside.
 * That matches the skill's section convention (H2 for top-level
 * sections, H3 for subsections within them).
 */
function groupCollapsibles(blocks: Block[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (b.kind === 'h2' && COLLAPSIBLE_TITLE_RE.test(b.content.trim())) {
      const inner: Block[] = [];
      let j = i + 1;
      while (j < blocks.length) {
        const next = blocks[j]!;
        if (next.kind === 'h1' || next.kind === 'h2') break;
        inner.push(next);
        j += 1;
      }
      out.push({ kind: 'collapsible', content: '', title: b.content, inner });
      i = j;
      continue;
    }
    out.push(b);
    i += 1;
  }
  return out;
}

function renderMarkdown(
  text: string,
  citationBySid: Map<string, ChatCitation>,
  onCitationClick: ((sid: string) => void) | undefined,
  onFollowUpClick: ((question: string) => void) | undefined,
): React.ReactNode[] {
  const flat = parseBlocks(text);
  const blocks = groupCollapsibles(flat);
  return blocks.map((block, ix) =>
    renderBlock(block, `b${ix}`, citationBySid, onCitationClick, onFollowUpClick),
  );
}

function renderBlock(
  block: Block,
  key: string,
  citationBySid: Map<string, ChatCitation>,
  onCitationClick: ((sid: string) => void) | undefined,
  onFollowUpClick: ((question: string) => void) | undefined,
): React.ReactNode {
  if (block.kind === 'code') {
    return (
      <pre key={key} className="lcars-chat-message__code" tabIndex={0}>
        <code data-lang={block.lang || undefined}>{block.content}</code>
      </pre>
    );
  }
  if (block.kind === 'h1') {
    return (
      <h1 key={key} className="lcars-chat-message__h1">
        {renderInline(block.content, citationBySid, onCitationClick)}
      </h1>
    );
  }
  if (block.kind === 'h2') {
    return (
      <h2 key={key} className="lcars-chat-message__h2">
        {renderInline(block.content, citationBySid, onCitationClick)}
      </h2>
    );
  }
  if (block.kind === 'h3') {
    return (
      <h3 key={key} className="lcars-chat-message__h3">
        {renderInline(block.content, citationBySid, onCitationClick)}
      </h3>
    );
  }
  if (block.kind === 'ul') {
    return (
      <ul key={key} className="lcars-chat-message__ul">
        {(block.items ?? []).map((item, jx) => (
          <li key={jx}>{renderInline(item, citationBySid, onCitationClick)}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === 'followups') {
    const items = block.items ?? [];
    if (items.length === 0) return null;
    return (
      <div key={key} className="lcars-chat-message__followups" role="group" aria-label="suggested follow-up questions">
        {items.map((q, jx) => (
          <button
            type="button"
            key={jx}
            className="lcars-chat-message__followup"
            onClick={() => onFollowUpClick?.(q)}
            disabled={!onFollowUpClick}
            title={onFollowUpClick ? 'Ask this as a follow-up' : 'Suggested follow-up'}
          >
            <span className="lcars-chat-message__followup-arrow" aria-hidden="true">→</span>
            <span className="lcars-chat-message__followup-text">{q}</span>
          </button>
        ))}
      </div>
    );
  }
  if (block.kind === 'collapsible') {
    return (
      <details key={key} className="lcars-chat-message__details">
        <summary className="lcars-chat-message__details-summary">
          {renderInline(block.title ?? '', citationBySid, onCitationClick)}
        </summary>
        <div className="lcars-chat-message__details-body">
          {(block.inner ?? []).map((b, jx) =>
            renderBlock(b, `${key}-i${jx}`, citationBySid, onCitationClick, onFollowUpClick),
          )}
        </div>
      </details>
    );
  }
  return (
    <p key={key} className="lcars-chat-message__p">
      {renderInline(block.content, citationBySid, onCitationClick)}
    </p>
  );
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
  const total = matches.length;
  for (let mi = 0; mi < matches.length; mi++) {
    const match = matches[mi]!;
    if (match.start > cursor) {
      out.push(...renderTextRun(text.slice(cursor, match.start), () => key++));
    }
    const cit = citationBySid.get(match.sid);
    if (cit) {
      out.push(
        <CitationChip
          key={`c${key++}`}
          citation={cit}
          onActivate={onCitationClick}
          verified={true}
          index={mi + 1}
          total={total}
        />,
      );
    } else {
      out.push(
        <CitationChip
          key={`c${key++}`}
          citation={{ sessionId: match.sid, source: 'cowork' }}
          onActivate={onCitationClick}
          verified={false}
          index={mi + 1}
          total={total}
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
