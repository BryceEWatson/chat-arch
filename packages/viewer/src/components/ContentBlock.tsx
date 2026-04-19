import type {
  CloudContentBlock,
  CloudTextBlock,
  CloudThinkingBlock,
  CloudToolUseBlock,
  CloudToolResultBlock,
} from '@chat-arch/schema';

export interface ContentBlockProps {
  block: CloudContentBlock;
}

/**
 * Renders one cloud content block. Cloud content blocks are a sum type:
 * text, thinking, tool_use, tool_result, token_budget, or unknown.
 *
 * Note on discriminant narrowing: `CloudUnknownBlock.type` is typed as
 * plain `string`, which widens the union so tsc can't auto-narrow on the
 * literal-string comparisons. We use small `is*` guards to narrow per case.
 */
function isText(b: CloudContentBlock): b is CloudTextBlock {
  return b.type === 'text' && typeof (b as CloudTextBlock).text === 'string';
}
function isThinking(b: CloudContentBlock): b is CloudThinkingBlock {
  return b.type === 'thinking' && typeof (b as CloudThinkingBlock).thinking === 'string';
}
function isToolUse(b: CloudContentBlock): b is CloudToolUseBlock {
  return b.type === 'tool_use' && typeof (b as CloudToolUseBlock).name === 'string';
}
function isToolResult(b: CloudContentBlock): b is CloudToolResultBlock {
  return b.type === 'tool_result' && Array.isArray((b as CloudToolResultBlock).content);
}

/** Keywords that earn the ice highlight inside prose. Extend as new
 *  platform nouns show up often enough to deserve a pass. */
const HIGHLIGHT_RE =
  /\b(SQLite|JSON|MLOps|TypeScript|Claude Code|Antonio|GCP|BetterAuth|SAML|SSO)\b/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline markdown → HTML for the LCARS prose renderer. Handles `**bold**`
 * → sunflower-weighted strong, backtick-wrapped → ice-tint code, and
 * keyword highlights per the accent contract. Block-level splitting
 * (headings, list items, spacers) is done by the caller.
 *
 * Order matters — escape first, then apply markdown so `**` in user text
 * like "&lt;**bold**&gt;" still renders as bold rather than literal HTML.
 */
function renderInline(raw: string): string {
  const escaped = escapeHtml(raw);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(HIGHLIGHT_RE, '<span class="lcars-prose__hl">$1</span>');
}

/**
 * Render a text block as LCARS prose. Lines starting with `**...**` become
 * sunflower-caps section headings; `- ` starts a ▸-bulleted list item;
 * blank lines produce a small spacer. Everything else is a paragraph.
 */
function ProseText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="lcars-cb lcars-cb--text lcars-prose">
      {lines.map((line, i) => {
        const key = `${i}`;
        const trimmed = line.trim();
        if (!trimmed) return <div key={key} className="lcars-prose__sp" />;
        // "**Heading text**" on its own line — a section heading.
        if (/^\*\*[^*].*\*\*$/.test(trimmed)) {
          return (
            <h4 key={key} className="lcars-prose__h">
              {trimmed.replace(/^\*\*|\*\*$/g, '')}
            </h4>
          );
        }
        // "- item" bullet. CSS renders ▸ via ::before.
        if (/^-\s+/.test(line)) {
          return (
            <li
              key={key}
              className="lcars-prose__li"
              dangerouslySetInnerHTML={{ __html: renderInline(line.replace(/^-\s+/, '')) }}
            />
          );
        }
        return (
          <p
            key={key}
            className="lcars-prose__p"
            dangerouslySetInnerHTML={{ __html: renderInline(line) }}
          />
        );
      })}
    </div>
  );
}

export function ContentBlock({ block }: ContentBlockProps) {
  if (isText(block)) {
    return <ProseText text={block.text} />;
  }
  if (isThinking(block)) {
    return (
      <details className="lcars-cb lcars-cb--thinking">
        <summary>▸ THINKING</summary>
        <p>{block.thinking}</p>
      </details>
    );
  }
  if (isToolUse(block)) {
    const input =
      block.input === undefined
        ? ''
        : typeof block.input === 'string'
          ? block.input
          : JSON.stringify(block.input, null, 2);
    return (
      <div className="lcars-cb lcars-cb--tool-use">
        <div className="lcars-cb__label">TOOL · {block.name}</div>
        {input && <pre className="lcars-cb__pre">{input}</pre>}
      </div>
    );
  }
  if (isToolResult(block)) {
    const textParts: string[] = [];
    for (const item of block.content) {
      if (
        item &&
        typeof item === 'object' &&
        'text' in item &&
        typeof (item as { text: unknown }).text === 'string'
      ) {
        textParts.push((item as { text: string }).text);
      }
    }
    return (
      <div className="lcars-cb lcars-cb--tool-result">
        <div className="lcars-cb__label">RESULT{block.is_error ? ' · ERROR' : ''}</div>
        {textParts.length > 0 ? (
          <pre className="lcars-cb__pre">{textParts.join('\n')}</pre>
        ) : (
          <span className="lcars-cb__dim">(non-text result)</span>
        )}
      </div>
    );
  }
  if (block.type === 'token_budget') {
    return (
      <div className="lcars-cb lcars-cb--token-budget">
        <span className="lcars-cb__label">TOKEN BUDGET</span>
      </div>
    );
  }
  return (
    <div className="lcars-cb lcars-cb--unknown">
      <span className="lcars-cb__label">UNKNOWN BLOCK · {block.type}</span>
    </div>
  );
}
