import type { CloudConversation, CloudMessage } from '@chat-arch/schema';
import { ContentBlock } from './ContentBlock.js';

export interface MessageListProps {
  conversation: CloudConversation;
}

function senderLabel(m: CloudMessage): string {
  if (m.sender === 'human') return 'USER';
  if (m.sender === 'assistant') return 'ASSISTANT';
  return String(m.sender).toUpperCase();
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour12: false });
}

// Render bytes as a human-readable size (e.g. "248 KB", "1.4 MB"). The
// raw byte count survives on aria-label for SR users who want precision.
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} bytes`;
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function MessageList({ conversation }: MessageListProps) {
  if (conversation.chat_messages.length === 0) {
    return <div className="lcars-message-list__empty">no messages</div>;
  }
  return (
    <ol className="lcars-message-list">
      {conversation.chat_messages.map((m) => (
        <li key={m.uuid} className={`lcars-message lcars-message--${m.sender}`}>
          <div className="lcars-message__header">
            <span className="lcars-message__sender">{senderLabel(m)}</span>
            <time
              className="lcars-message__time"
              dateTime={m.created_at}
              aria-label={m.created_at}
            >
              {formatTimeOfDay(m.created_at)}
            </time>
          </div>
          <div className="lcars-message__body">
            {m.content.length > 0 ? (
              m.content.map((block, idx) => <ContentBlock key={idx} block={block} />)
            ) : m.text ? (
              <div className="lcars-cb lcars-cb--text">{m.text}</div>
            ) : (
              <div className="lcars-cb lcars-cb--unknown">(message has no body)</div>
            )}
          </div>
          {m.attachments.length > 0 && (
            <ul className="lcars-message__attachments" aria-label="attachments">
              {m.attachments.map((a, i) => (
                <li key={i}>
                  <strong>{a.file_name}</strong>{' '}
                  <span aria-label={`${a.file_type}, ${a.file_size} bytes`}>
                    ({a.file_type}, {formatBytes(a.file_size)})
                  </span>
                  {a.extracted_content && (
                    <details className="lcars-message__attach-disclosure">
                      <summary className="lcars-message__attach-summary">
                        view extracted content
                      </summary>
                      <pre className="lcars-cb__pre" tabIndex={0}>{a.extracted_content}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}
