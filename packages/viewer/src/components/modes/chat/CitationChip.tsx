import type { ChatCitation } from '@chat-arch/schema';

export interface CitationChipProps {
  citation: ChatCitation;
  /**
   * When clicked, navigate to the session's detail surface
   * (#session/<id>). Typed with explicit `| undefined` so the host can
   * forward an optional handler without `exactOptionalPropertyTypes`
   * forcing a conditional-spread at every callsite.
   */
  onActivate?: ((sessionId: string) => void) | undefined;
  /**
   * When false, the chip renders muted with an "unverified" badge. Used
   * for inline `[SID:...]` markers in the assistant text whose ids
   * weren't in the agent's Read history (validated server-side, but a
   * future render path may surface unverified ids inline before
   * validation — kept as an explicit prop for that reason).
   */
  verified?: boolean | undefined;
}

/**
 * Compact citation chip rendered inline in the assistant's answer. Shows
 * a short session-id prefix; clicking opens the session in DetailMode
 * via the existing `#session/<id>` hash route.
 */
export function CitationChip({ citation, onActivate, verified = true }: CitationChipProps) {
  const short = citation.sessionId.slice(0, 8);
  const label = verified ? short : `${short}?`;
  const ariaLabel = verified
    ? `cited session ${citation.sessionId}`
    : `unverified citation for session ${citation.sessionId}`;
  const title = citation.snippet
    ? `${citation.sessionId}\n${citation.snippet}`
    : citation.sessionId;
  return (
    <button
      type="button"
      className={`lcars-chat-citation${verified ? '' : ' lcars-chat-citation--unverified'}`}
      onClick={() => onActivate?.(citation.sessionId)}
      aria-label={ariaLabel}
      title={title}
    >
      <span className="lcars-chat-citation__prefix">SID</span>
      <span className="lcars-chat-citation__value">{label}</span>
    </button>
  );
}
