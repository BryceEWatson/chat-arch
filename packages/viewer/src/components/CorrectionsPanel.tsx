import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Correction,
  CorrectionPattern,
  CorrectionsFile,
  ScanStats,
} from '@chat-arch/schema';
import {
  loadAppliedImprovementsFile,
  loadCorrectionCandidatesFile,
  loadCorrectionsFile,
  mergeAppliedImprovements,
} from '../data/correctionsLoader.js';
import {
  clearCorrections,
  fetchCorrectionRunStatus,
  probeClearCorrections,
  probeMineCorrections,
  startMineCorrections,
  type AutoWindowResult,
  type CorrectionRunStatus,
  type MineEvent,
} from '../data/mineCorrectionsClient.js';
import { CorrectionPatternCard } from './CorrectionPatternCard.js';
import {
  applyCorrection,
  probeApplyCorrection,
  type ApplyCorrectionRequest,
} from '../data/applyCorrectionClient.js';
import type { ProposedUpgrade } from '@chat-arch/schema';

export interface CorrectionsPanelProps {
  /** Same base URL the manifest was fetched from (e.g. "/chat-arch-data"). */
  dataDirBaseUrl: string;
  /**
   * Callback for opening a session in detail view. Plumbed from
   * ChatArchViewer; when omitted, instance pills render as static
   * (non-clickable) cards.
   */
  onSelectSession?: (sessionId: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      corrections: CorrectionsFile | null;
      candidates: CorrectionsFile | null;
    };

type MiningState =
  | { status: 'idle' }
  | { status: 'armed' }
  | {
      status: 'running';
      lines: readonly string[];
      phase: string | null;
      phaseProgress: { ix: number; total: number } | null;
      /** Set once the server's `start` event arrives; until then the
       *  status-file poller has nothing to look up. */
      requestId: string | null;
      startedAt: number | null;
      /** Latest snapshot of `correction-status-${requestId}.json`. The
       *  skill writes this on every stage transition; we poll it for
       *  mid-flight detail that headless stdout doesn't carry. */
      runStatus: CorrectionRunStatus | null;
    };

const RUNNING_LINE_TAIL = 8;
const STATUS_POLL_MS = 1500;
const STATUS_LOG_TAIL = 6;

const BUCKET_DEFS: ReadonlyArray<{
  key: 'recurring' | 'encoded' | 'new';
  label: string;
  blurb: string;
  match: (p: CorrectionPattern) => boolean;
}> = [
  {
    key: 'recurring',
    label: 'RECURRING AFTER APPLIED',
    blurb:
      'You wrote a rule, the model still gets it wrong. The encoded correction is failing in practice — reword it, add an example, or move it to a hook.',
    match: (p) => p.recurringPostApplication,
  },
  {
    key: 'encoded',
    label: 'ALREADY ENCODED BUT FAILING',
    blurb:
      'The rule already exists in CLAUDE.md but the model is still being corrected on it — same finding, weaker signal than recurring-after-applied.',
    match: (p) => p.alreadyEncoded && !p.recurringPostApplication,
  },
  {
    key: 'new',
    label: 'NEW PATTERNS TO ENCODE',
    blurb:
      'Recurring corrections that aren’t encoded anywhere. Pick a target file, paste the patch, and ship it.',
    match: () => true,
  },
];

function bucketFor(p: CorrectionPattern): 'recurring' | 'encoded' | 'new' {
  for (const b of BUCKET_DEFS) {
    if (b.match(p)) return b.key;
  }
  return 'new';
}

function sortPatterns(a: CorrectionPattern, b: CorrectionPattern): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  return b.occurrenceCount - a.occurrenceCount;
}

function formatGenerated(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  try {
    return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  } catch {
    return 'unknown';
  }
}

type ClearState =
  | { status: 'idle' }
  | { status: 'armed' }
  | { status: 'busy' }
  | { status: 'error'; message: string };

export function CorrectionsPanel({
  dataDirBaseUrl,
  onSelectSession,
}: CorrectionsPanelProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [mining, setMining] = useState<MiningState>({ status: 'idle' });
  const [autoWindow, setAutoWindow] = useState<AutoWindowResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [clearAvailable, setClearAvailable] = useState<boolean>(false);
  const [clearState, setClearState] = useState<ClearState>({ status: 'idle' });
  const [applyAvailable, setApplyAvailable] = useState<boolean>(false);

  // Cancel in-flight loads cleanly on unmount.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const [selection, setSelection] = useState<'recent' | 'backfill'>('recent');

  const refreshAutoWindow = useCallback(
    async (sel: 'recent' | 'backfill' = selection) => {
      const probe = await probeMineCorrections(undefined, sel);
      if (!aliveRef.current) return;
      setAutoWindow(probe?.autoWindow ?? null);
      // If the server already has a run in flight (page reload, second
      // tab, prior run still going), attach to it instead of leaving the
      // user staring at a stale idle button. The status-file poller
      // takes over from there.
      if (probe?.busy && probe.busyRequestId) {
        setMining((prev) => {
          if (prev.status === 'running' && prev.requestId === probe.busyRequestId) {
            return prev;
          }
          return {
            status: 'running',
            lines: [],
            phase: null,
            phaseProgress: null,
            requestId: probe.busyRequestId,
            startedAt: null,
            runStatus: null,
          };
        });
      }
    },
    [selection],
  );

  const refresh = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const [rawCorrections, candidates, applied] = await Promise.all([
        loadCorrectionsFile(dataDirBaseUrl),
        loadCorrectionCandidatesFile(dataDirBaseUrl),
        loadAppliedImprovementsFile(dataDirBaseUrl),
      ]);
      if (!aliveRef.current) return;
      // Merge the apply ledger over the canonical mining-pipeline
      // output. corrections.json itself is never mutated — the
      // merge runs at read time so a future re-mine never clobbers
      // the user's apply history.
      const corrections = rawCorrections
        ? mergeAppliedImprovements(rawCorrections, applied)
        : null;
      setLoad({ status: 'ready', corrections, candidates });
      void refreshAutoWindow();
    } catch (err) {
      if (!aliveRef.current) return;
      setLoad({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [dataDirBaseUrl, refreshAutoWindow]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Probe the clear-corrections endpoint once on mount. In production
  // static builds the endpoint isn't bundled and the danger zone hides.
  useEffect(() => {
    let cancelled = false;
    void probeClearCorrections().then((available) => {
      if (cancelled || !aliveRef.current) return;
      setClearAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Probe the apply-correction endpoint once on mount. Same posture as
  // the clear probe: APPLY hides on production static builds where the
  // dev server isn't running, falling back to copy-and-edit-by-hand.
  useEffect(() => {
    let cancelled = false;
    void probeApplyCorrection().then((available) => {
      if (cancelled || !aliveRef.current) return;
      setApplyAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleApply = useCallback(
    async (
      pattern: CorrectionPattern,
      upgrade: ProposedUpgrade,
      extras: { targetFiles?: string[]; notes?: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      const req: ApplyCorrectionRequest = {
        patternId: pattern.id,
        proposedUpgrade: upgrade,
        ruleSummary: pattern.canonicalRule,
        ...extras,
      };
      const result = await applyCorrection(req);
      // On success, reload the merged file so the bucket re-categorizes
      // the pattern (RECURRING vs ENCODED vs NEW shifts when applied
      // flips). The card itself already swapped to APPLIED ✓
      // optimistically; the reload only affects bucket placement.
      if (result.ok && aliveRef.current) {
        await refresh();
      }
      return result.ok
        ? { ok: true }
        : { ok: false, ...(result.error ? { error: result.error } : {}) };
    },
    [refresh],
  );

  const runClear = useCallback(async () => {
    setClearState({ status: 'busy' });
    // Bound the request so the UI can't get stuck in 'Clearing…' if
    // the server hangs (stalled disk, dropped connection). 15s is
    // generous — clear-corrections only deletes a handful of small
    // files, typical p99 is <100ms.
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15_000);
    try {
      await clearCorrections(controller.signal);
    } catch (err) {
      if (!aliveRef.current) return;
      const aborted =
        err instanceof DOMException && err.name === 'AbortError';
      const message = aborted
        ? 'clear-corrections timed out after 15s'
        : err instanceof Error
          ? err.message
          : String(err);
      setClearState({ status: 'error', message });
      return;
    } finally {
      window.clearTimeout(timeoutId);
    }
    if (!aliveRef.current) return;
    setClearState({ status: 'idle' });
    await refresh();
  }, [refresh]);

  // While mining, poll the skill's status file (`correction-status-
  // ${requestId}.json`) for mid-flight detail. Headless `claude -p`
  // streams almost nothing on stdout, so this is the only path to
  // surface phase/current/total/log without changing the CLI surface.
  const requestId = mining.status === 'running' ? mining.requestId : null;
  useEffect(() => {
    if (requestId === null) return undefined;
    let cancelled = false;
    const tick = async () => {
      const status = await fetchCorrectionRunStatus(dataDirBaseUrl, requestId);
      if (cancelled || !aliveRef.current) return;
      setMining((prev) => {
        if (prev.status !== 'running' || prev.requestId !== requestId) return prev;
        return { ...prev, runStatus: status };
      });
    };
    void tick();
    const handle = window.setInterval(() => {
      void tick();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [requestId, dataDirBaseUrl]);

  // Drive a 1Hz tick so the banner's wall-clock elapsed counter updates
  // even when no other state changes. Only mounted while running.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (mining.status !== 'running') return undefined;
    setNowTick(Date.now());
    const handle = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [mining.status]);

  const runMining = useCallback(async () => {
    setRunError(null);
    setMining({
      status: 'running',
      lines: [],
      phase: null,
      phaseProgress: null,
      requestId: null,
      startedAt: null,
      runStatus: null,
    });
    let terminal: Extract<MineEvent, { type: 'done' }> | null = null;
    try {
      // Omit windowDays so the server picks via computeAutoWindow().
      // Pass selection so the server knows whether the user clicked the
      // recent path or opted into backfill before clicking RUN.
      for await (const event of startMineCorrections({ selection })) {
        if (!aliveRef.current) return;
        if (event.type === 'start') {
          // Capture requestId/startedAt so the status-file poller can
          // begin looking up mid-flight progress and the banner can
          // show wall-clock elapsed time.
          setMining((prev) => {
            if (prev.status !== 'running') return prev;
            return {
              ...prev,
              requestId: event.requestId,
              startedAt: event.startedAt,
            };
          });
        } else if (event.type === 'stdout' || event.type === 'stderr') {
          const line = event.line.trim();
          if (line.length === 0) continue;
          setMining((prev) => {
            if (prev.status !== 'running') return prev;
            const next = [...prev.lines, line];
            const trimmed = next.length > RUNNING_LINE_TAIL
              ? next.slice(next.length - RUNNING_LINE_TAIL)
              : next;
            return { ...prev, lines: trimmed };
          });
        } else if (event.type === 'phase') {
          setMining((prev) => {
            if (prev.status !== 'running') return prev;
            const phaseProgress =
              typeof event.ix === 'number' && typeof event.total === 'number'
                ? { ix: event.ix, total: event.total }
                : null;
            return { ...prev, phase: event.phase, phaseProgress };
          });
        } else if (event.type === 'done') {
          terminal = event;
        }
      }
    } catch (err) {
      if (!aliveRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      // 409 means "another run already in flight" — usually from a
      // page reload that cleared local state but not the server's
      // inFlight gate. Re-probe and attach to the existing run instead
      // of surfacing a scary error.
      if (message.includes('status 409')) {
        const probe = await probeMineCorrections(undefined, selection);
        if (!aliveRef.current) return;
        if (probe?.busy && probe.busyRequestId) {
          setMining({
            status: 'running',
            lines: [],
            phase: null,
            phaseProgress: null,
            requestId: probe.busyRequestId,
            startedAt: null,
            runStatus: null,
          });
          return;
        }
        // The 409-then-not-busy race: the prior run completed in the
        // tiny window between our POST and our re-probe. Don't show a
        // scary "in flight" error for a run that's already done —
        // refresh and let the user retry from a clean state.
        setMining({ status: 'idle' });
        await refresh();
        return;
      }
      setRunError(message);
      setMining({ status: 'idle' });
      return;
    }
    if (!aliveRef.current) return;
    if (!terminal || !terminal.ok) {
      const tail = terminal?.stderrTail || terminal?.stdoutTail || 'mining failed';
      setRunError(tail);
      setMining({ status: 'idle' });
      return;
    }
    setMining({ status: 'idle' });
    setSelection('recent');
    await refresh();
  }, [refresh, selection]);

  if (load.status === 'loading') {
    return (
      <section className="lcars-corrections" aria-label="corrections">
        <Header />
        <p className="lcars-corrections__lead">Loading corrections…</p>
      </section>
    );
  }

  if (load.status === 'error') {
    return (
      <section className="lcars-corrections" aria-label="corrections">
        <Header />
        <div className="lcars-corrections__error" role="alert">
          <p>Could not load corrections: {load.message}</p>
          <button
            type="button"
            className="lcars-corrections__btn lcars-corrections__btn--secondary"
            onClick={() => void refresh()}
          >
            RETRY
          </button>
        </div>
      </section>
    );
  }

  const { corrections, candidates } = load;
  const candidateCount = candidates?.corrections.length ?? 0;
  const hasCorrections = !!corrections && corrections.patterns.length > 0;

  // Coverage = how much of the heuristic-recall set has been classified
  // by an LLM run. Both files share id space — the corrections.json is
  // the merged accumulator (entries with `classification: null` are
  // unprocessed), correction-candidates.json is the live recall snapshot
  // from the exporter. Numerator: classified entries that still appear
  // in the candidates set (so we don't credit retired candidates).
  const coverage = (() => {
    const total = candidateCount;
    if (total === 0) return null;
    const classifiedIds = new Set<string>();
    let actionable = 0;
    for (const c of corrections?.corrections ?? []) {
      if (c.classification === null || c.classification === undefined) continue;
      classifiedIds.add(c.id);
      if (c.classification.actionable === true) actionable += 1;
    }
    let classifiedInCandidates = 0;
    for (const c of candidates?.corrections ?? []) {
      if (classifiedIds.has(c.id)) classifiedInCandidates += 1;
    }
    return {
      total,
      classified: classifiedInCandidates,
      actionable,
      patterns: corrections?.patterns.length ?? 0,
      scanStats: candidates?.scanStats ?? null,
    };
  })();

  return (
    <section className="lcars-corrections" aria-label="corrections">
      <Header
        {...(typeof corrections?.generatedAt === 'number'
          ? { generatedAt: corrections.generatedAt }
          : {})}
      />

      {coverage !== null && <CoverageMeter coverage={coverage} />}

      {mining.status === 'running' && (
        <RunningBanner
          state={mining}
          nowMs={nowTick}
          onAbort={() => {
            // The server's claude CLI keeps running; we just detach
            // the viewer's tracking. A subsequent rescan/refresh will
            // re-attach via the busyRequestId probe response.
            setMining({ status: 'idle' });
          }}
        />
      )}

      {runError && mining.status !== 'running' && (
        <div className="lcars-corrections__error" role="alert">
          <p>Mining failed:</p>
          <pre className="lcars-corrections__error-output">{runError}</pre>
          <button
            type="button"
            className="lcars-corrections__btn lcars-corrections__btn--secondary"
            onClick={() => {
              setRunError(null);
              setMining({ status: 'armed' });
            }}
          >
            RETRY
          </button>
        </div>
      )}

      {mining.status === 'armed' && (
        <ArmedPreview
          autoWindow={autoWindow}
          onRun={() => void runMining()}
          onCancel={() => setMining({ status: 'idle' })}
        />
      )}

      {mining.status === 'idle' && !runError && (
        <MiningTrigger
          hasCorrections={hasCorrections}
          candidateCount={candidateCount}
          autoWindow={autoWindow}
          selection={selection}
          onArm={() => setMining({ status: 'armed' })}
          onRefreshAutoWindow={() => void refreshAutoWindow()}
          onSwitchToBackfill={() => {
            setSelection('backfill');
            void refreshAutoWindow('backfill');
          }}
          onSwitchToRecent={() => {
            setSelection('recent');
            void refreshAutoWindow('recent');
          }}
        />
      )}

      {!hasCorrections ? (
        candidateCount === 0 ? (
          <p className="lcars-corrections__empty">
            No correction candidates yet. Run the chat-arch exporter first to populate
            <code> analysis/correction-candidates.json</code>, then click MINE CORRECTIONS to
            classify and cluster them.
          </p>
        ) : (
          <p className="lcars-corrections__empty">
            {candidateCount.toLocaleString()} candidate
            {candidateCount === 1 ? '' : 's'} ready to mine. Click MINE CORRECTIONS above to run
            the LLM classification pass and emit{' '}
            <code>analysis/corrections.json</code>.
          </p>
        )
      ) : (
        <BucketsView
          corrections={corrections!}
          {...(applyAvailable ? { onApply: handleApply } : {})}
          {...(onSelectSession ? { onSelectSession } : {})}
        />
      )}

      {clearAvailable && mining.status !== 'running' && (
        <DangerZone
          state={clearState}
          hasCorrections={!!corrections}
          onArm={() => setClearState({ status: 'armed' })}
          onCancel={() => setClearState({ status: 'idle' })}
          onConfirm={() => void runClear()}
          onDismissError={() => setClearState({ status: 'idle' })}
        />
      )}
    </section>
  );
}

interface CoverageMeterProps {
  coverage: {
    total: number;
    classified: number;
    actionable: number;
    patterns: number;
    scanStats: ScanStats | null;
  };
}

const SOURCE_LABEL: Record<string, string> = {
  cloud: 'cloud',
  cowork: 'cowork',
  'cli-direct': 'CLI',
  'cli-desktop': 'CLI desktop',
};

function fmt(n: number): string {
  return n.toLocaleString();
}

/**
 * Pipeline-coverage indicator. Answers "how much of the archive has
 * been analyzed for this view" by tracking the classified-vs-total
 * ratio of heuristic-recall candidates, and surfaces the funnel
 * downstream of that (actionable ratio, surviving patterns).
 *
 * Compact by default (bar + classified-of-total + 1-line funnel +
 * 1-line provenance). Click the chevron to expand into the full
 * pipeline breakdown plus a "NOT SCANNED" callout that names the
 * coverage gaps (sources with missing transcripts, sources not loaded
 * at all).
 */
function CoverageMeter({ coverage }: CoverageMeterProps) {
  const { total, classified, actionable, patterns, scanStats } = coverage;
  const [expanded, setExpanded] = useState(false);
  const pct = total === 0 ? 0 : Math.round((classified / total) * 100);
  const remaining = Math.max(0, total - classified);
  const actionablePct =
    classified === 0 ? 0 : Math.round((actionable / classified) * 100);

  return (
    <div
      className="lcars-corrections__coverage"
      role="group"
      aria-label="analysis coverage"
    >
      <div className="lcars-corrections__coverage-row">
        <span className="lcars-corrections__coverage-label">
          ANALYSIS COVERAGE
        </span>
        <span className="lcars-corrections__coverage-figure">
          <strong>{fmt(classified)}</strong> / {fmt(total)} candidates
          classified · {pct}%
        </span>
      </div>
      <div
        className="lcars-corrections__coverage-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${classified} of ${total} candidates classified`}
      >
        <span
          className="lcars-corrections__coverage-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="lcars-corrections__coverage-funnel">
        {classified > 0 ? (
          <>
            <strong>{fmt(actionable)}</strong> actionable ({actionablePct}% of
            classified) · <strong>{fmt(patterns)}</strong>{' '}
            {patterns === 1 ? 'pattern' : 'patterns'} surfaced ·{' '}
            <strong>{fmt(remaining)}</strong> unmined
          </>
        ) : (
          <>
            <strong>{fmt(remaining)}</strong> candidate
            {remaining === 1 ? '' : 's'} unmined — no LLM pass run yet.
          </>
        )}
      </p>
      {scanStats !== null && (
        <button
          type="button"
          className="lcars-corrections__coverage-provenance"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="lcars-corrections-pipeline-detail"
          aria-label={`pipeline funnel: ${fmt(scanStats.sessionsScanned)} transcripts produced ${fmt(scanStats.survivingTurns)} prompts producing ${fmt(total)} candidates. ${expanded ? 'Hide' : 'Show'} details.`}
        >
          <span aria-hidden="true">
            {fmt(scanStats.sessionsScanned)} transcripts →{' '}
            {fmt(scanStats.survivingTurns)} prompts → {fmt(total)} candidates
          </span>
          <span
            className="lcars-corrections__coverage-chevron"
            aria-hidden="true"
          >
            {expanded ? '▾' : '▸'}
          </span>
        </button>
      )}
      {scanStats !== null && expanded && (
        <CoverageDetail
          scanStats={scanStats}
          classified={classified}
          actionable={actionable}
          patterns={patterns}
        />
      )}
    </div>
  );
}

interface CoverageDetailProps {
  scanStats: ScanStats;
  classified: number;
  actionable: number;
  patterns: number;
}

function CoverageDetail({
  scanStats,
  classified,
  actionable,
  patterns,
}: CoverageDetailProps) {
  const drops = scanStats.wrapperFiltered + scanStats.tooLongFiltered;
  const notRun = classified === 0;
  const knownSources: ReadonlyArray<string> = [
    'cli-direct',
    'cli-desktop',
    'cowork',
    'cloud',
  ];
  const absent: string[] = [];
  for (const s of knownSources) {
    if ((scanStats.sessionsBySource[s] ?? 0) === 0) absent.push(s);
  }

  return (
    <div
      id="lcars-corrections-pipeline-detail"
      className="lcars-corrections__coverage-detail"
    >
      {(scanStats.sessionsMissing > 0 || absent.length > 0) && (
        <div className="lcars-corrections__pipeline">
          <span className="lcars-corrections__pipeline-label">NOT SCANNED</span>
          <ul className="lcars-corrections__pipeline-list">
            {Object.entries(scanStats.sessionsMissingBySource).map(
              ([source, n]) => (
                <li key={`miss-${source}`}>
                  <strong>{fmt(n)}</strong> {SOURCE_LABEL[source] ?? source}{' '}
                  sessions — no transcript file on disk (stub entries from
                  aborted/deleted sessions)
                </li>
              ),
            )}
            {absent.map((source) => (
              <li key={`absent-${source}`}>
                <strong>0</strong> {SOURCE_LABEL[source] ?? source} sessions —
                {source === 'cloud'
                  ? ' no claude.ai export loaded'
                  : ' source not present in this corpus'}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="lcars-corrections__pipeline">
        <span className="lcars-corrections__pipeline-label">PIPELINE</span>
        <ul className="lcars-corrections__pipeline-list">
          <li>
            <strong>{fmt(scanStats.sessionsInManifest)}</strong> sessions in
            manifest
          </li>
          <li>
            <strong>{fmt(scanStats.sessionsScanned)}</strong> with transcripts
            {scanStats.sessionsMissing > 0 && (
              <span className="lcars-corrections__pipeline-note">
                <span aria-hidden="true">←</span>{' '}
                {fmt(scanStats.sessionsMissing)} missing (no transcript file)
              </span>
            )}
          </li>
          <li>
            <strong>{fmt(scanStats.survivingTurns)}</strong> user prompts
            {drops > 0 && (
              <span className="lcars-corrections__pipeline-note">
                <span aria-hidden="true">←</span> {fmt(drops)} dropped (
                {fmt(scanStats.wrapperFiltered)} system wrappers +{' '}
                {fmt(scanStats.tooLongFiltered)} pastes &gt;4KB)
              </span>
            )}
          </li>
        </ul>
      </div>
      <div className="lcars-corrections__pipeline">
        <span className="lcars-corrections__pipeline-label">CLASSIFICATION</span>
        <ul className="lcars-corrections__pipeline-list">
          {notRun ? (
            <li>
              No LLM classification pass run yet. Click{' '}
              <code>RE-MINE CORRECTIONS</code> to start.
            </li>
          ) : (
            <>
              <li>
                <strong>{fmt(classified)}</strong> classified by LLM
              </li>
              <li>
                <strong>{fmt(actionable)}</strong> actionable
                <span className="lcars-corrections__pipeline-note">
                  ({fmt(classified - actionable)} ruled &ldquo;not a real correction&rdquo;)
                </span>
              </li>
              <li>
                <strong>{fmt(patterns)}</strong>{' '}
                {patterns === 1 ? 'pattern' : 'patterns'} surfaced
                <span className="lcars-corrections__pipeline-note">
                  (clusters of &ge;3 distinct sessions)
                </span>
              </li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
}

interface DangerZoneProps {
  state: ClearState;
  hasCorrections: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onDismissError: () => void;
}

function DangerZone({
  state,
  hasCorrections,
  onArm,
  onCancel,
  onConfirm,
  onDismissError,
}: DangerZoneProps) {
  return (
    <div className="lcars-corrections__danger" aria-label="danger zone">
      <div className="lcars-corrections__danger-header">
        <span className="lcars-corrections__danger-label">DANGER ZONE</span>
      </div>
      {state.status === 'idle' && (
        <div className="lcars-corrections__danger-row">
          <p className="lcars-corrections__danger-blurb">
            Wipe <code>corrections.json</code> and any orphan run-status files.
            Leaves <code>correction-candidates.json</code> intact so the next
            MINE has input.
          </p>
          <button
            type="button"
            className="lcars-corrections__btn lcars-corrections__btn--danger"
            onClick={onArm}
            disabled={!hasCorrections}
            title={
              hasCorrections
                ? undefined
                : 'No corrections file to clear.'
            }
          >
            CLEAR ALL CORRECTIONS
          </button>
        </div>
      )}
      {state.status === 'armed' && (
        <div
          className="lcars-corrections__danger-row"
          role="dialog"
          aria-label="confirm clear corrections"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        >
          <p className="lcars-corrections__danger-confirm">
            Deletes <code>corrections.json</code> and any{' '}
            <code>correction-status-*.json</code> orphans. Reversible — the next
            MINE run rebuilds <code>corrections.json</code> from the existing
            <code> correction-candidates.json</code>. Confirm?
          </p>
          <div className="lcars-corrections__danger-actions">
            <button
              type="button"
              className="lcars-corrections__btn lcars-corrections__btn--danger"
              onClick={onConfirm}
              autoFocus
            >
              CONFIRM CLEAR
            </button>
            <button
              type="button"
              className="lcars-corrections__btn lcars-corrections__btn--ghost"
              onClick={onCancel}
            >
              CANCEL
            </button>
          </div>
        </div>
      )}
      {state.status === 'busy' && (
        <p className="lcars-corrections__danger-blurb" role="status">
          Clearing…
        </p>
      )}
      {state.status === 'error' && (
        <div className="lcars-corrections__error" role="alert">
          <p>Clear failed:</p>
          <pre className="lcars-corrections__error-output">{state.message}</pre>
          <button
            type="button"
            className="lcars-corrections__btn lcars-corrections__btn--secondary"
            onClick={onDismissError}
          >
            DISMISS
          </button>
        </div>
      )}
    </div>
  );
}

interface HeaderProps {
  generatedAt?: number;
}

function Header({ generatedAt }: HeaderProps) {
  return (
    <header className="lcars-corrections__header">
      <h2 className="lcars-corrections__title">CORRECTIONS</h2>
      <p className="lcars-corrections__lead">
        Recurring instructions you keep giving the model — clustered, ranked, and paired with
        proposed CLAUDE.md upgrades. Click APPLY to log a CLAUDE.md edit you&apos;ve made; the
        loop closes when the next mining pass shows the rule is no longer recurring. Apply
        history is recorded in <code>applied-improvements.json</code> next to{' '}
        <code>corrections.json</code>.
      </p>
      {typeof generatedAt === 'number' && (
        <p className="lcars-corrections__meta">
          Generated {formatGenerated(generatedAt)}
        </p>
      )}
    </header>
  );
}

interface MiningTriggerProps {
  hasCorrections: boolean;
  candidateCount: number;
  autoWindow: AutoWindowResult | null;
  selection: 'recent' | 'backfill';
  onArm: () => void;
  onRefreshAutoWindow: () => void;
  onSwitchToBackfill: () => void;
  onSwitchToRecent: () => void;
}

function MiningTrigger({
  hasCorrections,
  candidateCount,
  autoWindow,
  selection,
  onArm,
  onRefreshAutoWindow,
  onSwitchToBackfill,
  onSwitchToRecent,
}: MiningTriggerProps) {
  const ctaLabel = hasCorrections ? 'RE-MINE CORRECTIONS' : 'MINE CORRECTIONS';
  const isIdle = autoWindow?.mode === 'idle';
  const isUnavailable = autoWindow?.mode === 'unavailable';
  const disabled =
    isIdle || isUnavailable || (candidateCount === 0 && !hasCorrections);
  const modeLabel = selection === 'backfill' ? 'BACKFILL' : 'AUTO WINDOW';
  const backfill = autoWindow?.backfillAvailable ?? null;

  return (
    <div className="lcars-corrections__trigger">
      <div className="lcars-corrections__auto">
        <span className="lcars-corrections__auto-label">{modeLabel}</span>
        <span className="lcars-corrections__auto-value">
          {autoWindow === null
            ? 'computing…'
            : autoWindow.mode === 'idle'
              ? 'no new candidates'
              : autoWindow.mode === 'unavailable'
                ? 'no data'
                : `${autoWindow.windowDays}d · ${autoWindow.candidateCount} candidate${autoWindow.candidateCount === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          className="lcars-corrections__btn lcars-corrections__btn--ghost"
          onClick={onRefreshAutoWindow}
          aria-label="refresh auto window"
          title="Recompute auto-window"
        >
          ↻
        </button>
      </div>
      <button
        type="button"
        className="lcars-corrections__btn lcars-corrections__btn--primary"
        onClick={onArm}
        disabled={disabled}
        title={
          isIdle
            ? 'No new candidates since the last mining run.'
            : isUnavailable
              ? 'Run the chat-arch exporter first to produce candidates.'
              : undefined
        }
      >
        ▶ {ctaLabel}
      </button>
      {selection === 'recent' && backfill !== null && (
        <button
          type="button"
          className="lcars-corrections__btn lcars-corrections__btn--secondary"
          onClick={onSwitchToBackfill}
          title={`${backfill.count} unprocessed older than the recent set, oldest from ${backfill.oldestDate}`}
        >
          BACKFILL OLDER ({backfill.count})
        </button>
      )}
      {selection === 'backfill' && (
        <button
          type="button"
          className="lcars-corrections__btn lcars-corrections__btn--ghost"
          onClick={onSwitchToRecent}
        >
          ← RECENT
        </button>
      )}
    </div>
  );
}

interface ArmedPreviewProps {
  autoWindow: AutoWindowResult | null;
  onRun: () => void;
  onCancel: () => void;
}

function ArmedPreview({ autoWindow, onRun, onCancel }: ArmedPreviewProps) {
  const candidateCount = autoWindow?.candidateCount ?? 0;
  const windowDays = autoWindow?.windowDays ?? 0;
  const reasoning = autoWindow?.reasoning ?? 'Auto-window selection unavailable.';
  return (
    <div
      className="lcars-corrections__armed"
      role="dialog"
      aria-label="confirm mine"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="lcars-corrections__armed-summary">
        Will mine {candidateCount.toLocaleString()} candidate
        {candidateCount === 1 ? '' : 's'} from the last {windowDays}{' '}
        {windowDays === 1 ? 'day' : 'days'}. Estimated work:{' '}
        ~{Math.max(1, Math.ceil(candidateCount / 20))} classification batch
        {Math.ceil(candidateCount / 20) === 1 ? '' : 'es'} plus
        one proposal call per cluster, ~3-8 min wall-clock. Counts against your
        Claude Code plan usage; no separate billing.
      </p>
      <p className="lcars-corrections__armed-reasoning">{reasoning}</p>
      <div className="lcars-corrections__armed-actions">
        <button
          type="button"
          className="lcars-corrections__btn lcars-corrections__btn--primary"
          onClick={onRun}
          autoFocus
        >
          ▶ RUN MINING
        </button>
        <button
          type="button"
          className="lcars-corrections__btn lcars-corrections__btn--ghost"
          onClick={onCancel}
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

interface RunningBannerProps {
  state: Extract<MiningState, { status: 'running' }>;
  nowMs: number;
  onAbort?: () => void;
}

const STATUS_LABELS: Record<CorrectionRunStatus['status'], string> = {
  starting: 'starting',
  classifying: 'classifying candidates',
  'ingesting-configs': 'ingesting configs',
  embedding: 'embedding',
  clustering: 'clustering',
  proposing: 'generating proposals',
  writing: 'writing output',
  complete: 'complete',
  error: 'error',
};

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function formatStaleness(ms: number): string {
  if (ms < 1500) return 'just now';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  return `${m}m ago`;
}

function RunningBanner({ state, nowMs, onAbort }: RunningBannerProps) {
  const rs = state.runStatus;
  // Prefer the skill's structured status file over the regex-parsed
  // stdout phase — it's the source of truth, updated on every stage
  // transition. Fall back to the heuristic phase only when the status
  // file hasn't been written yet (first few seconds of a run).
  const phaseLabel =
    rs !== null ? STATUS_LABELS[rs.status] ?? rs.status : state.phase;
  const current = rs?.progress?.current;
  const total = rs?.progress?.total;
  const subPhase = rs?.progress?.phase;
  const progressText =
    typeof current === 'number' && typeof total === 'number'
      ? `${current}/${total}`
      : state.phaseProgress
        ? `${state.phaseProgress.ix}/${state.phaseProgress.total}`
        : null;

  // When we attached to an in-flight run on mount, we never saw the
  // server's `start` event so `state.startedAt` is null. Fall back to
  // the skill's status-file value so the elapsed counter still works.
  const startedAt = state.startedAt ?? rs?.startedAt ?? null;
  const elapsed = startedAt !== null ? formatElapsed(nowMs - startedAt) : null;
  const staleness =
    rs?.updatedAt !== undefined ? formatStaleness(nowMs - rs.updatedAt) : null;

  const statusLog = rs?.log ?? [];
  const tailLog =
    statusLog.length > STATUS_LOG_TAIL
      ? statusLog.slice(statusLog.length - STATUS_LOG_TAIL)
      : statusLog;

  // Accessibility: aria-busy on the outer container marks the panel
  // as in-progress without re-announcing every 1.5s status poll.
  // Phase TRANSITIONS get their own aria-live region (the dedicated
  // span below containing only `phaseLabel`), so SR users hear "now
  // classifying" once per stage instead of once per poll.
  return (
    <div
      className="lcars-corrections__running"
      role="status"
      aria-busy="true"
      aria-label="mining in progress"
    >
      <span className="lcars-corrections__sr-only" aria-live="polite">
        {phaseLabel ?? 'starting'}
      </span>
      <div className="lcars-corrections__running-header">
        <span className="lcars-corrections__spinner" aria-hidden="true" />
        <span className="lcars-corrections__running-title">MINING</span>
        {phaseLabel && (
          <span className="lcars-corrections__running-phase" aria-hidden="true">
            {phaseLabel}
            {subPhase && subPhase !== phaseLabel ? ` · ${subPhase}` : ''}
            {progressText ? ` · ${progressText}` : ''}
          </span>
        )}
        {elapsed !== null && (
          <span
            className="lcars-corrections__running-elapsed"
            aria-label="elapsed time"
          >
            {elapsed}
          </span>
        )}
        {staleness !== null && (
          <span
            className="lcars-corrections__running-staleness"
            title="time since last status update"
          >
            updated {staleness}
          </span>
        )}
        {onAbort && (
          <button
            type="button"
            className="lcars-corrections__btn lcars-corrections__btn--ghost lcars-corrections__running-abort"
            onClick={onAbort}
            title="Detach from this run. The skill keeps running on the server; this just stops the viewer from tracking it."
          >
            DETACH
          </button>
        )}
      </div>
      {rs?.error && (
        <p className="lcars-corrections__running-error" role="alert">
          {rs.error}
        </p>
      )}
      {tailLog.length > 0 ? (
        <ul className="lcars-corrections__log" role="list">
          {tailLog.map((line, ix) => (
            <li
              key={`s-${ix}-${line.slice(0, 32)}`}
              className="lcars-corrections__log-line"
            >
              {line}
            </li>
          ))}
        </ul>
      ) : state.lines.length > 0 ? (
        <ul className="lcars-corrections__log" role="list">
          {state.lines.map((line, ix) => (
            <li
              key={`${ix}-${line.slice(0, 32)}`}
              className="lcars-corrections__log-line"
            >
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className="lcars-corrections__running-hint">
          {rs === null
            ? 'Waiting for first status update from the skill…'
            : 'No log lines yet.'}
        </p>
      )}
    </div>
  );
}

interface BucketsViewProps {
  corrections: CorrectionsFile;
  onApply?: (
    pattern: CorrectionPattern,
    upgrade: ProposedUpgrade,
    extras: { targetFiles?: string[]; notes?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  onSelectSession?: (sessionId: string) => void;
}

function BucketsView({ corrections, onApply, onSelectSession }: BucketsViewProps) {
  const instancesById = useMemo(() => {
    const m = new Map<string, Correction>();
    for (const c of corrections.corrections) m.set(c.id, c);
    return m;
  }, [corrections.corrections]);

  const buckets = useMemo(() => {
    const seen = new Set<string>();
    const grouped: Record<'recurring' | 'encoded' | 'new', CorrectionPattern[]> = {
      recurring: [],
      encoded: [],
      new: [],
    };
    for (const p of corrections.patterns) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      grouped[bucketFor(p)].push(p);
    }
    for (const k of Object.keys(grouped) as Array<keyof typeof grouped>) {
      grouped[k].sort(sortPatterns);
    }
    return grouped;
  }, [corrections.patterns]);

  return (
    <div className="lcars-corrections__buckets">
      {BUCKET_DEFS.map((def) => {
        const items = buckets[def.key];
        return (
          <section
            key={def.key}
            className={`lcars-corrections__bucket lcars-corrections__bucket--${def.key}`}
            aria-label={def.label}
          >
            <header className="lcars-corrections__bucket-header">
              <h3 className="lcars-corrections__bucket-title">{def.label}</h3>
              <span className="lcars-corrections__bucket-count">
                {items.length} {items.length === 1 ? 'pattern' : 'patterns'}
              </span>
            </header>
            <p className="lcars-corrections__bucket-blurb">{def.blurb}</p>
            {items.length === 0 ? (
              <p className="lcars-corrections__bucket-empty">Nothing here — good.</p>
            ) : (
              <ul className="lcars-corrections__pattern-list" role="list">
                {items.map((p) => (
                  <li key={p.id}>
                    <CorrectionPatternCard
                      pattern={p}
                      instancesById={instancesById}
                      {...(onApply
                        ? {
                            onApply: (upgrade, extras) => onApply(p, upgrade, extras),
                          }
                        : {})}
                      {...(onSelectSession ? { onSelectSession } : {})}
                    />
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
