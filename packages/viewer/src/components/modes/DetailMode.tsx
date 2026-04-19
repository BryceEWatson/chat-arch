import { useEffect, useState } from 'react';
import type { CloudConversation, UnifiedSessionEntry } from '@chat-arch/schema';
import type { ConversationCache, DrillInBody } from '../../types.js';
import { SOURCE_COLOR, SOURCE_LABEL } from '../../types.js';
import { SourcePill } from '../SourcePill.js';
import { MessageList } from '../MessageList.js';
import { TranscriptList } from '../TranscriptList.js';
import { DetailMissing } from '../DetailMissing.js';
import { ErrorState } from '../ErrorState.js';
import { fetchConversation, fetchTranscript, resolveDataUrl } from '../../data/fetch.js';
import { onActivate } from '../../util/a11y.js';
import { formatRelative } from '../../util/time.js';
import { buildTranscriptMarkdown } from '../../data/transcriptMarkdown.js';

export interface DetailModeProps {
  session: UnifiedSessionEntry;
  dataRoot: string;
  cache: ConversationCache;
  setCache: (next: ConversationCache) => void;
  onBack: () => void;
  /**
   * Present when the manifest came from an uploaded ZIP. Cloud drill-in hits
   * this map directly — no network fetch — so the viewer works offline.
   */
  uploadedConversationsById?: Map<string, CloudConversation>;
  /**
   * Prev/next navigation handlers (Decision 11). Parent passes the
   * filtered+sorted list's previous / next id — null when the current
   * session is at an edge. Buttons render disabled at edges (no wrap,
   * Q5 AFFIRM).
   */
  prevId: string | null;
  nextId: string | null;
  onPrev: () => void;
  onNext: () => void;
}

function cacheKey(session: UnifiedSessionEntry): string {
  return `${session.source}:${session.id}`;
}

/**
 * Cost breakdown tooltip for the detail meta strip — mirrors the card's
 * `costTooltip` so the two surfaces read the same way on hover. The
 * exact-vs-estimate distinction is load-bearing for any cost judgment.
 */
function detailCostTooltip(
  totalCostUsd: number | null,
  estimatedUsd: number | null | undefined,
): string {
  if (totalCostUsd !== null) {
    return `Exact cost from CLI logs: $${totalCostUsd.toFixed(2)}`;
  }
  if (typeof estimatedUsd === 'number') {
    return `Estimated from rate table: $${estimatedUsd.toFixed(2)}\n(no CLI cost data for this session)`;
  }
  return 'No cost signal for this session — neither CLI logs nor an estimate are available.';
}

export function DetailMode({
  session,
  dataRoot,
  cache,
  setCache,
  onBack,
  uploadedConversationsById,
  prevId,
  nextId,
  onPrev,
  onNext,
}: DetailModeProps) {
  const key = cacheKey(session);
  const current = cache.get(key) ?? { status: 'idle' as const };

  // Copy-transcript toast state. Transient "COPIED ✓" / "COPY FAILED" label
  // shown next to the button for ~1.5s after a click.
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');

  useEffect(() => {
    if (current.status !== 'idle') return;
    const isCloud = session.source === 'cloud';

    // Mutate map via a new Map to notify React.
    const mark = (next: Parameters<typeof cache.set>[1]) => {
      const copy = new Map(cache);
      copy.set(key, next);
      setCache(copy);
    };

    // In-memory cloud drill-in (uploaded ZIP): skip the network round trip.
    if (isCloud && uploadedConversationsById) {
      const conv = uploadedConversationsById.get(session.id);
      if (conv) {
        mark({ status: 'ready', data: { kind: 'cloud', conversation: conv } });
      } else {
        mark({
          status: 'error',
          message: `Conversation ${session.id} not found in uploaded ZIP.`,
        });
      }
      return;
    }

    if (!session.transcriptPath) return;
    const url = resolveDataUrl(dataRoot, session.transcriptPath);

    mark({ status: 'loading' });
    (isCloud
      ? fetchConversation(url).then<DrillInBody>((conv) => ({ kind: 'cloud', conversation: conv }))
      : fetchTranscript(url).then<DrillInBody>((entries) => ({ kind: 'local', entries }))
    )
      .then((data) => mark({ status: 'ready', data }))
      .catch((err: unknown) =>
        mark({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
    // Only react to key + transcriptPath changes, not cache identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session.transcriptPath, dataRoot, uploadedConversationsById]);

  // Keyboard: `[` for prev, `]` for next (Decision 11). Don't intercept
  // when the user is typing in an input / textarea.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing in an input / textarea / contenteditable.
      // target may be `Window` when jsdom dispatches directly on window, so
      // branch on Element before touching Element-specific methods.
      const target = e.target;
      if (target instanceof Element) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          target.getAttribute('contenteditable') === 'true'
        ) {
          return;
        }
      }
      if (e.key === '[' && prevId) {
        e.preventDefault();
        onPrev();
      } else if (e.key === ']' && nextId) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prevId, nextId, onPrev, onNext]);

  const title = session.title || 'Untitled session';

  const handleCopy = async () => {
    if (current.status !== 'ready') {
      setCopyState('err');
      window.setTimeout(() => setCopyState('idle'), 1500);
      return;
    }
    const md = buildTranscriptMarkdown(session, current.data);
    try {
      // Prefer the modern clipboard API; fall back to a hidden textarea only
      // if it's missing (e.g. insecure http://).
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
      } else {
        const ta = document.createElement('textarea');
        ta.value = md;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyState('ok');
    } catch {
      setCopyState('err');
    }
    window.setTimeout(() => setCopyState('idle'), 1500);
  };

  return (
    <section
      className="lcars-detail-mode"
      style={{ ['--source-color' as string]: SOURCE_COLOR[session.source] } as React.CSSProperties}
      aria-label={`session detail ${title}`}
    >
      <header className="lcars-detail-mode__header">
        <div
          className="lcars-detail-mode__back"
          role="button"
          tabIndex={0}
          aria-label="back to list"
          onClick={onBack}
          onKeyDown={(e) => onActivate(e, onBack)}
        >
          ◄ BACK
        </div>
        <div
          className={`lcars-detail-mode__nav lcars-detail-mode__nav--prev${prevId ? '' : ' lcars-detail-mode__nav--disabled'}`}
          role="button"
          tabIndex={prevId ? 0 : -1}
          aria-label="previous session ([ key)"
          aria-disabled={prevId ? undefined : true}
          onClick={() => {
            if (prevId) onPrev();
          }}
          onKeyDown={(e) =>
            onActivate(e, () => {
              if (prevId) onPrev();
            })
          }
        >
          ◄ PREV
        </div>
        <div
          className={`lcars-detail-mode__nav lcars-detail-mode__nav--next${nextId ? '' : ' lcars-detail-mode__nav--disabled'}`}
          role="button"
          tabIndex={nextId ? 0 : -1}
          aria-label="next session (] key)"
          aria-disabled={nextId ? undefined : true}
          onClick={() => {
            if (nextId) onNext();
          }}
          onKeyDown={(e) =>
            onActivate(e, () => {
              if (nextId) onNext();
            })
          }
        >
          NEXT ►
        </div>
        <SourcePill source={session.source} active readonly />
        <div className="lcars-detail-mode__title">{title}</div>
        <div className="lcars-detail-mode__copy-wrap">
          <div
            className="lcars-detail-mode__copy"
            role="button"
            tabIndex={0}
            aria-label="copy transcript as markdown"
            onClick={handleCopy}
            onKeyDown={(e) => onActivate(e, handleCopy)}
          >
            COPY TRANSCRIPT
          </div>
          {copyState !== 'idle' && (
            <span
              className={`lcars-detail-mode__copy-toast lcars-detail-mode__copy-toast--${copyState}`}
              role="status"
              aria-live="polite"
            >
              {copyState === 'ok' ? 'COPIED ✓' : 'COPY FAILED'}
            </span>
          )}
        </div>
        <div className="lcars-detail-mode__time">{formatRelative(session.updatedAt)}</div>
      </header>

      <dl className="lcars-detail-mode__meta">
        <div>
          <dt>SOURCE</dt>
          <dd>{SOURCE_LABEL[session.source]}</dd>
        </div>
        <div>
          <dt>TURNS</dt>
          <dd
            title={`${session.userTurns ?? '—'} user → ${session.assistantTurns ?? '—'} assistant`}
          >
            {session.userTurns ?? '—'}→{session.assistantTurns ?? '—'}
          </dd>
        </div>
        <div>
          <dt>MODEL</dt>
          <dd
            className="lcars-detail-mode__meta--mono"
            title={session.model ?? 'No model recorded'}
          >
            {session.model ?? '—'}
          </dd>
        </div>
        <div>
          <dt>COST</dt>
          <dd title={detailCostTooltip(session.totalCostUsd, session.costEstimatedUsd)}>
            {session.totalCostUsd !== null
              ? `$${session.totalCostUsd.toFixed(2)}`
              : typeof session.costEstimatedUsd === 'number'
                ? `~$${session.costEstimatedUsd.toFixed(2)}`
                : '—'}
          </dd>
        </div>
        <div>
          <dt>PROJECT</dt>
          <dd
            className="lcars-detail-mode__meta--mono"
            title={session.project ?? 'No resolved project'}
          >
            {session.project ?? '—'}
          </dd>
        </div>
        <div>
          <dt>CWD</dt>
          <dd className="lcars-detail-mode__meta--mono" title={session.cwd ?? 'No CWD recorded'}>
            {session.cwd ?? '—'}
          </dd>
        </div>
      </dl>

      <div className="lcars-detail-mode__body">
        {!session.transcriptPath && !uploadedConversationsById && (
          <DetailMissing reason="manifest has no transcriptPath" />
        )}
        {current.status === 'loading' && (
          <div className="lcars-detail-mode__loading">LOADING TRANSCRIPT…</div>
        )}
        {current.status === 'error' && (
          <ErrorState title="TRANSCRIPT ERROR" detail={current.message} />
        )}
        {current.status === 'ready' &&
          (current.data.kind === 'cloud' ? (
            <MessageList conversation={current.data.conversation} />
          ) : (
            <TranscriptList entries={current.data.entries} />
          ))}
      </div>
    </section>
  );
}
