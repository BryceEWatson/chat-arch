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

const INITIAL_INSTANCE_COUNT = 3;

export function CorrectionPatternCard({ pattern, instancesById }: CorrectionPatternCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAllInstances, setShowAllInstances] = useState(false);
  const [copiedIx, setCopiedIx] = useState<number | null>(null);

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
                {visibleInstances.map((inst) => (
                  <li key={inst.id} className="lcars-correction-pattern__instance">
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
                  </li>
                ))}
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
}

function UpgradeRow({ upgrade, copied, onCopy }: UpgradeRowProps) {
  const targetLabel = TARGET_LABEL[upgrade.target];
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
        <button
          type="button"
          className="lcars-correction-pattern__btn lcars-correction-pattern__btn--primary"
          disabled
          aria-disabled="true"
          title="Apply flow not yet implemented — copy the patch and apply manually."
        >
          APPLY
        </button>
      </div>
    </li>
  );
}
