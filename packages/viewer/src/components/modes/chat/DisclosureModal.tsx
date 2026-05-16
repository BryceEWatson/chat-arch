import { useEffect, useRef } from 'react';

export interface DisclosureModalProps {
  open: boolean;
  onAcknowledge: () => void;
  onCancel: () => void;
}

const STORAGE_KEY = 'chat-arch:chat-disclosure-acked-v1';

/**
 * Whether the user has acknowledged the chat-page data-flow disclosure
 * (questions + agent reads forwarded to the local Claude CLI, which
 * calls Anthropic). Checked once on first chat interaction.
 */
export function chatDisclosureAcknowledged(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Some privacy modes block localStorage entirely; treat as not-acked
    // so we re-disclose every session rather than silently bypass.
    return false;
  }
}

export function markChatDisclosureAcknowledged(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Best-effort; if localStorage is blocked we re-disclose next visit.
  }
}

/**
 * First-run disclosure dialog. The adversarial review of the v3 plan
 * (finding A8) flagged that "cloud data never leaves IndexedDB" is a
 * misleading framing once chat is added — the question + the agent's
 * Read outputs go through the local Claude CLI, which then calls
 * Anthropic's API. The user deserves explicit notice the first time.
 *
 * Modeled as a confirm/cancel — declining doesn't proceed to a turn.
 */
export function DisclosureModal({ open, onAcknowledge, onCancel }: DisclosureModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="lcars-chat-disclosure"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lcars-chat-disclosure-title"
    >
      <div className="lcars-chat-disclosure__backdrop" onClick={onCancel} />
      <div className="lcars-chat-disclosure__panel" ref={dialogRef} tabIndex={-1}>
        <h2 id="lcars-chat-disclosure-title" className="lcars-chat-disclosure__title">
          BEFORE YOU CHAT
        </h2>
        <div className="lcars-chat-disclosure__body">
          <p>
            The chat answers questions using <strong>your local Claude Code CLI</strong>. When
            you send a message, the chat:
          </p>
          <ol>
            <li>Spawns <code>claude -p</code> on this machine.</li>
            <li>
              The Claude Code agent reads from your archived chat-arch corpus
              (<code>chat-arch-data/</code> on disk) to ground the answer.
            </li>
            <li>
              Your question and the corpus excerpts the agent reads are forwarded by{' '}
              <code>claude</code> to Anthropic&apos;s API under your existing Anthropic account.
            </li>
            <li>
              Usage is billed to <strong>your</strong> Anthropic plan, the same as running{' '}
              <code>claude</code> in a terminal.
            </li>
          </ol>
          <p>
            Cloud conversations stored only in your browser (the uploaded ZIP archive) are{' '}
            <strong>not</strong> sent — the agent reads the on-disk corpus only.
          </p>
        </div>
        <div className="lcars-chat-disclosure__actions">
          <button
            type="button"
            className="lcars-chat-disclosure__cancel"
            onClick={onCancel}
          >
            CANCEL
          </button>
          <button
            type="button"
            className="lcars-chat-disclosure__confirm"
            onClick={onAcknowledge}
          >
            I UNDERSTAND — CONTINUE
          </button>
        </div>
      </div>
    </div>
  );
}
