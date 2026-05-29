import { useMemo } from 'react';
import type { UnifiedSessionEntry, Project, Narrative } from '@chat-arch/schema';
import type { ZombieProject } from '../constellation/ZombieProjectCard.js';
import type { MergedDuplicateCluster } from '../../data/mergeDuplicates.js';
import { EmptyState } from '../EmptyState.js';
import { CuratorFeed } from '../CuratorFeed.js';
import {
  LENS_BLURB,
  LENS_LABEL,
  runPracticeAudit,
  type Lens,
  type PracticeFinding,
  type Severity,
} from '../../data/practiceAudit.js';

/**
 * v2 spec §5.4 / decision D13: PRACTICE adversarial audit dashboard.
 * Single audit pass over the shared inputs (sessions + projects +
 * narratives + duplicate clusters + zombie projects) emits a flat
 * findings array; this surface groups them by lens.
 */

export interface PracticeModeProps {
  sessions: readonly UnifiedSessionEntry[];
  projects: readonly Project[];
  narratives: readonly Narrative[];
  duplicateClusters: readonly MergedDuplicateCluster[];
  zombieProjects: readonly ZombieProject[];
  onSelectSession: (id: string) => void;
  onSelectProject: (id: string) => void;
  /**
   * Rev3-F F9 — base URL for the curator feed sidecar
   * (`analysis/curator-feed.json`, produced by the /curate skill).
   * The CuratorFeed component reads from `${baseUrl}/analysis/...`
   * and renders an empty state when the file is absent. Defaults to
   * the standalone data root.
   */
  dataDirBaseUrl?: string;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  info: 'INFO',
  warn: 'WARN',
  alert: 'ALERT',
};

const SEVERITY_CLASS: Record<Severity, string> = {
  info: 'lcars-practice__severity--info',
  warn: 'lcars-practice__severity--warn',
  alert: 'lcars-practice__severity--alert',
};

const LENSES: readonly Lens[] = [
  'your-patterns',
  'agent-patterns',
  'process-gaps',
  'value-leaks',
];

export function PracticeMode({
  sessions,
  projects,
  narratives,
  duplicateClusters,
  zombieProjects,
  onSelectSession,
  onSelectProject,
  dataDirBaseUrl = 'chat-arch-data',
}: PracticeModeProps) {
  const audit = useMemo(
    () =>
      runPracticeAudit({
        sessions,
        projects,
        narratives,
        duplicateClusters,
        zombieProjects,
      }),
    [sessions, projects, narratives, duplicateClusters, zombieProjects],
  );

  const byLens = useMemo(() => {
    const m = new Map<Lens, PracticeFinding[]>();
    for (const lens of LENSES) m.set(lens, []);
    for (const f of audit.findings) m.get(f.lens)!.push(f);
    return m;
  }, [audit.findings]);

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="NO PRACTICE DATA"
        message="PRACTICE needs at least a manifest to audit. Upload a cloud export or scan local sources."
      />
    );
  }

  return (
    <div className="lcars-practice">
      <header className="lcars-practice__header">
        <h2 className="lcars-practice__title">PRACTICE</h2>
        <p className="lcars-practice__lead">
          Adversarial audit over your manifest — four lenses, one pass. Findings derive
          mechanically from the analysis kernel; nothing is a model judgement, everything
          links to evidence.
        </p>
      </header>
      {/* Rev3-F F9 — curator feed top section. Renders above the
       *  four lenses per the plan ("Curator feed surfaces as top
       *  section on PRACTICE, NOT a new top-level surface"). Reads
       *  the /curate skill's analysis/curator-feed.json sidecar;
       *  renders an empty state when the skill hasn't run yet. */}
      <CuratorFeed dataDirBaseUrl={dataDirBaseUrl} />
      {LENSES.map((lens) => {
        const findings = byLens.get(lens) ?? [];
        const lensHId = `lcars-practice-lens-${lens}-h`;
        return (
          <section
            key={lens}
            className={`lcars-practice__lens lcars-practice__lens--${lens}`}
            aria-labelledby={lensHId}
          >
            <header className="lcars-practice__lens-header">
              <h3 id={lensHId} className="lcars-practice__lens-title">{LENS_LABEL[lens]}</h3>
              <span className="lcars-practice__lens-blurb">{LENS_BLURB[lens]}</span>
            </header>
            {findings.length === 0 ? (
              <p className="lcars-practice__empty">
                No findings under this lens — either the audit ran clean, or there
                isn’t enough data yet to surface a pattern.
              </p>
            ) : (
              <ul className="lcars-practice__finding-list" role="list">
                {findings.map((f) => (
                  <li key={f.id} role="listitem">
                    <article className="lcars-practice__finding">
                      <header className="lcars-practice__finding-header">
                        <span
                          className={`lcars-practice__severity ${SEVERITY_CLASS[f.severity]}`}
                        >
                          <span className="lcars-sr-only">severity </span>
                          {SEVERITY_LABEL[f.severity]}
                        </span>
                        <h4 className="lcars-practice__finding-title">{f.title}</h4>
                      </header>
                      <p className="lcars-practice__finding-body">{f.body}</p>
                      {f.evidence.length > 0 && (
                        <ul
                          className="lcars-practice__evidence"
                          role="list"
                          aria-label="evidence"
                        >
                          {f.evidence.map((e, ix) => (
                            <li key={`${e.kind}-${e.id}-${ix}`}>
                              {e.kind === 'session' ? (
                                <button
                                  type="button"
                                  className="lcars-practice__evidence-pill"
                                  onClick={() => onSelectSession(e.id)}
                                >
                                  <span aria-hidden="true">▸ </span>
                                  session: {e.label ?? e.id}
                                </button>
                              ) : e.kind === 'project' ? (
                                <button
                                  type="button"
                                  className="lcars-practice__evidence-pill"
                                  onClick={() => onSelectProject(e.id)}
                                >
                                  <span aria-hidden="true">↳ </span>
                                  project: {e.label ?? e.id}
                                </button>
                              ) : (
                                <span
                                  className="lcars-practice__evidence-pill lcars-practice__evidence-pill--static"
                                >
                                  {e.kind}: {e.label ?? e.id}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
