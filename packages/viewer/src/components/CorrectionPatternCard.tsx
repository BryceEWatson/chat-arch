import { useState } from 'react';
import type {
  Correction,
  CorrectionPattern,
  ProposedUpgrade,
  UpgradeTarget,
} from '@chat-arch/schema';

export interface CorrectionPatternCardProps {
  pattern: CorrectionPattern;
  /**
   * Pre-built lookup so the card can render instance excerpts without
   * each card paying the O(n) scan over the file's flat corrections
   * array. The caller (CorrectionsPanel) builds it once.
   */
  instancesById: Map<string, Correction>;
  /**
   * APPLY click handler. When omitted (production static build, or
   * the dev endpoint hasn't been probed yet), APPLY renders disabled
   * with the legacy "not yet implemented" tooltip — same fallback
   * the v0.7 panel showed.
   */
  onApply?: (
    upgrade: ProposedUpgrade,
    extras: { targetFiles?: string[]; notes?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Session-selection handler for the instance-pill clickthrough.
   * Plumbed from CorrectionsPanel → BucketsView → here. When omitted
   * (e.g. host that doesn't support detail view), the instance row
   * renders as static text rather than as a button.
   */
  onSelectSession?: (sessionId: string) => void;
}

const CATEGORY: Array<{
  key: 'recurring' | 'encoded' | 'new';
  label: string;
  match: (p: CorrectionPattern) => boolean;
}> = [
  {
    key: 'recurring',
    label: 'RECURRING AFTER APPLIED',
    match: (p) => p.recurringPostApplication,
  },
  {
    key: 'encoded',
    label: 'ALREADY ENCODED',
    match: (p) => p.alreadyEncoded && !p.recurringPostApplication,
  },
  { key: 'new', label: 'NEW PATTERN', match: () => true },
];

function categoryFor(p: CorrectionPattern): 'recurring' | 'encoded' | 'new' {
  for (const c of CATEGORY) {
    if (c.match(p)) return c.key;
  }
  return 'new';
}

const TARGET_LABEL: Record<UpgradeTarget, string> = {
  'global-claude-md': 'GLOBAL CLAUDE.MD',
  'project-claude-md': 'PROJECT CLAUDE.MD',
  'settings-hook': 'SETTINGS HOOK',
  skill: 'SKILL',
  agent: 'AGENT',
  command: 'COMMAND',
  'prompt-snippet': 'PROMPT SNIPPET',
};

/**
 * Format a confidence number into a 0-100 percent. Renders as "—" when
 * the value is non-finite or out of range; the schema requires 0..1
 * but we don't trust the disk file blindly.
 */
function formatConfidence(c: number): string {
  if (!Number.isFinite(c)) return '—';
  const pct = Math.round(Math.min(1, Math.max(0, c)) * 100);
  return `${pct}%`;
}

function formatAppliedAt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  } catch {
    return '';
  }
}

const INITIAL_INSTANCE_COUNT = 3;

export function CorrectionPatternCard({
  pattern,
  instancesById,
  onApply,
  onSelectSession,
}: CorrectionPatternCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAllInstances, setShowAllInstances] = useState(false);
  const [copiedIx, setCopiedIx] = useState<number | null>(null);
  const [busyIx, setBusyIx] = useState<number | null>(null);

  const category = categoryFor(pattern);
  const categoryLabel =
    CATEGORY.find((c) => c.key === category)?.label ?? 'NEW PATTERN';

  const instances = pattern.instanceIds
    .map((id) => instancesById.get(id))
    .filter((c): c is Correction => c !== undefined);
  const visibleInstances = showAllInstances
    ? instances
    : instances.slice(0, INITIAL_INSTANCE_COUNT);
  const hiddenInstanceCount = instances.length - visibleInstances.length;

  const copyPatch = async (patch: string, ix: number) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(patch);
        setCopiedIx(ix);
        window.setTimeout(() => {
          setCopiedIx((prev) => (prev === ix ? null : prev));
        }, 1500);
      }
    } catch {
      // Clipboard refused (permissions, insecure context). Surface
      // nothing — the patch is still selectable in the <pre>.
    }
  };

  const confidencePct = formatConfidence(pattern.confidence);
  const confidenceWidth = Math.round(
    Math.min(1, Math.max(0, pattern.confidence)) * 100,
  );

  return (
    <article
      className={`lcars-correction-pattern lcars-correction-pattern--${category}`}
      aria-label={`correction pattern ${pattern.canonicalRule}`}
    >
      <header className="lcars-correction-pattern__header">
        <div className="lcars-correction-pattern__title-row">
          <span
            className={`lcars-correction-pattern__badge lcars-correction-pattern__badge--${category}`}
          >
            {categoryLabel}
          </span>
          <span
            className="lcars-correction-pattern__count"
            aria-label={`${pattern.occurrenceCount} occurrences`}
          >
            ×{pattern.occurrenceCount}
          </span>
        </div>
        <h3 className="lcars-correction-pattern__rule">{pattern.canonicalRule}</h3>
        <div className="lcars-correction-pattern__confidence" aria-label="confidence">
          <span className="lcars-correction-pattern__confidence-label">CONFIDENCE</span>
          <div
            className="lcars-correction-pattern__confidence-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={confidenceWidth}
          >
            <div
              className="lcars-correction-pattern__confidence-fill"
              style={{ width: `${confidenceWidth}%` }}
            />
          </div>
          <span className="lcars-correction-pattern__confidence-pct">{confidencePct}</span>
        </div>
      </header>

      <button
        type="button"
        className="lcars-correction-pattern__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'HIDE DETAILS' : 'SHOW DETAILS'} · {instances.length}{' '}
        {instances.length === 1 ? 'instance' : 'instances'} ·{' '}
        {pattern.proposedUpgrades.length}{' '}
        {pattern.proposedUpgrades.length === 1 ? 'upgrade' : 'upgrades'}
      </button>

      {expanded && (
        <div className="lcars-correction-pattern__body">
          <section className="lcars-correction-pattern__section">
            <h4 className="lcars-correction-pattern__section-title">INSTANCES</h4>
            {visibleInstances.length === 0 ? (
              <p className="lcars-correction-pattern__empty">
                No instance bodies available — the corrections file may be partial.
              </p>
            ) : (
              <ul className="lcars-correction-pattern__instance-list" role="list">
                {visibleInstances.map((inst) => {
                  const body = (
                    <>
                      {inst.precedingAssistantExcerpt && (
                        <p className="lcars-correction-pattern__instance-context">
                          <span className="lcars-correction-pattern__instance-tag">
                            ASSISTANT
                          </span>
                          <span>{inst.precedingAssistantExcerpt}</span>
                        </p>
                      )}
                      <p className="lcars-correction-pattern__instance-body">
                        <span className="lcars-correction-pattern__instance-tag">USER</span>
                        <span>{inst.excerpt}</span>
                      </p>
                    </>
                  );
                  if (onSelectSession) {
                    return (
                      <li
                        key={inst.id}
                        className="lcars-correction-pattern__instance"
                      >
                        <button
                          type="button"
                          className="lcars-correction-pattern__instance-pill"
                          onClick={() => onSelectSession(inst.sessionId)}
                          aria-label={`open session ${inst.sessionId}`}
                          title={`Open session ${inst.sessionId}`}
                        >
                          {body}
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li key={inst.id} className="lcars-correction-pattern__instance">
                      {body}
                    </li>
                  );
                })}
              </ul>
            )}
            {hiddenInstanceCount > 0 && (
              <button
                type="button"
                className="lcars-correction-pattern__more"
                onClick={() => setShowAllInstances(true)}
              >
                Show all ({instances.length})
              </button>
            )}
          </section>

          <section className="lcars-correction-pattern__section">
            <h4 className="lcars-correction-pattern__section-title">PROPOSED UPGRADES</h4>
            {pattern.proposedUpgrades.length === 0 ? (
              <p className="lcars-correction-pattern__empty">
                No upgrade candidates — the inference pass produced none for this pattern.
              </p>
            ) : (
              <ul className="lcars-correction-pattern__upgrade-list" role="list">
                {pattern.proposedUpgrades.map((u, ix) => (
                  <UpgradeRow
                    key={`${u.target}:${u.targetPath}:${ix}`}
                    upgrade={u}
                    copied={copiedIx === ix}
                    onCopy={() => void copyPatch(u.patch, ix)}
                    {...(onApply
                      ? {
                          onApply: async (extras) => onApply(u, extras),
                        }
                      : {})}
                    busy={busyIx !== null}
                    isMe={busyIx === ix}
                    onBusyChange={(busy) => setBusyIx(busy ? ix : null)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </article>
  );
}

interface UpgradeRowProps {
  upgrade: ProposedUpgrade;
  copied: boolean;
  onCopy: () => void;
  /** Omit to render APPLY as the legacy disabled placeholder. */
  onApply?: (
    extras: { targetFiles?: string[]; notes?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** True while any sibling upgrade in the same card is mid-write. */
  busy: boolean;
  /** True when this row is the one writing — drives the APPLYING… label. */
  isMe: boolean;
  /** Toggle the card-level busy lock. Called on submit start / settle. */
  onBusyChange: (busy: boolean) => void;
}

type ApplyState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'submitting' }
  | { kind: 'applied'; appliedAt: number }
  | { kind: 'error'; message: string };

function UpgradeRow({
  upgrade,
  copied,
  onCopy,
  onApply,
  busy,
  isMe,
  onBusyChange,
}: UpgradeRowProps) {
  const targetLabel = TARGET_LABEL[upgrade.target];
  // Seed from the upgrade's persisted state so a reload after APPLY
  // shows APPLIED ✓ without waiting for a re-click.
  const [state, setState] = useState<ApplyState>(() =>
    upgrade.applied && typeof upgrade.appliedAt === 'number'
      ? { kind: 'applied', appliedAt: upgrade.appliedAt }
      : { kind: 'idle' },
  );
  const [targetFilesInput, setTargetFilesInput] = useState('');
  const [notesInput, setNotesInput] = useState('');

  const submit = async () => {
    if (!onApply) return;
    setState({ kind: 'submitting' });
    onBusyChange(true);
    const targetFiles = targetFilesInput
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const notes = notesInput.trim();
    let result: { ok: boolean; error?: string };
    try {
      result = await onApply({
        ...(targetFiles.length > 0 ? { targetFiles } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      });
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      onBusyChange(false);
    }
    if (result.ok) {
      setState({ kind: 'applied', appliedAt: Date.now() });
    } else {
      setState({
        kind: 'error',
        message: result.error ?? 'apply failed',
      });
    }
  };

  return (
    <li className="lcars-correction-pattern__upgrade">
      <header className="lcars-correction-pattern__upgrade-header">
        <span
          className={`lcars-correction-pattern__target lcars-correction-pattern__target--${upgrade.target}`}
        >
          {targetLabel}
        </span>
        <code className="lcars-correction-pattern__target-path">{upgrade.targetPath}</code>
      </header>
      <p className="lcars-correction-pattern__rationale">{upgrade.rationale}</p>
      <pre className="lcars-correction-pattern__patch">{upgrade.patch}</pre>
      <div className="lcars-correction-pattern__upgrade-actions">
        <button
          type="button"
          className="lcars-correction-pattern__btn lcars-correction-pattern__btn--secondary"
          onClick={onCopy}
        >
          {copied ? 'COPIED' : 'COPY PATCH'}
        </button>
        {!onApply && (
          <button
            type="button"
            className="lcars-correction-pattern__btn lcars-correction-pattern__btn--primary"
            disabled
            aria-disabled="true"
            title="Apply flow not available — copy the patch and apply manually."
          >
            APPLY
          </button>
        )}
        {onApply && state.kind === 'idle' && (
          <button
            type="button"
            className="lcars-correction-pattern__btn lcars-correction-pattern__btn--primary"
            onClick={() => setState({ kind: 'confirming' })}
            disabled={busy}
          >
            APPLY
          </button>
        )}
        {onApply && state.kind === 'submitting' && (
          <button
            type="button"
            className="lcars-correction-pattern__btn lcars-correction-pattern__btn--primary"
            disabled
            aria-busy="true"
          >
            {isMe ? 'APPLYING…' : 'APPLY'}
          </button>
        )}
        {onApply && state.kind === 'applied' && (
          <span
            className="lcars-correction-pattern__applied"
            aria-label={`applied at ${formatAppliedAt(state.appliedAt)}`}
          >
            APPLIED ✓
            {formatAppliedAt(state.appliedAt) && (
              <span className="lcars-correction-pattern__applied-time">
                {' '}
                {formatAppliedAt(state.appliedAt)}
              </span>
            )}
          </span>
        )}
      </div>
      {onApply && state.kind === 'confirming' && (
        <div
          className="lcars-correction-pattern__confirm"
          role="dialog"
          aria-label="confirm apply correction"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setState({ kind: 'idle' });
            }
          }}
        >
          <p className="lcars-correction-pattern__confirm-blurb">
            Record this upgrade as applied. The patch isn&apos;t written to
            disk for you — copy it above, edit the target file, then confirm
            so the loop closes.
          </p>
          <label className="lcars-correction-pattern__confirm-field">
            <span>Files you edited (one per line, optional)</span>
            <textarea
              className="lcars-correction-pattern__confirm-textarea"
              rows={2}
              value={targetFilesInput}
              onChange={(e) => setTargetFilesInput(e.target.value)}
              placeholder={upgrade.targetPath}
            />
          </label>
          <label className="lcars-correction-pattern__confirm-field">
            <span>Notes (optional)</span>
            <textarea
              className="lcars-correction-pattern__confirm-textarea"
              rows={2}
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value)}
              placeholder="e.g. moved to PostToolUse hook"
            />
          </label>
          <div className="lcars-correction-pattern__confirm-actions">
            <button
              type="button"
              className="lcars-correction-pattern__btn lcars-correction-pattern__btn--primary"
              onClick={() => void submit()}
              autoFocus
            >
              CONFIRM APPLY
            </button>
            <button
              type="button"
              className="lcars-correction-pattern__btn lcars-correction-pattern__btn--ghost"
              onClick={() => setState({ kind: 'idle' })}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
      {onApply && state.kind === 'error' && (
        <div className="lcars-correction-pattern__apply-error" role="alert">
          <p>Apply failed: {state.message}</p>
          <div className="lcars-correction-pattern__confirm-actions">
            <button
              type="button"
              className="lcars-correction-pattern__btn lcars-correction-pattern__btn--secondary"
              onClick={() => setState({ kind: 'confirming' })}
            >
              RETRY
            </button>
            <button
              type="button"
              className="lcars-correction-pattern__btn lcars-correction-pattern__btn--ghost"
              onClick={() => setState({ kind: 'idle' })}
            >
              DISMISS
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
