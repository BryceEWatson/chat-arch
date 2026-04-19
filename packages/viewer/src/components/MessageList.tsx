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

export function MessageList({ conversation }: MessageListProps) {
  if (conversation.chat_messages.length === 0) {
    return <div className="lcars-message-list__empty">(no messages)</div>;
  }
  return (
    <ol className="lcars-message-list">
      {conversation.chat_messages.map((m) => (
        <li key={m.uuid} className={`lcars-message lcars-message--${m.sender}`}>
          <div className="lcars-message__header">
            <span className="lcars-message__sender">{senderLabel(m)}</span>
            <time className="lcars-message__time">{m.created_at}</time>
          </div>
          <div className="lcars-message__body">
            {m.content.length > 0 ? (
              m.content.map((block, idx) => <ContentBlock key={idx} block={block} />)
            ) : m.text ? (
              <div className="lcars-cb lcars-cb--text">{m.text}</div>
            ) : (
              <div className="lcars-cb lcars-cb--unknown">(empty message)</div>
            )}
          </div>
          {m.attachments.length > 0 && (
            <ul className="lcars-message__attachments">
              {m.attachments.map((a, i) => (
                <li key={i}>
                  <strong>{a.file_name}</strong> ({a.file_type}, {a.file_size}b)
                  {a.extracted_content && (
                    <details>
                      <summary>view extracted content</summary>
                      <pre className="lcars-cb__pre">{a.extracted_content}</pre>
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
