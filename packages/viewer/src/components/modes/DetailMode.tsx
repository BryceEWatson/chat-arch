import { useEffect, useState } from 'react';
import type { CloudConversation, Project, UnifiedSessionEntry } from '@chat-arch/schema';
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
import { useMoveToProject } from '../../data/moveToProject.js';

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
  /**
   * Project Identity v2 per-session provenance. The parent looks this up
   * by `session.id` from `projects.json`'s `attribution` map and passes
   * the matched record (or omits the prop when absent / pre-v2). Drives
   * the RESOLVED VIA meta row.
   */
  attribution?: { resolvedVia: string; confidence: number };
  /**
   * Project Identity v2 PR2: the list of discovered projects, used to
   * populate the MOVE TO PROJECT picker. Omitted when v2 entities haven't
   * been fetched/computed; the picker then offers only the new-name path.
   */
  projects?: readonly Project[];
}

/**
 * Human-readable gloss for each cascade rule, surfaced as the RESOLVED VIA
 * cell's title/tooltip. Keep in sync with `ProjectResolvedVia` in
 * `@chat-arch/schema` (the cascade documented in `inferProject`).
 */
const RESOLVED_VIA_TOOLTIP: Record<string, string> = {
  override: 'Rule 0 — a manual projectOverrides.json entry (e.g. via MOVE TO PROJECT) assigned this session.',
  project_field: 'Rule 1 — the session declared an explicit project field.',
  'scheduled-task': 'Rule 2 — a Cowork scheduled-task id mapped to a routine project.',
  'vm-folder': 'Rule 3 — derived from the VM working-folder basename.',
  cwd_basename: 'Rule 4 — derived from the host working-directory basename.',
  title_keyword: 'Rule 5 — matched a title-keyword regex.',
  unassigned: 'Rule 6 — no cascade rule matched; the session is unassigned.',
};

function resolvedViaTooltip(resolvedVia: string): string {
  return (
    RESOLVED_VIA_TOOLTIP[resolvedVia] ??
    'Which Project Identity cascade rule assigned this session to its project.'
  );
}

/**
 * Strip the leading `proj_` off a project id so the MOVE TO PROJECT
 * endpoint stores a raw key the v2 cascade can re-slug back to the same
 * `proj_…` id. Returns the input unchanged when there's no prefix.
 */
function rawProjectKey(id: string): string {
  return id.startsWith('proj_') ? id.slice('proj_'.length) : id;
}

const NEW_PROJECT_SENTINEL = '__new__';

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
  attribution,
  projects,
}: DetailModeProps) {
  const key = cacheKey(session);
  const current = cache.get(key) ?? { status: 'idle' as const };

  // Copy-transcript toast state. Transient "COPIED ✓" / "COPY FAILED" label
  // shown next to the button for ~1.5s after a click.
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');

  // --- MOVE TO PROJECT (Project Identity v2 PR2, local-dev only) ---
  const moveCtl = useMoveToProject();
  // Inline picker open/closed. The picker reveals a project <select> + an
  // optional new-name text input under the header.
  const [moveOpen, setMoveOpen] = useState(false);
  // Selected project id (a real proj_… id) OR NEW_PROJECT_SENTINEL when the
  // user wants to type a brand-new project name.
  const [moveSelection, setMoveSelection] = useState<string>('');
  const [moveNewName, setMoveNewName] = useState('');

  // Reset picker state whenever the active session changes — a stale
  // selection from a prior session would otherwise leak across drill-in.
  useEffect(() => {
    setMoveOpen(false);
    setMoveSelection('');
    setMoveNewName('');
  }, [session.id]);

  const moving = moveCtl.status === 'moving';

  const handleMoveConfirm = async () => {
    if (moving) return;
    // Two paths, both feeding `/api/move-to-project`:
    //  - Existing project: send projectId = that project's id with the
    //    leading `proj_` stripped, so the v2 cascade (rule 0) re-derives
    //    the SAME proj_ id from the raw key, plus its displayName so the
    //    override reinforces the real label.
    //  - New name: send the raw typed text as BOTH projectId and
    //    displayName so the cascade slugs a fresh id while preserving the
    //    label the user typed.
    if (moveSelection === NEW_PROJECT_SENTINEL) {
      const name = moveNewName.trim();
      if (name.length === 0) return;
      await moveCtl.move(session.id, name, name);
      return;
    }
    if (moveSelection.length === 0) return;
    // Carry the existing project's displayName so the override row reinforces
    // the real label (otherwise the raw key becomes a displayName candidate
    // and could flip a singleton target's displayed name; bucket id is
    // unaffected either way since stableProjectId re-slugs the raw key).
    const picked = (projects ?? []).find((p) => p.id === moveSelection);
    await moveCtl.move(
      session.id,
      rawProjectKey(moveSelection),
      picked?.displayName !== undefined && picked.displayName !== '' ? picked.displayName : undefined,
    );
  };

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
      aria-labelledby="lcars-detail-mode-title-h"
    >
      <p className="lcars-sr-only">
        Press the left-bracket key for previous session, right-bracket for next.
      </p>
      <header className="lcars-detail-mode__header">
        <div
          className="lcars-detail-mode__back"
          role="button"
          tabIndex={0}
          aria-label="BACK to list"
          onClick={onBack}
          onKeyDown={(e) => onActivate(e, onBack)}
        >
          <span aria-hidden="true">◄ </span>BACK
        </div>
        <div
          className={`lcars-detail-mode__nav lcars-detail-mode__nav--prev${prevId ? '' : ' lcars-detail-mode__nav--disabled'}`}
          role="button"
          tabIndex={prevId ? 0 : -1}
          aria-label={prevId ? 'PREV session' : 'PREV session, no earlier session in list'}
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
          <span aria-hidden="true">◄ </span>PREV
        </div>
        <div
          className={`lcars-detail-mode__nav lcars-detail-mode__nav--next${nextId ? '' : ' lcars-detail-mode__nav--disabled'}`}
          role="button"
          tabIndex={nextId ? 0 : -1}
          aria-label={nextId ? 'NEXT session' : 'NEXT session, no later session in list'}
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
          NEXT<span aria-hidden="true"> ►</span>
        </div>
        <SourcePill source={session.source} active readonly />
        <h2 id="lcars-detail-mode-title-h" className="lcars-detail-mode__title">{title}</h2>
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
              {copyState === 'ok' ? (
                <>
                  COPIED<span aria-hidden="true"> ✓</span>
                </>
              ) : (
                'COPY FAILED'
              )}
            </span>
          )}
          {/* MOVE TO PROJECT — local-dev only. Hidden once the probe
              resolves to a definitive false (hosted static build). */}
          {moveCtl.available !== false && (
            <button
              type="button"
              className="lcars-detail-mode__copy lcars-detail-mode__move"
              aria-label="move this session to a different project"
              aria-expanded={moveOpen}
              onClick={() => setMoveOpen((v) => !v)}
            >
              MOVE TO PROJECT
            </button>
          )}
        </div>
        <div className="lcars-detail-mode__time">{formatRelative(session.updatedAt)}</div>
      </header>

      {moveCtl.available !== false && moveOpen && (
        <div className="lcars-detail-mode__move-panel">
          <label className="lcars-detail-mode__move-label" htmlFor="move-project-select">
            MOVE TO PROJECT
          </label>
          <select
            id="move-project-select"
            className="lcars-detail-mode__move-select"
            value={moveSelection}
            disabled={moving}
            onChange={(e) => setMoveSelection(e.target.value)}
          >
            <option value="">— choose a project —</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.id})
              </option>
            ))}
            <option value={NEW_PROJECT_SENTINEL}>+ new project…</option>
          </select>
          {moveSelection === NEW_PROJECT_SENTINEL && (
            <input
              type="text"
              className="lcars-detail-mode__move-new-name"
              aria-label="new project name"
              placeholder="new project name"
              value={moveNewName}
              disabled={moving}
              onChange={(e) => setMoveNewName(e.target.value)}
            />
          )}
          <button
            type="button"
            className="lcars-detail-mode__copy lcars-detail-mode__move-confirm"
            aria-label="confirm move to project"
            disabled={
              moving ||
              moveSelection.length === 0 ||
              (moveSelection === NEW_PROJECT_SENTINEL && moveNewName.trim().length === 0)
            }
            onClick={handleMoveConfirm}
          >
            {moving ? 'MOVING…' : 'CONFIRM'}
          </button>
          {moveCtl.last && (
            <span
              className={`lcars-detail-mode__move-result lcars-detail-mode__move-result--${
                moveCtl.last.ok ? 'ok' : 'err'
              }`}
              role="status"
              aria-live="polite"
            >
              {moveCtl.last.ok
                ? (moveCtl.last.note ?? 'Moved — run a rescan to apply.')
                : (moveCtl.last.error ?? 'Move failed.')}
            </span>
          )}
        </div>
      )}

      <dl className="lcars-detail-mode__meta" aria-label="session metadata">
        <div>
          <dt>SOURCE</dt>
          <dd>{SOURCE_LABEL[session.source]}</dd>
        </div>
        <div>
          <dt>TURNS</dt>
          <dd
            aria-label={`${session.userTurns ?? 'unknown'} user turns, ${session.assistantTurns ?? 'unknown'} assistant turns`}
          >
            {session.userTurns ?? '—'}
            <span aria-hidden="true">→</span>
            {session.assistantTurns ?? '—'}
          </dd>
        </div>
        <div>
          <dt>MODEL</dt>
          <dd
            className="lcars-detail-mode__meta--mono"
            aria-label={session.model ?? 'No model recorded'}
          >
            {session.model ?? '—'}
          </dd>
        </div>
        <div>
          <dt>COST</dt>
          <dd aria-label={detailCostTooltip(session.totalCostUsd, session.costEstimatedUsd)}>
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
            aria-label={session.project ?? 'No resolved project'}
          >
            {session.project ?? '—'}
          </dd>
        </div>
        <div>
          <dt>RESOLVED VIA</dt>
          <dd
            className="lcars-detail-mode__meta--mono"
            title={
              attribution
                ? resolvedViaTooltip(attribution.resolvedVia)
                : 'No Project Identity v2 attribution recorded for this session.'
            }
          >
            {attribution
              ? `${attribution.resolvedVia} · ${attribution.confidence.toFixed(2)}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>CWD</dt>
          <dd className="lcars-detail-mode__meta--mono" aria-label={session.cwd ?? 'No CWD recorded'}>
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
