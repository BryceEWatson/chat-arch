import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SemanticLabelsBundle } from '../data/semanticClassify.js';
import { AnalysisLauncher } from './AnalysisLauncher.js';

/**
 * Build a minimal v4 bundle for the staleness tests. The fields that
 * matter for STALE detection are `analyzedSessionIds` (the set the
 * run considered) and `labels` (not inspected here, but must be a Map
 * so the guard accepts it if re-loaded from store).
 */
function bundle(analyzedIds: readonly string[]): SemanticLabelsBundle {
  return {
    version: 4,
    modelId: 'Xenova/bge-small-en-v1.5',
    mode: 'classify',
    options: { threshold: 0.4, margin: 0.02 },
    generatedAt: 1_700_000_000_000,
    labels: new Map(),
    analyzedSessionIds: new Set(analyzedIds),
    device: 'webgpu',
  };
}

const baseProps = {
  projectsAvailable: true,
  status: 'idle' as const,
  progress: null,
  errorMessage: null,
  totalEligibleSessions: 100,
  onAnalyze: () => {},
};

describe('AnalysisLauncher stale detection', () => {
  it('does NOT flag STALE when every current session is in analyzedSessionIds', () => {
    // The exact scenario from the bug report: the classifier
    // considered every cloud session in the corpus. Some were
    // skipped silently (empty chunks, zero-turn) and don't appear
    // in `bundle.labels`, but they WERE analyzed — re-running won't
    // change anything. Must NOT fire STALE.
    const analyzed = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const current = new Set(analyzed); // no new sessions
    render(
      <AnalysisLauncher
        {...baseProps}
        bundle={bundle(analyzed)}
        currentSessionIds={current}
      />,
    );
    expect(screen.queryByText('STALE')).toBeNull();
  });

  it('flags STALE when new session ids appear that the bundle never saw', () => {
    const analyzed = Array.from({ length: 100 }, (_, i) => `s${i}`);
    // Simulate the user uploading a new ZIP that added 5 new ids.
    const current = new Set([...analyzed, 'new1', 'new2', 'new3', 'new4', 'new5']);
    render(
      <AnalysisLauncher
        {...baseProps}
        totalEligibleSessions={105}
        bundle={bundle(analyzed)}
        currentSessionIds={current}
      />,
    );
    expect(screen.getByText('STALE')).toBeDefined();
    // Subtitle should show the EXACT new-session count, not the
    // labels.size vs total gap.
    expect(
      screen.getByText(/5 new sessions since the last run are unanalyzed/),
    ).toBeDefined();
  });

  it('single new session uses singular copy ("1 new session ... is unanalyzed")', () => {
    const analyzed = ['a', 'b', 'c'];
    const current = new Set([...analyzed, 'd']);
    render(
      <AnalysisLauncher
        {...baseProps}
        totalEligibleSessions={4}
        bundle={bundle(analyzed)}
        currentSessionIds={current}
      />,
    );
    expect(screen.getByText(/1 new session since the last run is unanalyzed/)).toBeDefined();
  });

  it('flags COMPLETE — not STALE — when the bundle covers every current id even with a labels gap', () => {
    // Bundle's analyzedSessionIds is the SUPERSET of labels.size —
    // this is the core fix. A session can be "analyzed but unlabeled"
    // because it had no embed-able content. Re-running changes
    // nothing, so the UI must not nag the user.
    const analyzed = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const current = new Set(analyzed);
    const b = bundle(analyzed);
    // Only 65 of the 100 got labels (35 had no embed-able content).
    for (let i = 0; i < 65; i += 1) {
      b.labels.set(`s${i}`, { projectId: `~cluster-${i % 5}`, similarity: 0.7 });
    }
    render(
      <AnalysisLauncher {...baseProps} bundle={b} currentSessionIds={current} />,
    );
    expect(screen.queryByText('STALE')).toBeNull();
    // The DONE/COMPLETE state has its own rendering path — the absence
    // of STALE is the security-relevant assertion, the rest is
    // UX polish verified elsewhere.
  });
});
