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
  /**
   * Iter-10 a11y: caller-supplied 1-based index within the inline
   * citation sequence + total count. Used to build "citation N of M"
   * positional context in the accessible name so SR users have
   * navigation anchors. Optional for non-positional callers (e.g. a
   * standalone test rendering one chip); positional callers should
   * always pass both.
   */
  index?: number;
  total?: number;
}

/**
 * Compact citation chip rendered inline in the assistant's answer. Shows
 * a short session-id prefix; clicking opens the session in DetailMode
 * via the existing `#session/<id>` hash route.
 */
export function CitationChip({
  citation,
  onActivate,
  verified = true,
  index,
  total,
}: CitationChipProps) {
  const short = citation.sessionId.slice(0, 8);
  const positional =
    typeof index === 'number' && typeof total === 'number'
      ? `citation ${index} of ${total}`
      : 'citation';
  const verifiedPrefix = verified ? '' : 'unverified ';
  const snippetSuffix = citation.snippet
    ? `, snippet: ${citation.snippet.slice(0, 80)}${citation.snippet.length > 80 ? '…' : ''}`
    : '';
  const ariaLabel = `${verifiedPrefix}${positional}, session ${short}${snippetSuffix}`;
  return (
    <button
      type="button"
      className={`lcars-chat-citation${verified ? '' : ' lcars-chat-citation--unverified'}`}
      onClick={() => onActivate?.(citation.sessionId)}
      aria-label={ariaLabel}
    >
      <span className="lcars-chat-citation__prefix" aria-hidden="true">SID</span>
      <span className="lcars-chat-citation__value" aria-hidden="true">
        {verified ? short : (
          <>
            {short}
            <span
              aria-hidden="true"
              title="unverified citation — the cited session ID couldn't be matched to a known session in this corpus"
            >
              {' ⚠'}
            </span>
          </>
        )}
      </span>
    </button>
  );
}
