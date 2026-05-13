import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AppliedImprovementsFile,
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
import { AppliedImprovementsSummary } from './AppliedImprovementsSummary.js';
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
import { formatRelative } from '../util/time.js';

export interface CorrectionsPanelProps {
  /** Same base URL the manifest was fetched from (e.g. "/chat-arch-data"). */
  dataDirBaseUrl: string;
  /**
   * Callback for opening a session in detail view. Plumbed from
   * ChatArchViewer; when omitted, instance pills render as static
   * (non-clickable) cards.
   */
  onSelectSession?: (sessionId: string) => void;
  /**
   * `manifest.generatedAt` from the host. Drives the
   * AppliedImprovementsSummary's stale-index warning. Optional — when
   * omitted (e.g. embedded panel without a host manifest), the chip
   * is silently skipped.
   */
  manifestGeneratedAt?: number | null;
  /**
   * Trigger a corpus rescan. Plumbed from ChatArchViewer (which owns
   * the `useRescan` controller). When provided AND `rescanAvailable`
   * is true, the AppliedImprovementsSummary's stale-index chip
   * upgrades from a passive "go run UPDATE LOCAL" hint to an
   * actionable button that fires this callback directly.
   */
  onRefreshIndex?: () => void;
  /**
   * Whether the rescan endpoint probe succeeded on the host. Hosted
   * static builds with no `/api/rescan` should leave this false so
   * the stale chip falls back to the non-interactive `<span>` even if
   * `onRefreshIndex` is somehow defined.
   */
  rescanAvailable?: boolean;
  /**
   * Phase 4 — when the host has loaded a demo fixture that ships its
   * own corrections + applied-improvements inline (see
   * `generateDemoUpload`), pass them here so the panel skips the
   * disk-fetch path and renders the demo data directly. The merge
   * over the apply ledger still runs so RECURRING vs ENCODED vs NEW
   * bucket placement matches what the production fetch path would
   * produce. Both default to `undefined`, in which case the panel
   * fetches from `dataDirBaseUrl` as before.
   */
  overrideCorrections?: CorrectionsFile | null;
  overrideApplied?: AppliedImprovementsFile | null;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      corrections: CorrectionsFile | null;
      candidates: CorrectionsFile | null;
      applied: AppliedImprovementsFile | null;
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

/**
 * Sentinel topic for patterns emitted by mining runs that predate the
 * `tag-topics` skill stage. Acts as a graceful fallback so the viewer
 * doesn't break on legacy `corrections.json` files; re-mining assigns a
 * real topic and the bucket disappears.
 */
const UNTAGGED_TOPIC = 'Untagged';

function topicOf(p: CorrectionPattern): string {
  return typeof p.topic === 'string' && p.topic.trim().length > 0
    ? p.topic.trim()
    : UNTAGGED_TOPIC;
}

interface TopicBucket {
  key: string;
  label: string;
  patterns: CorrectionPattern[];
  /** Sum of occurrenceCount across all patterns — drives bucket order. */
  weight: number;
  /** True when ≥1 pattern is recurring after applied. Hoists the bucket
   *  toward the top regardless of weight (recurring is the highest-
   *  signal finding the user can act on), AND drives the bucket's
   *  visual urgency via the `data-has-recurring` style hook so the
   *  user can scan the page for hot spots at a glance. */
  hasRecurring: boolean;
  /** True when ≥1 pattern is alreadyEncoded but not recurring — a
   *  weaker urgency signal than `hasRecurring`. Drives the bucket's
   *  visual treatment when `hasRecurring` is false. */
  hasEncoded: boolean;
}

/**
 * Group patterns by their LLM-derived topic. Buckets are ordered by:
 *   1. has-recurring desc (recurring topics surface first)
 *   2. weight desc (larger topics before smaller)
 *   3. label asc (stable tiebreak)
 * Within a bucket, recurring patterns sort to the top so the highest-
 * signal items inside a topic are visible without scrolling.
 */
function buildTopicBuckets(
  patterns: ReadonlyArray<CorrectionPattern>,
): TopicBucket[] {
  const seen = new Set<string>();
  const byTopic = new Map<string, CorrectionPattern[]>();
  for (const p of patterns) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const topic = topicOf(p);
    const arr = byTopic.get(topic);
    if (arr) arr.push(p);
    else byTopic.set(topic, [p]);
  }
  const buckets: TopicBucket[] = [];
  for (const [topic, group] of byTopic) {
    group.sort(sortPatterns);
    let weight = 0;
    let hasRecurring = false;
    let hasEncoded = false;
    for (const p of group) {
      weight += p.occurrenceCount;
      if (p.recurringPostApplication) hasRecurring = true;
      else if (p.alreadyEncoded) hasEncoded = true;
    }
    buckets.push({
      key: topic,
      label: topic.toUpperCase(),
      patterns: group,
      weight,
      hasRecurring,
      hasEncoded,
    });
  }
  buckets.sort((a, b) => {
    if (a.hasRecurring !== b.hasRecurring) return a.hasRecurring ? -1 : 1;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.label.localeCompare(b.label);
  });
  return buckets;
}

function sortPatterns(a: CorrectionPattern, b: CorrectionPattern): number {
  // Recurring-after-applied sorts to the top within a bucket — the
  // strongest "your rule is failing in practice" signal beats raw
  // confidence.
  if (a.recurringPostApplication !== b.recurringPostApplication) {
    return a.recurringPostApplication ? -1 : 1;
  }
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

/**
 * Header timestamp formatter. Uses the shared relative-time util so
 * the chip reads "2d ago" instead of an ISO blob; the absolute ISO
 * survives in the surrounding `title=` tooltip for debug use.
 */
function relativeGenerated(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  return formatRelative(ms);
}

type ClearState =
  | { status: 'idle' }
  | { status: 'armed' }
  | { status: 'busy' }
  | { status: 'error'; message: string };

export function CorrectionsPanel({
  dataDirBaseUrl,
  onSelectSession,
  manifestGeneratedAt = null,
  onRefreshIndex,
  rescanAvailable = false,
  overrideCorrections,
  overrideApplied,
}: CorrectionsPanelProps) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  // Phase 2b: which pattern (if any) the AppliedImprovementsSummary
  // most recently asked us to scroll to. Cleared after the highlight
  // animation completes so a second click on the same row re-fires.
  const [highlightedPatternId, setHighlightedPatternId] = useState<string | null>(null);
  // Click counter — incremented on every onSelectPattern. The
  // auto-clear timeout closes over the click-time tick so a stale
  // timeout (from an earlier click on a now-superseded row) never
  // wipes a newer highlight. Without this, A → B → A produces the
  // race where the first A's 2s timeout fires after the second A is
  // already on screen and clears it prematurely.
  const [highlightTick, setHighlightTick] = useState(0);
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

  // Single-CTA mining (per the "MINE ALL" UX): selection is always 'all'.
  // The backend's recent/backfill split still exists for future power-user
  // surfaces but is no longer driven by this panel.
  const [selection] = useState<'recent' | 'backfill' | 'all'>('all');

  const refreshAutoWindow = useCallback(
    async (sel: 'recent' | 'backfill' | 'all' = selection) => {
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
      // Phase 4 — when an override is supplied (demo path) skip the
      // network fetch for that slot. Candidates have no demo
      // counterpart and aren't user-visible at the demo path, so the
      // candidates loader just resolves to whatever's on disk (null
      // on hosted = no recall surface, fine).
      const [rawCorrections, candidates, applied] = await Promise.all([
        overrideCorrections !== undefined
          ? Promise.resolve(overrideCorrections)
          : loadCorrectionsFile(dataDirBaseUrl),
        loadCorrectionCandidatesFile(dataDirBaseUrl),
        overrideApplied !== undefined
          ? Promise.resolve(overrideApplied)
          : loadAppliedImprovementsFile(dataDirBaseUrl),
      ]);
      if (!aliveRef.current) return;
      // Merge the apply ledger over the canonical mining-pipeline
      // output. corrections.json itself is never mutated — the
      // merge runs at read time so a future re-mine never clobbers
      // the user's apply history.
      const corrections = rawCorrections
        ? mergeAppliedImprovements(rawCorrections, applied)
        : null;
      setLoad({ status: 'ready', corrections, candidates, applied });
      void refreshAutoWindow();
    } catch (err) {
      if (!aliveRef.current) return;
      setLoad({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [dataDirBaseUrl, refreshAutoWindow, overrideCorrections, overrideApplied]);

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

  const { corrections, candidates, applied } = load;
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

      <AppliedImprovementsSummary
        applied={applied}
        corrections={corrections}
        manifestGeneratedAt={manifestGeneratedAt}
        {...(rescanAvailable && onRefreshIndex
          ? { onRefreshIndex }
          : {})}
        onSelectPattern={(patternId) => {
          // Three-phase highlight:
          //   1. Clear current highlight to null synchronously, so
          //      React can unmount the previous data-highlighted attr
          //      and the CSS animation actually restarts on round 2 of
          //      "click the same row twice".
          //   2. requestAnimationFrame to set the next-tick highlight
          //      after the DOM has flushed the null state. setting in
          //      the same render would no-op (React dedupes) and the
          //      pulse would stay frozen.
          //   3. Schedule a 2s auto-clear that's gated by the tick at
          //      click-time — a previous click's timeout cannot wipe
          //      a newer click's highlight.
          const nextTick = highlightTick + 1;
          setHighlightedPatternId(null);
          setHighlightTick(nextTick);
          if (typeof window !== 'undefined') {
            window.requestAnimationFrame(() => {
              setHighlightedPatternId(patternId);
              // CSS.escape is missing on older jsdom + some legacy
              // browsers; fall back to attribute-iteration so we still
              // scroll the right card without throwing. Pattern ids are
              // already safe-ish (hash-derived in the schema) but the
              // fallback path is cheap and removes a runtime dependency.
              const escapeFn =
                typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                  ? CSS.escape
                  : null;
              let el: Element | null = null;
              if (escapeFn) {
                el = document.querySelector(
                  `[data-pattern-id="${escapeFn(patternId)}"]`,
                );
              } else {
                const all = document.querySelectorAll('[data-pattern-id]');
                for (const node of Array.from(all)) {
                  if (node.getAttribute('data-pattern-id') === patternId) {
                    el = node;
                    break;
                  }
                }
              }
              if (el && 'scrollIntoView' in el) {
                (el as HTMLElement).scrollIntoView({
                  behavior: 'smooth',
                  block: 'center',
                });
              }
            });
            window.setTimeout(() => {
              // Only clear if THIS click's tick is still the latest —
              // a newer click bumped highlightTick and owns the
              // current highlight, so we leave it alone. (The newer
              // click scheduled its own auto-clear.)
              setHighlightTick((currentTick) => {
                if (currentTick === nextTick) {
                  setHighlightedPatternId(null);
                }
                return currentTick;
              });
            }, 2000);
          }
        }}
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
          onArm={() => setMining({ status: 'armed' })}
          onRefreshAutoWindow={() => void refreshAutoWindow()}
          rescanAvailable={rescanAvailable}
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
          highlightedPatternId={highlightedPatternId}
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

  return (
    <div
      className="lcars-corrections__coverage"
      role="group"
      aria-label="mining progress"
    >
      <div
        className="lcars-corrections__coverage-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${classified} of ${total} candidates mined`}
      >
        <span
          className="lcars-corrections__coverage-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="lcars-corrections__coverage-row">
        <span className="lcars-corrections__coverage-figure">
          <strong>{fmt(classified)}</strong> / {fmt(total)} mined
        </span>
      </div>
      {scanStats !== null && (
        <button
          type="button"
          className="lcars-corrections__coverage-provenance"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="lcars-corrections-pipeline-detail"
          aria-label={`${expanded ? 'Hide' : 'Show'} mining details`}
        >
          <span aria-hidden="true">{expanded ? '▾' : '▸'} details</span>
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
  // Done/pending is keyed off whether any patterns have been mined, NOT
  // `classified` (which counts only classifications that still appear in
  // the live candidates set). After a HEURISTIC_RECALL_VERSION bump that
  // retires every prior candidate, `classified` returns to 0 while
  // `patterns` is still non-zero — and the badge would otherwise lie
  // "pending · click RE-MINE CORRECTIONS" while the Last-mined chip and
  // the pattern list contradicted it.
  const notRun = patterns === 0;
  const knownSources: ReadonlyArray<string> = [
    'cli-direct',
    'cli-desktop',
    'cowork',
    'cloud',
  ];

  return (
    <div
      id="lcars-corrections-pipeline-detail"
      className="lcars-corrections__coverage-detail"
    >
      {/* Stage 1: Exporter scan — already done by the time the user
       *  opens this panel. The ✓ + "done" copy answers the user's
       *  "the headline says 0 mined but everything below has non-zero
       *  counts" reading: those numbers are scan-stage progress, not
       *  mine-stage progress. */}
      <div
        className="lcars-corrections__stage"
        data-stage-status="done"
        aria-label="EXPORTER SCAN stage — done"
      >
        <header className="lcars-corrections__stage-header">
          <span
            className="lcars-corrections__stage-badge"
            aria-hidden="true"
          >
            ✓
          </span>
          <span className="lcars-corrections__stage-title">
            EXPORTER SCAN
          </span>
          <span className="lcars-corrections__stage-note">
            done · re-runs on SCAN LOCAL
          </span>
        </header>
        <div className="lcars-corrections__stage-body">
          <div className="lcars-corrections__pipeline">
            <span className="lcars-corrections__pipeline-label">SCANNED</span>
            <span className="lcars-corrections__pipeline-sublabel">
              transcripts read · indexed in manifest
            </span>
            <ul className="lcars-corrections__pipeline-list">
              {knownSources.map((source) => {
                const total = scanStats.sessionsBySource[source] ?? 0;
                const missing = scanStats.sessionsMissingBySource[source] ?? 0;
                const crashed =
                  scanStats.sessionsCrashedBySource?.[source] ?? 0;
                const trueMissing = Math.max(0, missing - crashed);
                const scanned = Math.max(0, total - missing);
                // Note is a React node (not string) so the split path
                // can render two stacked lines via <br/>, keeping the
                // "X missing on disk" / "Y CLI crashed" halves on their
                // own lines at narrow widths. The single-line branches
                // collapse to a plain string wrapped in the same span.
                let note: ReactNode = null;
                if (total === 0) {
                  note =
                    source === 'cloud'
                      ? 'no claude.ai export loaded'
                      : 'not present in this corpus';
                } else if (missing === 0) {
                  note = null;
                } else if (crashed > 0 && trueMissing > 0) {
                  note = (
                    <>
                      {fmt(trueMissing)} transcript file missing on disk
                      <br />
                      {fmt(crashed)} CLI crashed before writing a transcript
                    </>
                  );
                } else if (crashed > 0) {
                  note = `${fmt(crashed)} CLI crashed before writing a transcript (audit.jsonl still has the user's turns)`;
                } else {
                  note = `${fmt(trueMissing)} transcript file missing on disk (deleted or aborted between session end and scan)`;
                }
                return (
                  <li key={`scan-${source}`}>
                    <span className="lcars-corrections__pipeline-source">
                      {SOURCE_LABEL[source] ?? source}
                    </span>{' '}
                    <strong>
                      {fmt(scanned)} / {fmt(total)}
                    </strong>
                    {note && (
                      <span className="lcars-corrections__pipeline-note">
                        {note}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
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
        </div>
      </div>
      {/* Stage 2: LLM mine — the action the headline bar tracks. The
       *  ▶ + "pending" copy when nothing's been classified yet makes
       *  it explicit that the 0 / N count IS the next step (rather
       *  than a result that contradicts the non-zero scan numbers
       *  above). */}
      <div
        className="lcars-corrections__stage"
        data-stage-status={notRun ? 'pending' : 'done'}
        aria-label={`LLM MINE stage — ${notRun ? 'pending' : 'done'}`}
      >
        <header className="lcars-corrections__stage-header">
          <span
            className="lcars-corrections__stage-badge"
            aria-hidden="true"
          >
            {notRun ? '▶' : '✓'}
          </span>
          <span className="lcars-corrections__stage-title">LLM MINE</span>
          <span className="lcars-corrections__stage-note">
            {notRun
              ? 'pending · click RE-MINE CORRECTIONS to run'
              : `done · ${fmt(classified)} classified`}
          </span>
        </header>
        <div className="lcars-corrections__stage-body">
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
  const hasTime = typeof generatedAt === 'number';
  return (
    <header className="lcars-corrections__header">
      <div className="lcars-corrections__title-row">
        <h2 className="lcars-corrections__title">CORRECTIONS</h2>
        {hasTime && (
          <span
            className="lcars-corrections__time"
            title={`Generated ${formatGenerated(generatedAt!)}`}
          >
            Last mined {relativeGenerated(generatedAt!)}
          </span>
        )}
      </div>
    </header>
  );
}

interface MiningTriggerProps {
  hasCorrections: boolean;
  candidateCount: number;
  autoWindow: AutoWindowResult | null;
  onArm: () => void;
  onRefreshAutoWindow: () => void;
  /**
   * Phase 4 — when `false`, the host is the hosted static build with
   * no `/api/mine-corrections` endpoint. Mining can never run there;
   * the trigger explains that and points the user at INSTALL LOCALLY
   * instead of leaving them staring at "computing…" forever.
   */
  rescanAvailable?: boolean;
}

function MiningTrigger({
  hasCorrections,
  candidateCount,
  autoWindow,
  onArm,
  onRefreshAutoWindow,
  rescanAvailable = true,
}: MiningTriggerProps) {
  const isIdle = autoWindow?.mode === 'idle';
  const isUnavailable = autoWindow?.mode === 'unavailable';
  // Phase 4 — when the local server is unreachable AND the auto-window
  // probe never resolved, the "computing…" caption would otherwise
  // stay forever. Treat this as the hosted-static dead end and swap
  // the trigger for an install-locally hint.
  const localOnly = !rescanAvailable && autoWindow === null;
  const disabled =
    isIdle || isUnavailable || localOnly || (candidateCount === 0 && !hasCorrections);

  // With selection='all' the autoWindow result already carries the
  // entire unprocessed set — no separate "older" count to add.
  const totalReady = autoWindow?.candidateCount ?? 0;
  const windowDays = autoWindow?.windowDays ?? null;
  const hasReady = totalReady > 0 && !isIdle && !isUnavailable;

  const ctaLabel = isIdle
    ? 'NO NEW CANDIDATES'
    : isUnavailable
      ? 'NO DATA'
      : hasReady
        ? `MINE ALL ${totalReady}`
        : hasCorrections
          ? 'RE-MINE CORRECTIONS'
          : 'MINE CORRECTIONS';

  const ctaTitle = localOnly
    ? 'Mining is local-only — install chat-arch on your machine to mine your own corpus.'
    : isIdle
      ? 'No new candidates since the last mining run.'
      : isUnavailable
        ? 'Run the chat-arch exporter first to produce candidates.'
        : hasReady && windowDays !== null
          ? `Mine all ${totalReady} unprocessed candidates (~${windowDays} day span).`
          : undefined;

  const status = localOnly
    ? 'Mining is local-only.'
    : autoWindow === null
      ? 'Computing…'
      : isUnavailable
        ? 'No candidates yet.'
        : isIdle
          ? 'Nothing new to mine.'
          : `${totalReady} ready to mine`;

  return (
    <div className="lcars-corrections__trigger">
      <div className="lcars-corrections__trigger-status-row">
        <span className="lcars-corrections__trigger-status">{status}</span>
        <button
          type="button"
          className="lcars-corrections__btn lcars-corrections__btn--ghost lcars-corrections__btn--icon"
          onClick={onRefreshAutoWindow}
          aria-label="refresh"
          title="Recompute the candidate count"
        >
          ↻
        </button>
      </div>
      <div className="lcars-corrections__trigger-row">
        <button
          type="button"
          className="lcars-corrections__btn lcars-corrections__btn--primary"
          onClick={onArm}
          disabled={disabled}
          {...(ctaTitle ? { title: ctaTitle } : {})}
        >
          ▶ {ctaLabel}
        </button>
      </div>
      {localOnly && (
        <p className="lcars-corrections__auto-hint">
          Mining is local-only — these demo patterns ship with the bundled fixture.{' '}
          <a
            href="https://github.com/BryceEWatson/chat-arch#quickstart"
            target="_blank"
            rel="noreferrer noopener"
          >
            Install chat-arch
          </a>{' '}
          to mine your own corpus.
        </p>
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
        one proposal call per cluster,{' '}
        ~{Math.max(3, Math.ceil(Math.ceil(candidateCount / 20) * 0.75))}-
        {Math.max(8, Math.ceil(Math.ceil(candidateCount / 20) * 2))} min
        wall-clock. Counts against your Claude Code plan usage; no separate
        billing.
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
  'tagging-topics': 'tagging topics',
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
  /**
   * Phase 2b: when set, the matching CorrectionPatternCard renders
   * with `data-highlighted` so a CSS rule can flash it after the
   * AppliedImprovementsSummary scrolls it into view.
   */
  highlightedPatternId?: string | null;
}

function BucketsView({
  corrections,
  onApply,
  onSelectSession,
  highlightedPatternId,
}: BucketsViewProps) {
  const instancesById = useMemo(() => {
    const m = new Map<string, Correction>();
    for (const c of corrections.corrections) m.set(c.id, c);
    return m;
  }, [corrections.corrections]);

  const buckets = useMemo(
    () => buildTopicBuckets(corrections.patterns),
    [corrections.patterns],
  );

  return (
    <div className="lcars-corrections__buckets">
      {buckets.map((bucket) => (
        <section
          key={bucket.key}
          className="lcars-corrections__bucket"
          aria-label={bucket.label}
          data-topic={bucket.key}
          // Signal-based urgency hooks — restore the visual
          // differentiation the dropped --recurring/--encoded/--new
          // modifier classes used to provide. Recurring wins over
          // encoded (the CSS uses attribute selectors, last rule
          // wins) so a bucket with both signals reads as urgent.
          data-has-recurring={bucket.hasRecurring ? 'true' : 'false'}
          data-has-encoded={bucket.hasEncoded ? 'true' : 'false'}
        >
          <header className="lcars-corrections__bucket-header">
            <h3 className="lcars-corrections__bucket-title">{bucket.label}</h3>
            <span className="lcars-corrections__bucket-count">
              {bucket.patterns.length}{' '}
              {bucket.patterns.length === 1 ? 'pattern' : 'patterns'}
            </span>
          </header>
          <ul className="lcars-corrections__pattern-list" role="list">
            {bucket.patterns.map((p) => {
              const isHighlighted = highlightedPatternId === p.id;
              return (
                <li
                  key={p.id}
                  data-pattern-id={p.id}
                  {...(isHighlighted ? { 'data-highlighted': 'true' } : {})}
                  className="lcars-corrections__pattern-item"
                >
                  <CorrectionPatternCard
                    pattern={p}
                    instancesById={instancesById}
                    defaultExpanded={isHighlighted}
                    {...(onApply
                      ? {
                          onApply: (upgrade, extras) => onApply(p, upgrade, extras),
                        }
                      : {})}
                    {...(onSelectSession ? { onSelectSession } : {})}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
