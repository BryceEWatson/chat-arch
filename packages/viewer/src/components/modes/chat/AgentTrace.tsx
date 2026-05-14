import { useState } from 'react';
import type { ChatTraceEvent } from '@chat-arch/schema';

export interface AgentTraceProps {
  events: readonly ChatTraceEvent[];
  /**
   * Render mode. `live` is used during an in-flight turn (auto-expand,
   * latest event always visible). `archived` is used for completed turns
   * in history (collapsed by default — user can expand).
   */
  mode: 'live' | 'archived';
}

const TOOL_GLYPH: Record<string, string> = {
  Read: '📄',
  Grep: '🔍',
  Glob: '🗂',
  Task: '🤖',
};

/**
 * The "visible thinking" strip. During an in-flight turn the user sees
 * the agent's actual process — what it's grepping, what files it's
 * reading, when it spawns a sub-agent. This is the chat's transparency
 * surface; the v3 plan calls it the demo-unlock moment.
 *
 * `live` mode auto-renders the latest event prominently; `archived`
 * collapses everything behind a summary toggle so old turns don't
 * dominate the scroll.
 */
export function AgentTrace({ events, mode }: AgentTraceProps) {
  const [expanded, setExpanded] = useState(mode === 'live');

  if (events.length === 0) return null;

  const counts = countByKind(events);
  const summary = formatSummary(counts);

  return (
    <details
      className={`lcars-chat-trace lcars-chat-trace--${mode}`}
      open={expanded}
      onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="lcars-chat-trace__summary">
        <span className="lcars-chat-trace__label">AGENT TRACE</span>
        <span className="lcars-chat-trace__counts">{summary}</span>
      </summary>
      <ol className="lcars-chat-trace__list" aria-live={mode === 'live' ? 'polite' : 'off'}>
        {events.map((ev, ix) => (
          <li key={ix} className={`lcars-chat-trace__item lcars-chat-trace__item--${ev.kind}`}>
            {renderEvent(ev)}
          </li>
        ))}
      </ol>
    </details>
  );
}

function countByKind(events: readonly ChatTraceEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ev of events) {
    out[ev.kind] = (out[ev.kind] ?? 0) + 1;
  }
  return out;
}

function formatSummary(counts: Record<string, number>): string {
  const parts: string[] = [];
  if (counts['tool_use']) parts.push(`${counts['tool_use']} tool call${counts['tool_use'] === 1 ? '' : 's'}`);
  if (counts['sub_agent']) parts.push(`${counts['sub_agent']} sub-agent${counts['sub_agent'] === 1 ? '' : 's'}`);
  if (counts['error']) parts.push(`${counts['error']} error${counts['error'] === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' · ') : 'thinking…';
}

function renderEvent(ev: ChatTraceEvent): React.ReactNode {
  if (ev.kind === 'tool_use') {
    return (
      <>
        <span className="lcars-chat-trace__glyph" aria-hidden="true">
          {TOOL_GLYPH[ev.tool] ?? '⚙'}
        </span>
        <code className="lcars-chat-trace__code">{ev.summary}</code>
      </>
    );
  }
  if (ev.kind === 'sub_agent') {
    return (
      <>
        <span className="lcars-chat-trace__glyph" aria-hidden="true">
          {TOOL_GLYPH['Task']}
        </span>
        <code className="lcars-chat-trace__code">
          <strong>{ev.agent}</strong> — {ev.summary}
        </code>
      </>
    );
  }
  if (ev.kind === 'error') {
    return (
      <>
        <span className="lcars-chat-trace__glyph" aria-hidden="true">⚠</span>
        <code className="lcars-chat-trace__code">{ev.message}</code>
      </>
    );
  }
  // thinking — small italic preview
  return (
    <>
      <span className="lcars-chat-trace__glyph" aria-hidden="true">·</span>
      <em className="lcars-chat-trace__thinking">{ev.preview}</em>
    </>
  );
}
