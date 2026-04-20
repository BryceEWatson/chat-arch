import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionManifest, UnifiedSessionEntry, SessionSource } from '@chat-arch/schema';
import type {
  AnalysisState,
  ConversationCache,
  FetchState,
  FilterState,
  Mode,
  UploadedCloudData,
} from './types.js';
import { MODE_COLOR } from './types.js';
import { TopBar } from './components/TopBar.js';
import { ActivityLogPanel } from './components/ActivityLogPanel.js';
import { useActivityLog } from './data/activityLog.js';
import { Sidebar } from './components/Sidebar.js';
import { UpperPanel } from './components/UpperPanel.js';
import { MidBar } from './components/MidBar.js';
import { EmptyState } from './components/EmptyState.js';
import { ErrorState } from './components/ErrorState.js';
import { UploadPanel } from './components/UploadPanel.js';
import { FilterBar } from './components/FilterBar.js';
import { TierIndicator } from './components/TierIndicator.js';
import {
  CommandMode,
  TimelineMode,
  DetailMode,
  ConstellationMode,
  CostMode,
} from './components/modes/index.js';
import type { CostKpiSection } from './components/modes/CostMode.js';
import { fetchManifest } from './data/fetch.js';
import { fetchAnalysisTierStatus } from './data/analysisFetch.js';
import {
  parseDuplicatesFile,
  mergeDuplicateClusters,
  buildSessionDuplicateIndex,
} from './data/mergeDuplicates.js';
import type { ZombieProject } from './components/constellation/ZombieProjectCard.js';
import { filterSessions, applySort, VALID_SORTS, type SortBy } from './data/search.js';
import { effectiveManifest, mergeUploads } from './data/mergeUpload.js';
import { useRescan } from './data/rescan.js';
import { parseCloudZip } from './data/zipUpload.js';
import { generateDemoUpload } from './data/demoUpload.js';
import {
  buildDuplicateClusters as buildDuplicateClustersAnalysis,
  buildZombieProjects,
  firstHumanText,
  type DuplicateInput,
} from '@chat-arch/analysis';
import {
  loadUploadedData,
  saveUploadedData,
  clearUploadedData,
} from './data/uploadedDataStore.js';
import { createEmbedClient, type EmbedClient } from './data/embedClient.js';
import { spawnCascadedEmbedClient } from './data/spawnCascadedEmbedClient.js';
import {
  classifyUploadedSessions,
  type ClassifyProgress,
  type SemanticLabel,
  type SemanticLabelsBundle,
} from './data/semanticClassify.js';
import {
  loadSemanticLabels,
  saveSemanticLabels,
  clearSemanticLabels,
} from './data/semanticLabelsStore.js';
import { useViewportTier } from './util/viewport.js';

export interface ChatArchViewerProps {
  /** Pre-loaded manifest (Astro/SSG path). If omitted, the viewer fetches from manifestUrl. */
  manifest?: SessionManifest;
  /** URL to fetch manifest from on mount. Default: "/chat-arch-data/manifest.json". */
  manifestUrl?: string;
  /** Root URL under which transcriptPath references resolve. Default: "/chat-arch-data". */
  dataRoot?: string;
}

const DEFAULT_MANIFEST_URL = '/chat-arch-data/manifest.json';
const DEFAULT_DATA_ROOT = '/chat-arch-data';
const SEARCH_DEBOUNCE_MS = 100;
const FALLBACK_BANNER_PX = 320;

const HASH_SESSION_PREFIX = '#session/';
const DEMO_BANNER_DISMISSED_KEY = 'chat-arch:demo-banner-dismissed';
const BOOT_SEEN_KEY = 'chat-arch:boot-seen';
const SORT_BY_KEY = 'chat-arch:sort-by';

/**
 * Read the stored SORT preference; fall back to `recent` when missing
 * or stale (e.g., a value written by a prior version that's no longer
 * a valid option). Guarded for SSR + private-mode storage failures.
 */
function readStoredSort(): SortBy {
  if (typeof window === 'undefined') return 'recent';
  try {
    const v = window.localStorage.getItem(SORT_BY_KEY);
    if (v && (VALID_SORTS as readonly string[]).includes(v)) return v as SortBy;
  } catch {
    // localStorage unavailable (private mode, policy-locked). Default.
  }
  return 'recent';
}
const BOOT_DURATION_MS = 1500;
function readSessionHash(): string | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash;
  if (!h.startsWith(HASH_SESSION_PREFIX)) return null;
  const id = decodeURIComponent(h.slice(HASH_SESSION_PREFIX.length));
  return id.length > 0 ? id : null;
}

/**
 * Read the `?empty=1` URL param on mount (Q6 AFFIRM). Supports both
 * `?empty=1` and bare `?empty`; anything else = hide.
 */
function readEmptyParam(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('empty')) return false;
  const v = params.get('empty');
  return v === null || v === '' || v === '1' || v === 'true';
}

function updateEmptyParam(show: boolean): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (show) {
    url.searchParams.set('empty', '1');
  } else {
    url.searchParams.delete('empty');
  }
  // pushState keeps the back button working — the user can toggle
  // SHOW EMPTY → HIDE via browser back. Per Q6 AFFIRM.
  window.history.pushState(null, '', url.toString());
}

/** Shallow fetch-json-or-null used for tier-1 analysis files. */
async function fetchJsonOrNull(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export function ChatArchViewer({
  manifest: manifestProp,
  manifestUrl = DEFAULT_MANIFEST_URL,
  dataRoot = DEFAULT_DATA_ROOT,
}: ChatArchViewerProps) {
  // --- manifest ---
  const [manifestState, setManifestState] = useState<FetchState<SessionManifest>>(
    manifestProp ? { status: 'ready', data: manifestProp } : { status: 'idle' },
  );
  const [uploadedData, setUploadedData] = useState<UploadedCloudData | null>(null);
  // Hydration gate for the IndexedDB-persisted uploaded archive. The save
  // effect below skips writes until the load effect has settled — otherwise
  // the initial `null` state would clobber stored data on every mount.
  const [uploadedHydrated, setUploadedHydrated] = useState(false);

  // --- UI state ---
  const [mode, setMode] = useState<Mode>('command');
  const [selectedId, setSelectedId] = useState<string | null>(() => readSessionHash());
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<FilterState>(new Set<SessionSource>());
  const [projectFilter, setProjectFilter] = useState<ReadonlySet<string>>(new Set());
  const [unknownProjectActive, setUnknownProjectActive] = useState(false);
  const [showEmpty, setShowEmpty] = useState<boolean>(() => readEmptyParam());
  // Redesign Phase 6a: user-selected SORT axis for the Command grid.
  // Persisted across reloads so returning users see the grid in the
  // arrangement they left it.
  const [sortBy, setSortBy] = useState<SortBy>(() => readStoredSort());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SORT_BY_KEY, sortBy);
    } catch {
      // localStorage unavailable — preference lasts only this session.
    }
  }, [sortBy]);
  const [cache, setCache] = useState<ConversationCache>(new Map());

  // --- analysis state (Phase 6) ---
  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    duplicatesExact: null,
    zombiesHeuristic: null,
    tierStatus: 'browser',
    tierPresentCount: 0,
    tierFiles: {},
  });

  // --- Phase 3 semantic-classification state ---
  //
  // Sidecar enrichment layer: BGE-small-en-v1.5 embeddings + cosine-
  // similarity matching against the user's claude.ai projects.json. Fills in
  // `session.project` for cloud conversations the string matcher couldn't
  // cover. Distinct from the exporter's analysis sidecars (`duplicates.*`,
  // `zombies.*`) because this runs entirely in-browser via a Web Worker
  // and doesn't round-trip through disk.
  const [semanticLabels, setSemanticLabels] = useState<SemanticLabelsBundle | null>(null);
  const [semanticStatus, setSemanticStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [semanticProgress, setSemanticProgress] = useState<ClassifyProgress | null>(null);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  // The embed client is heavy (30 MB model + WebGPU context). Keep one
  // live instance in a ref across re-runs so subsequent threshold tweaks
  // reuse the loaded pipeline instead of paying the download again.
  const embedClientRef = useRef<EmbedClient | null>(null);

  // --- Activity log ---
  //
  // Session-scoped, in-memory ring buffer of user-visible actions +
  // process milestones. Surfaces what the system is doing without
  // forcing the user to open DevTools. Closed by default — the user
  // opens it on demand via the LOG chip in the TopBar. Entries still
  // accumulate in the background so the log is populated whenever the
  // user decides to look.
  const { entries: logEntries, log, clear: clearLog } = useActivityLog();
  const [activityLogOpen, setActivityLogOpen] = useState<boolean>(false);
  // Log mount once — gives the user a "system online" anchor so an
  // empty log during early interactions doesn't look broken. The ref
  // guard prevents StrictMode's intentional double-invoke from
  // double-logging.
  const systemReadyLoggedRef = useRef<boolean>(false);
  useEffect(() => {
    if (systemReadyLoggedRef.current) return;
    systemReadyLoggedRef.current = true;
    log('info', 'system', 'Chat Archaeologist viewer ready.');
  }, [log]);

  // COST mode KPI-entry state. Set by onKpiClick; CostMode reads it to
  // drive the 2s highlight ring. Cleared when the user leaves COST
  // (direct-nav + re-enter shows no highlight per `[R-D19]`).
  const [costKpiEntry, setCostKpiEntry] = useState<CostKpiSection | null>(null);
  const [costToolFilter, setCostToolFilter] = useState<string | undefined>(undefined);

  // CONSTELLATION navigation state — set by SessionCard chip clicks.
  const [constellationHighlightClusterId, setConstellationHighlightClusterId] = useState<
    string | null
  >(null);
  // AC20: the originating session's id, so the cluster card can mark
  // which of its member <li>s was the one the user came from.
  const [constellationOriginSessionId, setConstellationOriginSessionId] = useState<string | null>(
    null,
  );
  const [zombieFilterActive, setZombieFilterActive] = useState(false);

  const listScrollY = useRef(0);
  const tier = useViewportTier();
  // `/api/rescan` is only present when the Astro dev server is
  // running (per-route SSR; see `apps/standalone/src/pages/api/rescan.ts`).
  // The hook probes on mount; `available === false` hides the button
  // without error noise.
  const rescanCtl = useRescan();
  const [rescanToast, setRescanToast] = useState<string | null>(null);
  // Cloud-upload progress state for the top-bar Upload Cloud button.
  // Unlike rescan (which has a streaming endpoint), upload parsing is
  // synchronous in the browser — usually milliseconds — so we just
  // track idle/running/ok/error without per-phase progress.
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'running' | 'error' | 'ok'>('idle');
  const [uploadHint, setUploadHint] = useState<string | undefined>(undefined);
  // Persistent banner shown below the top bar. Unlike the hover
  // tooltip, the banner is visible immediately without the user
  // having to discover it. Errors stay until dismissed; successes
  // auto-dismiss after a few seconds.
  const [rescanBanner, setRescanBanner] = useState<{
    kind: 'ok' | 'error';
    message: string;
  } | null>(null);
  // Demo-mode detection: the standalone's `pnpm dev` seed-script writes a
  // sibling `.demo` file alongside the demo manifest. Real exporter output
  // never writes this file, so its presence reliably means "what's loaded
  // is fictional fixture data". The banner is visible the first time per
  // browser and stays dismissed across reloads (localStorage).
  const [demoMode, setDemoMode] = useState<boolean>(false);
  const [demoBannerDismissed, setDemoBannerDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(DEMO_BANNER_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  // "TNG-computer coming online" boot animation. Fires once per browser
  // on the first user-initiated data arrival (rescan success with local
  // sessions, or cloud upload success). Skipped for returning users,
  // skipped on demo data, skipped if prefers-reduced-motion.
  const [booting, setBooting] = useState<boolean>(false);
  const bootTimerRef = useRef<number | null>(null);
  const triggerBoot = () => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(BOOT_SEEN_KEY) === '1') return;
    } catch {
      return;
    }
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reducedMotion) {
      try {
        window.localStorage.setItem(BOOT_SEEN_KEY, '1');
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      window.localStorage.setItem(BOOT_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    setBooting(true);
    if (bootTimerRef.current !== null) window.clearTimeout(bootTimerRef.current);
    bootTimerRef.current = window.setTimeout(() => setBooting(false), BOOT_DURATION_MS);
  };
  const [belowFallback, setBelowFallback] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < FALLBACK_BANNER_PX;
  });

  // --- debounce search input ---
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setDebouncedQuery(rawQuery), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [rawQuery]);

  // --- < 320px fallback gate ---
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setBelowFallback(window.innerWidth < FALLBACK_BANNER_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // --- strip the NuclearReset cache-bust param from the URL ---
  //
  // NuclearReset appends `?_reset=<timestamp>` to the page URL and
  // navigates so the browser treats the reload as uncached. After the
  // reload completes the param has served its purpose — leaving it in
  // the address bar is visual noise and confuses users who think
  // they're on some non-canonical page. We also drop the companion
  // `empty=1` param when it's at default so `updateEmptyParam` stays
  // consistent with what we're showing.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has('_reset')) {
      url.searchParams.delete('_reset');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }, []);

  // --- demo-mode probe ---
  // HEAD `${dataRoot}/.demo` once on mount. Present (any 2xx) → banner on.
  // Absent / network failure / non-2xx → silent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${dataRoot}/.demo`, { method: 'HEAD' });
        if (!cancelled && res.ok) setDemoMode(true);
      } catch {
        // silent — no .demo file means real (or no) data
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataRoot]);

  // --- hash routing for drill-in ---
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => {
      const id = readSessionHash();
      setSelectedId(id);
      if (id) {
        setMode('detail');
      } else {
        setMode((prev) => (prev === 'detail' ? 'command' : prev));
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // --- Esc closes detail ---
  const isInDetail = selectedId !== null;
  useEffect(() => {
    if (typeof window === 'undefined' || !isInDetail) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (window.history.length > 1) window.history.back();
        else window.location.hash = '';
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isInDetail]);

  // --- restore scroll position after closing detail ---
  useEffect(() => {
    if (typeof window === 'undefined' || isInDetail) return;
    const y = listScrollY.current;
    if (y <= 0) return;
    const id = window.requestAnimationFrame(() => window.scrollTo(0, y));
    return () => window.cancelAnimationFrame(id);
  }, [isInDetail]);

  // --- fetch manifest ---
  useEffect(() => {
    if (manifestProp) {
      // SSG/server-rendered consumers pass the manifest as a prop; log
      // once so the activity log shows the user where their data came from.
      const m = manifestProp;
      const total = m.sessions.length;
      const counts = m.counts;
      log(
        'info',
        'manifest',
        `Using pre-loaded manifest (prop): ${total} sessions ` +
          `(cloud ${counts.cloud ?? 0} · cowork ${counts.cowork ?? 0} · ` +
          `cli-direct ${counts['cli-direct'] ?? 0} · cli-desktop ${counts['cli-desktop'] ?? 0}).`,
      );
      return;
    }
    let cancelled = false;
    setManifestState({ status: 'loading' });
    log('info', 'manifest', `Fetching manifest from ${manifestUrl}…`);
    const startedAt = Date.now();
    fetchManifest(manifestUrl)
      .then((m) => {
        if (cancelled) return;
        setManifestState({ status: 'ready', data: m });
        const total = m.sessions.length;
        const counts = m.counts;
        // Range summary gives the user at-a-glance insight into which
        // slice of their history landed on this page — useful when
        // they later wonder "why is the sparkline only showing Feb
        // onward?" the answer is right there in the log.
        let rangeLabel = 'no sessions';
        if (total > 0) {
          let min = m.sessions[0]!.updatedAt;
          let max = min;
          for (const s of m.sessions) {
            if (s.updatedAt < min) min = s.updatedAt;
            if (s.updatedAt > max) max = s.updatedAt;
          }
          rangeLabel =
            `${new Date(min).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} → ` +
            `${new Date(max).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        const elapsedMs = Date.now() - startedAt;
        log(
          'info',
          'manifest',
          `Loaded ${total.toLocaleString()} sessions in ${elapsedMs}ms ` +
            `(cloud ${counts.cloud ?? 0} · cowork ${counts.cowork ?? 0} · ` +
            `cli-direct ${counts['cli-direct'] ?? 0} · cli-desktop ${counts['cli-desktop'] ?? 0}) · ` +
            `range: ${rangeLabel}`,
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setManifestState({ status: 'error', message });
          log(
            'warn',
            'manifest',
            `No manifest at ${manifestUrl} (${message}). Empty state will show ` +
              `upload + demo affordances.`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [manifestUrl, manifestProp, log]);

  /**
   * Demo data isn't a user asset — it's a bundled fixture meant to be
   * regenerated on each load. Persisting it to IDB would pin whichever
   * version of the fixture shipped at the time of first-click (title
   * copy, preview copy, sourceLabel, etc.) across subsequent code
   * updates, producing stale demo UI until the user manually unloads.
   * The sourceLabel prefix is a stable marker — we write it ourselves
   * in generateDemoUpload — so it's safe to sniff for.
   */
  const isDemoUpload = (data: UploadedCloudData | null): boolean =>
    !!data && data.sourceLabel.startsWith('DEMO DATA');

  // --- rehydrate uploaded ZIP from IndexedDB ---
  // The uploaded archive lives in `chat-arch` → `uploaded-cloud-data` (IDB).
  // Loading it on mount is what makes browser-only deploys able to "save"
  // user uploads across refreshes. Failures (no IDB, corrupt entry, quota
  // wipe) collapse to `null` — same as a fresh visit. Demo fixtures are
  // skipped on rehydrate (and wiped from IDB) so the user never sees a
  // stale fixture after a code update.
  useEffect(() => {
    let cancelled = false;
    loadUploadedData()
      .then((data) => {
        if (cancelled) return;
        if (data && isDemoUpload(data)) {
          // Stale demo fixture from a prior session — discard and wipe.
          void clearUploadedData();
          log(
            'info',
            'upload',
            'Discarded stale demo fixture from IndexedDB. Demos regenerate from source on each load.',
          );
        } else if (data) {
          setUploadedData(data);
          log(
            'info',
            'upload',
            `Rehydrated uploaded ZIP from IndexedDB: ${data.manifest.sessions.length.toLocaleString()} ` +
              `cloud ${data.manifest.sessions.length === 1 ? 'conversation' : 'conversations'} ` +
              `(${data.sourceLabel}).`,
          );
        } else {
          log('debug', 'upload', 'No persisted upload in IndexedDB.');
        }
        setUploadedHydrated(true);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log('warn', 'upload', `IndexedDB rehydrate failed: ${msg}. Continuing with no upload.`);
        if (!cancelled) setUploadedHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [log]);

  // --- persist uploaded ZIP changes to IndexedDB ---
  // Mirrors React state into IDB on every change after hydration: a fresh
  // upload writes the merged archive, an unload writes a delete. Writes are
  // fire-and-forget — `saveUploadedData` swallows quota/private-mode errors
  // so the in-session experience never breaks on a storage failure.
  //
  // Demo fixtures are intentionally NOT persisted — the fixture regenerates
  // itself fresh each time the user clicks LOAD DEMO DATA, and persisting
  // the stringified copy would pin whichever version shipped at first click.
  //
  // Stale-tab guard (`hadUploadRef`): the post-hydration null+true effect
  // fire would otherwise call `clearUploadedData()` even on a tab that
  // never had a user upload. In a multi-tab scenario where tab A uploads
  // shortly before tab B finishes hydrating, that spurious clear could race
  // and wipe tab A's archive. We only emit a clear when this tab has
  // observed a non-null upload at least once — i.e. when there is something
  // of *ours* to wipe.
  const hadUploadRef = useRef(false);
  useEffect(() => {
    if (!uploadedHydrated) return;
    if (uploadedData) {
      hadUploadRef.current = true;
      if (!isDemoUpload(uploadedData)) {
        void saveUploadedData(uploadedData);
      }
    } else if (hadUploadRef.current) {
      void clearUploadedData();
    }
  }, [uploadedData, uploadedHydrated]);

  // --- fetch analysis files in parallel ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [tier2, dupExact, zombies] = await Promise.all([
        fetchAnalysisTierStatus(dataRoot),
        fetchJsonOrNull(
          `${dataRoot.endsWith('/') ? dataRoot.slice(0, -1) : dataRoot}/analysis/duplicates.exact.json`,
        ),
        fetchJsonOrNull(
          `${dataRoot.endsWith('/') ? dataRoot.slice(0, -1) : dataRoot}/analysis/zombies.heuristic.json`,
        ),
      ]);
      if (cancelled) return;
      setAnalysisState({
        duplicatesExact: dupExact,
        zombiesHeuristic: zombies,
        tierStatus: tier2.tierStatus,
        tierPresentCount: tier2.tierPresentCount,
        tierFiles: tier2.tierFiles,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [dataRoot]);

  // --- rehydrate persisted semantic labels ---
  //
  // Logs the rehydration outcome to the activity log so a user who
  // refreshes can confirm at a glance that their previous analysis
  // survived (or didn't). Without this, an empty pill row after refresh
  // is ambiguous — load failed? schema-mismatch threw the bundle out?
  // labels were never saved? — and the only way to find out is to open
  // DevTools → Application → IndexedDB. The log entry collapses that
  // diagnostic to a single visible line: success says "Rehydrated N
  // labels from <date>"; absence means "no prior analysis to restore"
  // and the user knows they need to click ANALYZE TOPICS again.
  useEffect(() => {
    let cancelled = false;
    loadSemanticLabels()
      .then((bundle) => {
        if (cancelled) return;
        if (bundle) {
          setSemanticLabels(bundle);
          const ts = new Date(bundle.generatedAt).toLocaleString();
          log(
            'info',
            'classify',
            `Rehydrated ${bundle.labels.size} semantic labels from ${ts} (${bundle.device.toUpperCase()}).`,
          );
        } else {
          log('debug', 'classify', 'No persisted semantic labels to restore.');
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(
          'warn',
          'classify',
          `Failed to load persisted semantic labels: ${msg}. Will need to re-run ANALYZE TOPICS.`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [log]);

  // --- kick off semantic classification ---
  //
  // Exposed as a ref so onCloudUpload / manual "analyze" clicks can call
  // it without threading the entire viewer state through. The worker is
  // expensive to spin up (~30 MB model download on first call), so we
  // reuse the same client across subsequent analyses by caching it on
  // `embedClientRef`.
  const runSemanticAnalysis = async (upload: UploadedCloudData): Promise<void> => {
    // No projects.json? Fall through to the discovery path — the
    // pipeline handles both modes. Only *fully* fail when the upload
    // has no cloud sessions at all, which would be a degenerate case
    // worth surfacing.
    //
    // Concurrent-invocation guard: if a run is already in flight (e.g.
    // user double-clicks the chip, or an auto-analyze fires while a
    // manual one is still going), return silently. Letting two runs
    // race would give us two flush intervals fighting over
    // `setSemanticLabels` with no guarantee of which commits last, and
    // two `onLabel` streams mutating independent maps. The chip
    // suppresses its own click handler on `status === 'running'` too,
    // so this is belt-and-braces for programmatic callers.
    if (semanticStatus === 'running') return;
    // Auto-open the activity log on analysis start. The log is the
    // only place the user can watch phase transitions, per-session
    // classifications, and emergent-cluster discoveries as they
    // happen — kicking it open here mirrors the user's intent when
    // they click ANALYZE TOPICS (they want to see what's happening).
    // If they later close the log mid-run, we respect that and don't
    // reopen; this auto-open fires once per analysis start, not once
    // per progress event.
    setActivityLogOpen(true);
    setSemanticStatus('running');
    setSemanticError(null);
    const cloudCount = upload.manifest.sessions.filter((s) => s.source === 'cloud').length;
    log('info', 'classify', `Semantic analysis started over ${cloudCount} cloud conversations.`);

    // Milestone trackers. `lastDownloadQuartile` is quartered (25%
    // steps) since the download is shorter. `lastEmbedStep` uses 5%
    // steps because embedding is the long phase AND the first batch
    // hits WASM graph compilation (~30-60s cold start), so 10% steps
    // could mean 90+ seconds of log silence for large corpora —
    // users read that as frozen. 5% puts a milestone every ~5% of
    // wall-clock after warmup, ~9s apart on a typical 3min run.
    // Both track -1 "never reached" initially so 0% isn't treated as
    // a crossed milestone.
    //
    // Transformers.js downloads several files during this phase (the
    // tokenizer, tokenizer_config, special_tokens_map, onnx weights,
    // sometimes a quant-config), each with its own 0→total progress
    // stream. Without resetting the quartile tracker when the file
    // changes, tiny files that finish fast push `lastDownloadQuartile`
    // to 4 and the subsequent 30 MB weights download is silently
    // skipped. `lastDownloadTotal` detects transitions by total bytes
    // (every file has a distinct size), resetting the quartile tracker.
    //
    // We also skip logging files smaller than `DOWNLOAD_LOG_MIN_BYTES`
    // — tokenizer/config are <200 KB each and format as "0.0 / 0.0 MB"
    // at decimal precision, which is noise, not progress. The user
    // cares about the 30 MB weights download; everything else finishes
    // instantly and isn't worth reporting.
    let lastDownloadQuartile = -1;
    let lastDownloadTotal = 0;
    const DOWNLOAD_LOG_MIN_BYTES = 1_000_000;
    let lastEmbedStep = -1;
    let firstEmbedBatchLogged = false;

    try {
      // Factory so we can rebuild the client with a different device
      // preference after a failed attempt (transformers.js caches its
      // first failed createInferenceSession and can't retry within the
      // same worker — the only recovery is respawning).
      //
      // `forceWebgpuDtype` overrides the worker's auto-pick from
      // shader-f16 availability. Used by the cascade below to walk
      // q4f16 → fp16 → fp32 in order of decreasing speed / increasing
      // compatibility — see the docblock on `forceWebgpuDtype` in
      // `embedClient.ts` for the full per-dtype cost breakdown.
      const spawnClient = (
        prefer?: 'webgpu' | 'wasm',
        forceWebgpuDtype?: 'q4f16' | 'fp16' | 'fp32',
        reason?: string,
      ): EmbedClient => {
        // Log copy deliberately avoids "forced" — the word reads as
        // if we're overriding a user choice. We're really walking a
        // fallback cascade (q4f16 → fp16 → fp32 → WASM, fastest
        // first) and sometimes skipping rungs we already know don't
        // work on this device. The `reason` suffix makes the *why*
        // explicit for users reading the activity log.
        const variant =
          prefer === undefined
            ? 'auto-picking best available device'
            : prefer === 'webgpu'
              ? `trying WEBGPU${forceWebgpuDtype ? ` with ${forceWebgpuDtype}` : ''}`
              : `trying ${prefer.toUpperCase()}`;
        const suffix = reason ? ` — ${reason}` : '';
        log('debug', 'worker', `Spawning embed worker — ${variant}${suffix}…`);
        return createEmbedClient({
          ...(prefer ? { preferDevice: prefer } : {}),
          ...(forceWebgpuDtype ? { forceWebgpuDtype } : {}),
          onProgress: (p) => {
            if (p.stage === 'download') {
              const fraction = p.total > 0 ? p.loaded / p.total : null;
              setSemanticProgress({ phase: 'downloading model', fraction });
              if (fraction !== null && p.total >= DOWNLOAD_LOG_MIN_BYTES) {
                if (p.total !== lastDownloadTotal) {
                  lastDownloadTotal = p.total;
                  lastDownloadQuartile = -1;
                }
                const quartile = Math.floor(fraction * 4);
                if (quartile > lastDownloadQuartile && quartile > 0 && quartile <= 4) {
                  lastDownloadQuartile = quartile;
                  const mb = (p.loaded / (1024 * 1024)).toFixed(1);
                  const totalMb = (p.total / (1024 * 1024)).toFixed(1);
                  log('debug', 'worker', `Model download ${quartile * 25}% (${mb} / ${totalMb} MB).`);
                }
              }
            }
          },
        });
      };

      // Walk the device/dtype cascade. The helper owns the ladder shape
      // (q4f16 → fp16 → fp32 → wasm) and the localStorage memo of last-
      // known-good (device, dtype). Production passes the `spawnClient`
      // factory above (which carries our onProgress wiring) plus
      // `readDevicePref/saveDevicePref: true` so we honor and update
      // the memo — skipping wasted q4f16 attempts on hw where the user
      // already settled on fp32 or WASM in a prior run.
      const cascadeResult = await spawnCascadedEmbedClient({
        spawnClient,
        onLog: log,
        existingClient: embedClientRef.current,
        readDevicePref: true,
        saveDevicePref: true,
      });
      embedClientRef.current = cascadeResult.client;
      const resolved = { device: cascadeResult.device, dtype: cascadeResult.dtype };
      const resolvedDevice: 'webgpu' | 'wasm' = resolved.device;

      // Streaming label buffer — filled during embed via onLabel, then
      // flushed into React state on a short interval so we re-render
      // at ~4 fps during classification instead of once per session
      // (a 1041-session run could otherwise trigger >600 renders when
      // labels cross τ).
      const liveLabels = new Map<string, SemanticLabel>();
      let dirty = false;
      let done = false; // set true right before final setSemanticLabels
      const flush = (): void => {
        // Two guards. `done` prevents a late-firing interval tick from
        // overwriting the authoritative final bundle with a stale
        // snapshot (a real race: setInterval fires, the tick's
        // setState is queued, the Promise resolves and `done = true`
        // + final setState + clearInterval run, but the prior tick's
        // setState hasn't landed yet; React coalesces both updates
        // and without this check the older snapshot could win).
        // `dirty` skips redundant renders when no labels crossed τ
        // this tick.
        if (done || !dirty) return;
        dirty = false;
        const snapshot = new Map(liveLabels);
        setSemanticLabels({
          version: 3,
          modelId: 'Xenova/bge-small-en-v1.5',
          mode: 'classify',
          options: { threshold: 0.38, margin: 0.02 },
          generatedAt: Date.now(),
          labels: snapshot,
          device: resolvedDevice,
        });
      };
      const flushHandle = window.setInterval(flush, 250);

      try {
        // Track phase transitions so we can log on change (not on
        // every 250ms tick). Also tally classify / emergent labels
        // separately from the onLabel stream for the end-of-run
        // summary in the log.
        let lastPhase: ClassifyProgress['phase'] | null = null;
        let classifyCount = 0;
        let emergentCount = 0;
        const bundle = await classifyUploadedSessions(upload, embedClientRef.current, {
          onProgress: (p) => {
            setSemanticProgress(p);
            if (p.phase !== lastPhase) {
              lastPhase = p.phase;
              log('info', 'classify', `Phase → ${p.phase}.`);
              // Reset embed trackers on phase transition — stale
              // state would suppress milestones on a future run or a
              // re-entry to the embed phase.
              if (p.phase !== 'embedding sessions') {
                lastEmbedStep = -1;
                firstEmbedBatchLogged = false;
              }
            }
            // During the (slow) embedding-sessions phase, log:
            //   (a) once on the first batch completion — signals "the
            //       cold-start WASM graph compilation finished, batches
            //       are running". Without this, the 30-60s warmup
            //       looks identical to a hang because the first
            //       milestone can't fire until 5% of work is done.
            //   (b) every 5% of corpus-wide progress, with live counts
            //       of classify vs emergent labels so users see the
            //       hybrid pipeline working.
            if (p.phase === 'embedding sessions' && p.fraction !== null) {
              if (!firstEmbedBatchLogged && p.fraction > 0) {
                firstEmbedBatchLogged = true;
                log('debug', 'worker', 'First batch embedded — pipeline warm.');
              }
              const step = Math.floor(p.fraction * 20); // 5% steps
              if (step > lastEmbedStep && step > 0 && step <= 20) {
                lastEmbedStep = step;
                log(
                  'debug',
                  'worker',
                  `Embedding ${step * 5}% — ${classifyCount} named · ${emergentCount} emergent streamed so far.`,
                );
              }
            }
          },
          onLabel: (sessionId, label) => {
            liveLabels.set(sessionId, label);
            dirty = true;
            // Sort labels into "named project" vs "emergent ~topic"
            // buckets so the summary message at run-end is honest
            // about which side of the hybrid produced how many.
            if (label.projectId === null) return;
            if (label.projectId.startsWith('~')) emergentCount += 1;
            else classifyCount += 1;
          },
          onCluster: (label, memberCount) => {
            // One line per discovered emergent cluster. Counts the
            // full cluster size, not the post-classify-wins filter —
            // so a cluster of 17 where 2 members already had named
            // labels still reads as "17 sessions" (those 2 keep
            // their named labels, 15 get the emergent one).
            log('info', 'discover', `Discovered ${label} (${memberCount} sessions).`);
          },
        });
        // Commit-order barrier. Set `done` first so any racing timer
        // tick returns early; clear the interval so no *future* tick
        // fires; *then* commit the final bundle. The bundle is
        // authoritative and has real metadata.
        done = true;
        window.clearInterval(flushHandle);
        setSemanticLabels(bundle);
        setSemanticStatus('idle');
        setSemanticProgress(null);
        // Surface IDB persistence as a log line either way. Previously
        // `void saveSemanticLabels(bundle)` swallowed the promise so a
        // failed save was invisible to the user — they'd refresh and
        // be surprised when nothing rehydrated. With explicit
        // success/failure logging the user can confirm at a glance
        // whether the write landed, and pair it with the rehydrate
        // log on the NEXT mount to triage save-vs-load issues.
        saveSemanticLabels(bundle)
          .then(() =>
            log(
              'info',
              'classify',
              `Persisted ${bundle.labels.size} labels to IndexedDB (chat-arch-semantic-labels / semantic-labels / active).`,
            ),
          )
          .catch((saveErr: unknown) => {
            const msg = saveErr instanceof Error ? saveErr.message : String(saveErr);
            log(
              'error',
              'classify',
              `Failed to persist labels to IndexedDB: ${msg}. Refreshing the page will lose this analysis.`,
            );
          });
        const abstained = bundle.labels.size - classifyCount - emergentCount;
        log(
          'info',
          'classify',
          `Analysis complete: ${classifyCount} named, ${emergentCount} emergent, ${abstained} unlabeled (of ${bundle.labels.size} embedded).`,
        );
      } catch (innerErr) {
        // Streaming labels emitted before the error are discarded —
        // if the embed rejected, those labels may be incomplete or
        // wrong (classification ran against a partial chunk set for
        // sessions whose ranges happened to be fully covered at the
        // moment of failure). Better to show nothing than misleading
        // labels next to an error banner.
        done = true;
        window.clearInterval(flushHandle);
        setSemanticLabels(null);
        throw innerErr;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSemanticError(msg);
      setSemanticStatus('error');
      setSemanticProgress(null);
      log('error', 'classify', `Semantic analysis failed: ${msg}`);
    }
  };

  // --- tear down the embed client on unmount ---
  useEffect(() => {
    return () => {
      if (embedClientRef.current) {
        embedClientRef.current.dispose();
        embedClientRef.current = null;
      }
    };
  }, []);

  // --- derived: active manifest ---
  //
  // Uploaded cloud entries merge on top of the fetched manifest (dedup by
  // id, uploaded cloud wins); non-cloud fetched entries (cli/cowork) pass
  // through so local history isn't lost when a ZIP is uploaded. See
  // `data/mergeUpload.ts` for the rules.
  //
  // Semantic-label enrichment: when Phase 3 has produced labels for the
  // current upload, splice them into the entries that don't already carry
  // a `project` (string-match or CLI-derived labels always win). This
  // keeps the filter-pill / zombie / card-display code unchanged —
  // semantic labels flow through the same `session.project` slot.
  const fetchedManifest = manifestState.status === 'ready' ? manifestState.data : null;
  const manifest: SessionManifest | null = useMemo(() => {
    const base = effectiveManifest(fetchedManifest, uploadedData);
    if (!base || !semanticLabels || semanticLabels.labels.size === 0) return base;
    const enriched = {
      ...base,
      sessions: base.sessions.map((s) => {
        if (s.project !== undefined && s.project !== null && s.project !== '') return s;
        const label = semanticLabels.labels.get(s.id);
        if (!label || label.projectId === null) return s;
        return { ...s, project: label.projectId };
      }),
    };
    return enriched;
  }, [fetchedManifest, uploadedData, semanticLabels]);

  // Log a summary whenever the merge composition materially changes —
  // when the user adds/removes an upload, when a rescan brings in fresh
  // local data, or when both are combined. Gives the activity log a
  // running narrative of "what the viewer is looking at" that's
  // invaluable when the range/sparkline seems to disagree with the
  // grid — the user can scroll the log and see the exact merge shape.
  const lastMergeKeyRef = useRef<string>('');
  useEffect(() => {
    if (!manifest) return;
    if (!uploadedHydrated) return; // wait until IDB settle so we don't log the pre-rehydrate state
    const counts = manifest.counts;
    const total = manifest.sessions.length;
    const key = `${total}:${counts.cloud ?? 0}:${counts.cowork ?? 0}:${counts['cli-direct'] ?? 0}:${counts['cli-desktop'] ?? 0}`;
    if (lastMergeKeyRef.current === key) return;
    lastMergeKeyRef.current = key;
    let rangeLabel = 'no sessions';
    if (total > 0) {
      let min = manifest.sessions[0]!.updatedAt;
      let max = min;
      for (const s of manifest.sessions) {
        if (s.updatedAt < min) min = s.updatedAt;
        if (s.updatedAt > max) max = s.updatedAt;
      }
      rangeLabel =
        `${new Date(min).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} → ` +
        `${new Date(max).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    const sourcePresent = [
      (counts.cloud ?? 0) > 0 ? `cloud ${counts.cloud}` : null,
      (counts.cowork ?? 0) > 0 ? `cowork ${counts.cowork}` : null,
      (counts['cli-direct'] ?? 0) > 0 ? `cli-direct ${counts['cli-direct']}` : null,
      (counts['cli-desktop'] ?? 0) > 0 ? `cli-desktop ${counts['cli-desktop']}` : null,
    ]
      .filter((s) => s !== null)
      .join(' · ');
    log(
      'info',
      'manifest',
      `Active view: ${total.toLocaleString()} sessions (${sourcePresent || 'none'}) · range ${rangeLabel}`,
    );
  }, [manifest, uploadedHydrated, log]);

  // Sessions whose project came from the semantic classifier (vs string
  // match / CLI data). Only includes ids where the semantic label was
  // *actually used* — a session that already had a project from the
  // string matcher keeps that label, and this set reflects that choice.
  // Consumed by the SessionCard render path so inferred labels show with
  // a visual hint rather than claiming string-match ground-truth status.
  const semanticSessionIds = useMemo<ReadonlySet<string>>(() => {
    if (!semanticLabels || semanticLabels.labels.size === 0) return new Set<string>();
    const base = effectiveManifest(fetchedManifest, uploadedData);
    if (!base) return new Set<string>();
    const out = new Set<string>();
    for (const s of base.sessions) {
      if (s.project !== undefined && s.project !== null && s.project !== '') continue;
      const label = semanticLabels.labels.get(s.id);
      if (label && label.projectId !== null) out.add(s.id);
    }
    return out;
  }, [semanticLabels, fetchedManifest, uploadedData]);

  // --- derived: merged duplicate clusters + per-session index ---
  //
  // Two input paths, first-hit wins:
  //   1. A fetched `analysis/duplicates.exact.json` (written by the Node
  //      exporter). Present when the user ran the CLI.
  //   2. In-page computation over the uploaded cloud ZIP. Used when no
  //      fetched file exists but `uploadedData` is set — lets cloud-only
  //      web-upload users see DUP chips too, not just CLI users.
  //
  // The in-page computation pulls first-human text from the in-memory
  // `conversationsById` map (no I/O, fully synchronous — SHA-256 comes
  // from `@noble/hashes`, not async `crypto.subtle`, so this slots into
  // the existing useMemo chain without reshaping state).
  const browserComputedDupFile = useMemo(() => {
    if (analysisState.duplicatesExact !== null) return null;
    if (!uploadedData) return null;
    const inputs: DuplicateInput[] = [];
    for (const [id, conv] of uploadedData.conversationsById) {
      const text = firstHumanText(conv.chat_messages) ?? null;
      inputs.push({ sessionId: id, firstHumanText: text });
    }
    const generatedAt = Date.now();
    const clusters = buildDuplicateClustersAnalysis(inputs);
    return {
      version: 1 as const,
      tier: 'browser' as const,
      generatedAt,
      clusters,
    };
  }, [analysisState.duplicatesExact, uploadedData]);

  const exactDupFile = useMemo(
    () =>
      parseDuplicatesFile(analysisState.duplicatesExact, 'browser') ?? browserComputedDupFile,
    [analysisState.duplicatesExact, browserComputedDupFile],
  );
  // Phase 6: semantic file is always absent. Wire the merge path now so
  // Phase 7 Just Works.
  const mergedClusters = useMemo(() => mergeDuplicateClusters(exactDupFile, null), [exactDupFile]);
  const sessionDupIndex = useMemo(
    () => buildSessionDuplicateIndex(mergedClusters),
    [mergedClusters],
  );

  // --- derived: zombie projects parsed into the card shape ---
  //
  // Same fetched-first / browser-fallback structure as duplicates. The
  // zombie heuristic is fully pure (no transcript reads needed — only
  // `startedAt`, `updatedAt`, `title`, `preview`), so running it in-page
  // over the effective manifest is a straight function call.
  const zombieProjects = useMemo<readonly ZombieProject[]>(() => {
    const payload = analysisState.zombiesHeuristic;
    if (payload && typeof payload === 'object') {
      const arr = (payload as Record<string, unknown>)['projects'];
      if (Array.isArray(arr)) {
        return arr.filter(
          (p): p is ZombieProject =>
            !!p &&
            typeof p === 'object' &&
            typeof (p as ZombieProject).id === 'string' &&
            typeof (p as ZombieProject).classification === 'string',
        );
      }
    }
    // No fetched file — try the browser fallback when the user has
    // uploaded data. Without this branch, a cloud-only user would see
    // zero ZOMBIE chips even though the heuristic is deterministic math
    // over already-in-memory fields.
    if (uploadedData && manifest) {
      return buildZombieProjects(manifest.sessions, Date.now());
    }
    return [];
  }, [analysisState.zombiesHeuristic, uploadedData, manifest]);

  const zombieProjectIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of zombieProjects) {
      if (p.classification === 'zombie') s.add(p.id);
    }
    return s;
  }, [zombieProjects]);

  const filteredSorted = useMemo<readonly UnifiedSessionEntry[]>(() => {
    if (!manifest) return [];
    let filtered = filterSessions(manifest.sessions, debouncedQuery, sourceFilter);
    // Zero-turn filter — hidden by default (Decision 8).
    if (!showEmpty) filtered = filtered.filter((s) => s.userTurns > 0);
    // Project filter — multi-select. Either union of selected projects
    // or a standalone UNKNOWN-only mode (no resolved project).
    if (projectFilter.size > 0 || unknownProjectActive) {
      filtered = filtered.filter((s) => {
        if (s.project && projectFilter.has(s.project)) return true;
        if (!s.project && unknownProjectActive) return true;
        return false;
      });
    }
    return applySort(filtered, sortBy);
  }, [manifest, debouncedQuery, sourceFilter, showEmpty, projectFilter, unknownProjectActive, sortBy]);

  const selectedSession = useMemo<UnifiedSessionEntry | null>(() => {
    if (!manifest || !selectedId) return null;
    return manifest.sessions.find((s) => s.id === selectedId) ?? null;
  }, [manifest, selectedId]);

  // --- prev/next ids on the filtered+sorted list (Decision 11) ---
  const { prevId, nextId } = useMemo(() => {
    if (!selectedId) return { prevId: null, nextId: null };
    const idx = filteredSorted.findIndex((s) => s.id === selectedId);
    if (idx === -1) return { prevId: null, nextId: null };
    return {
      prevId: idx > 0 ? filteredSorted[idx - 1]!.id : null,
      nextId: idx < filteredSorted.length - 1 ? filteredSorted[idx + 1]!.id : null,
    };
  }, [selectedId, filteredSorted]);

  // --- handlers ---
  const toggleSource = (src: SessionSource) => {
    setSourceFilter((prev) => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src);
      else next.add(src);
      return next;
    });
  };
  const clearFilters = () => setSourceFilter(new Set());
  const toggleProject = (id: string) => {
    setProjectFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleUnknownProject = () => setUnknownProjectActive((v) => !v);
  const toggleShowEmpty = () => {
    setShowEmpty((v) => {
      const next = !v;
      updateEmptyParam(next);
      return next;
    });
  };

  const clearHash = () => {
    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  const onUpload = (data: UploadedCloudData) => {
    clearHash();
    setSelectedId(null);
    setMode('command');
    setSourceFilter(new Set());
    setCache(new Map());
    // Merge (dedup by id, newer wins) rather than replace. Handles:
    //   - first upload: `mergeUploads(null, data) === data`
    //   - second ZIP with more conversations: adds the new ones
    //   - same ZIP re-uploaded: idempotent
    setUploadedData((prev) => mergeUploads(prev, data));
    // A new upload invalidates the persisted semantic-labels sidecar:
    // the session id space may have changed, and label vectors are
    // specific to the pre-merge upload. The UI then shows the "ANALYZE
    // TOPICS" affordance again so the user can re-run when ready.
    setSemanticLabels(null);
    setSemanticStatus('idle');
    setSemanticProgress(null);
    setSemanticError(null);
    void clearSemanticLabels();
  };

  // Top-bar Upload Cloud button handler: takes a File, parses the
  // ZIP, then reuses the same `onUpload` merge path. The legacy
  // EmptyState UploadPanel keeps owning its own flow (it still shows
  // when there's no manifest at all), so this lives alongside that
  // path — not a replacement of it.
  const onCloudUpload = async (file: File): Promise<void> => {
    setUploadStatus('running');
    setUploadHint(undefined);
    log('info', 'upload', `Uploading ${file.name} (${Math.round(file.size / 1024)} KB)…`);
    // Snapshot existing cloud-conversation ids so we can report
    // "N new conversations" instead of "N total" — on a second
    // upload the user wants to know what the merge added.
    const priorIds = new Set<string>();
    if (uploadedData) {
      for (const id of uploadedData.conversationsById.keys()) priorIds.add(id);
    }
    if (manifest) {
      for (const s of manifest.sessions) {
        if (s.source === 'cloud') priorIds.add(s.id);
      }
    }
    try {
      const data = await parseCloudZip(file);
      onUpload(data);
      if (data.manifest.sessions.length > 0) triggerBoot();
      let added = 0;
      for (const id of data.conversationsById.keys()) {
        if (!priorIds.has(id)) added += 1;
      }
      const total = data.manifest.sessions.length;
      const deltaPhrase =
        priorIds.size === 0
          ? `Loaded ${total} conversation${total === 1 ? '' : 's'}`
          : added > 0
            ? `Added ${added} new conversation${added === 1 ? '' : 's'} (${total} in ZIP, merged with ${priorIds.size} existing)`
            : `No new conversations — ${total} already in the merged set`;
      const msg = `${deltaPhrase} from ${file.name}`;
      setUploadStatus('ok');
      setUploadHint(msg);
      setRescanBanner({ kind: 'ok', message: msg });
      log('info', 'upload', msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadStatus('error');
      setUploadHint(`Upload failed: ${msg}`);
      setRescanBanner({ kind: 'error', message: `Upload failed: ${msg}` });
      log('error', 'upload', `Upload failed: ${msg}`);
    }
    window.setTimeout(() => {
      setUploadStatus('idle');
      setUploadHint(undefined);
    }, 4000);
  };
  const onUnload = () => {
    clearHash();
    setSelectedId(null);
    setMode('command');
    setSourceFilter(new Set());
    setCache(new Map());
    setUploadedData(null);
    setSemanticLabels(null);
    setSemanticStatus('idle');
    setSemanticProgress(null);
    setSemanticError(null);
    void clearSemanticLabels();
  };

  /**
   * Load the in-browser demo fixture. Routes through `onUpload` so the
   * generated data takes the same code path as a real ZIP — IDB
   * persistence, merge rules, semantic-analyzer enablement, and
   * everything downstream treats it as an uploaded archive.
   */
  const onLoadDemo = () => {
    const data = generateDemoUpload();
    onUpload(data);
    // The empty-state layout is short; the populated layout is long
    // (sparkline + filter bar + 97-card grid). When the DOM swaps the
    // browser can preserve the user's vertical scroll position, which
    // leaves them mid-page on the first render. Reset to the top
    // *after* the populated layout renders — a single rAF fires
    // before React commits the new DOM and would scroll against the
    // old empty-state layout. Double-rAF lands us on the next paint.
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        });
      });
    }
    const sessions = data.manifest.sessions;
    const total = sessions.length;
    let rangeLabel = 'no sessions';
    if (total > 0) {
      let min = sessions[0]!.updatedAt;
      let max = min;
      for (const s of sessions) {
        if (s.updatedAt < min) min = s.updatedAt;
        if (s.updatedAt > max) max = s.updatedAt;
      }
      rangeLabel =
        `${new Date(min).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} → ` +
        `${new Date(max).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    log(
      'info',
      'upload',
      `Loaded demo fixture: ${total} fake cloud ${total === 1 ? 'conversation' : 'conversations'} · range ${rangeLabel}.`,
    );
    triggerBoot();
  };

  const pushSessionHash = (id: string) => {
    if (typeof window !== 'undefined') {
      listScrollY.current = window.scrollY;
      window.history.pushState(null, '', `${HASH_SESSION_PREFIX}${encodeURIComponent(id)}`);
    }
  };

  const onSelect = (id: string) => {
    pushSessionHash(id);
    setSelectedId(id);
    setMode('detail');
  };
  const onBack = () => {
    if (typeof window !== 'undefined' && window.location.hash.startsWith(HASH_SESSION_PREFIX)) {
      window.history.back();
      return;
    }
    setSelectedId(null);
    setMode('command');
  };
  const onPrev = () => {
    if (!prevId) return;
    pushSessionHash(prevId);
    setSelectedId(prevId);
  };
  const onNext = () => {
    if (!nextId) return;
    pushSessionHash(nextId);
    setSelectedId(nextId);
  };

  // KPI click → COST mode with section highlight ring (`[R-D19]`).
  const onKpiClick = (section: CostKpiSection, toolFilter?: string) => {
    clearHash();
    setSelectedId(null);
    setCostKpiEntry(section);
    setCostToolFilter(toolFilter);
    setMode('cost');
    // Clear the highlight after 2s so direct-nav re-entry isn't decorated.
    window.setTimeout(() => setCostKpiEntry(null), 2000);
  };

  // DUP chip click → CONSTELLATION with cluster highlighted + auto-scroll
  // to the originating session row (AC20).
  const onDuplicateChipClick = (clusterId: string, sessionId: string) => {
    clearHash();
    setSelectedId(null);
    setConstellationHighlightClusterId(clusterId);
    setConstellationOriginSessionId(sessionId);
    setZombieFilterActive(false);
    setMode('constellation');
  };

  // Kick off a rescan. On success we bust the manifest cache with a
  // `?t=` query param so the viewer re-fetches the freshly-written
  // `manifest.json` (and analysis sidecars) rather than using whatever
  // snapshot is already in state.
  const onRescan = async () => {
    setRescanBanner(null);
    // Snapshot per-source counts BEFORE the refetch so we can report
    // "12 new" rather than just the total. The user asked for "new
    // entries added, not the entire full number again" — a delta
    // reads immediately as "scan was worth doing" vs "nothing changed".
    const priorCounts = manifest?.counts ?? {
      cowork: 0,
      'cli-direct': 0,
      'cli-desktop': 0,
      cloud: 0,
    };
    const priorLocal = priorCounts.cowork + priorCounts['cli-direct'] + priorCounts['cli-desktop'];
    const result = await rescanCtl.rescan();
    if (!result) return;
    if (result.ok) {
      const cacheBust = Date.now();
      setManifestState({ status: 'loading' });
      try {
        const url = manifestUrl + (manifestUrl.includes('?') ? '&' : '?') + `t=${cacheBust}`;
        const fresh = await fetchManifest(url);
        setManifestState({ status: 'ready', data: fresh });
        if (fresh.sessions.length > 0) triggerBoot();
        const newLocal =
          fresh.counts.cowork + fresh.counts['cli-direct'] + fresh.counts['cli-desktop'];
        const deltaLocal = newLocal - priorLocal;
        const elapsedS = Math.round((result.durationMs ?? 0) / 100) / 10;
        // Describe the delta in plain language. Negative is rare (a
        // session was deleted on disk) — reporting it honestly beats
        // silently showing the remaining total.
        const deltaPhrase =
          deltaLocal > 0
            ? `${deltaLocal} new local session${deltaLocal === 1 ? '' : 's'}`
            : deltaLocal < 0
              ? `${-deltaLocal} local session${deltaLocal === -1 ? '' : 's'} removed`
              : 'no new local sessions';
        const msg = `Rescan complete in ${elapsedS}s · ${deltaPhrase} (${newLocal} total local)`;
        setRescanToast(msg);
        setRescanBanner({ kind: 'ok', message: msg });
      } catch (err) {
        const msg =
          'Rescan wrote the manifest but the refetch failed: ' +
          (err instanceof Error ? err.message : String(err));
        setManifestState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        setRescanToast(msg);
        setRescanBanner({ kind: 'error', message: msg });
      }
    } else {
      // Prefer lines that mention ERROR (the exporter's structured
      // failure signal) over banner / WARN noise that precedes them.
      const fallback = result.error ?? result.stderrTail ?? 'unknown error';
      const errorLines = fallback
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /\bERROR\b/i.test(l));
      const detail =
        errorLines.length > 0
          ? errorLines.slice(0, 2).join(' · ')
          : fallback
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(-2)
              .join(' · ');
      const msg = `Rescan failed: ${detail}`;
      setRescanToast(msg);
      setRescanBanner({ kind: 'error', message: msg });
    }
    // Auto-clear the hover tooltip after a few seconds (the banner is
    // persistent for errors, see `useEffect` below for success).
    window.setTimeout(() => setRescanToast(null), 6000);
  };

  // Auto-dismiss success banners after 6s. Error banners stay until
  // the user clicks the ✕ — a failure reason shouldn't disappear
  // while the user is still reading it.
  useEffect(() => {
    if (!rescanBanner || rescanBanner.kind !== 'ok') return;
    const id = window.setTimeout(() => setRescanBanner(null), 6000);
    return () => window.clearTimeout(id);
  }, [rescanBanner]);

  // ZOMBIE chip click → CONSTELLATION filtered to zombie projects.
  const onZombieChipClick = () => {
    clearHash();
    setSelectedId(null);
    setConstellationHighlightClusterId(null);
    setConstellationOriginSessionId(null);
    setZombieFilterActive(true);
    setMode('constellation');
  };

  // --- Upper-panel ANALYSIS tab navigation handlers (redesign Phase 2) ---
  //
  // The card triplet on the ANALYSIS tab (RE-ASKED / ZOMBIES / TOPICS)
  // deep-links to the constellation mode. Duplicates land the user at
  // the merged-cluster grid; zombies land them with the zombie filter on;
  // topics land them in command mode where the emergent-topic pills are
  // the primary surface — there's no "topics mode", only the emergent
  // pill row that promotes a topic into a filter.
  const onOpenDupAnalysis = () => {
    clearHash();
    setSelectedId(null);
    setConstellationHighlightClusterId(null);
    setConstellationOriginSessionId(null);
    setZombieFilterActive(false);
    setMode('constellation');
  };
  const onOpenZombieAnalysis = () => {
    clearHash();
    setSelectedId(null);
    setConstellationHighlightClusterId(null);
    setConstellationOriginSessionId(null);
    setZombieFilterActive(true);
    setMode('constellation');
  };
  // LABELS / TOPICS card clicks land the user in command mode, where
  // the FilterBar's project-pill and emergent-topic-pill rows live.
  // To make the navigation visually unmistakable (especially when the
  // user is *already* in command mode and only the upper-panel tab
  // changes), we also pulse + scroll-into-view the relevant pill row
  // via `filterFocus`. `key` increments per click so the same focus
  // target still triggers the pulse if the user clicks repeatedly.
  const [filterFocus, setFilterFocus] = useState<{
    target: 'projects' | 'topics' | 'labels';
    key: number;
  } | null>(null);
  const focusFilterRow = (target: 'projects' | 'topics' | 'labels') => {
    setFilterFocus((prev) => ({ target, key: (prev?.key ?? 0) + 1 }));
  };
  const onOpenTopicAnalysis = () => {
    clearHash();
    setSelectedId(null);
    setMode('command');
    focusFilterRow('topics');
  };
  const onOpenLabelsAnalysis = () => {
    clearHash();
    setSelectedId(null);
    setMode('command');
    // LABELS pulses BOTH rows because labels populate both: classified
    // sessions land in the PROJECTS row, emergent memberships land in
    // the TOPICS row. Flashing only one row understates the scope.
    focusFilterRow('labels');
  };

  // --- analysis counts for the ANALYSIS summary tab ---
  //
  // Walks the semantic labels once and splits into three tallies:
  //   - emergent topics:   distinct `~`-prefixed projectIds
  //   - classified sessions: count of sessions assigned to a known
  //                          (non-emergent, non-null) projectId
  //   - classified projects: distinct set of those known projectIds
  // Falls back to 0 when analysis hasn't run.
  const semanticTallies = useMemo(() => {
    if (!semanticLabels || semanticLabels.labels.size === 0) {
      return {
        emergentTopicCount: 0,
        labeledSessionCount: 0,
        classifiedSessionCount: 0,
        classifiedProjectCount: 0,
      };
    }
    const emergentTopics = new Set<string>();
    const classifiedProjects = new Set<string>();
    let classifiedSessions = 0;
    let emergentSessions = 0;
    for (const label of semanticLabels.labels.values()) {
      if (!label.projectId) continue;
      if (label.projectId.startsWith('~')) {
        emergentTopics.add(label.projectId);
        emergentSessions += 1;
      } else {
        classifiedSessions += 1;
        classifiedProjects.add(label.projectId);
      }
    }
    return {
      emergentTopicCount: emergentTopics.size,
      // Total labeled = both branches. Matches the launcher's
      // "N labeled" headline so the LABELS card reads consistently.
      labeledSessionCount: classifiedSessions + emergentSessions,
      classifiedSessionCount: classifiedSessions,
      classifiedProjectCount: classifiedProjects.size,
    };
  }, [semanticLabels]);
  const analysisCounts = useMemo(
    () => ({
      dupClusterCount: mergedClusters.length,
      zombieProjectCount: zombieProjectIds.size,
      emergentTopicCount: semanticTallies.emergentTopicCount,
      labeledSessionCount: semanticTallies.labeledSessionCount,
      classifiedSessionCount: semanticTallies.classifiedSessionCount,
      classifiedProjectCount: semanticTallies.classifiedProjectCount,
    }),
    [mergedClusters.length, zombieProjectIds.size, semanticTallies],
  );

  // --- render ---
  if (belowFallback) {
    return (
      <div
        className="lcars-root lcars-root--narrow"
        role="alert"
        aria-live="polite"
        data-tier="fallback"
      >
        <div className="lcars-narrow-banner">
          <div className="lcars-narrow-banner__title">VIEWPORT TOO NARROW</div>
          <div className="lcars-narrow-banner__body">
            This browser window is under 320px wide. Rotate or resize to restore the viewer.
          </div>
        </div>
      </div>
    );
  }

  // Hold the loading screen until IDB hydration has resolved when the
  // manifest also hasn't produced anything renderable. Otherwise a
  // persisted upload would briefly flash the "NO DATA YET" UI on
  // browser-only deploys (where the manifest 404s before IDB returns).
  //
  // We don't extend this gate to the manifest-`ready` path: SSG/server-
  // rendered consumers expect synchronous content and a loading flash
  // would be a worse regression than the small layout shift when an
  // uploaded archive merges in (same UX as a fresh upload).
  const manifestPending =
    manifestState.status === 'idle' || manifestState.status === 'loading';
  const idbPending = !uploadedHydrated;
  if (!uploadedData && (manifestPending || (manifestState.status === 'error' && idbPending))) {
    return (
      <div className="lcars-root" data-tier={tier}>
        <div className="lcars-frame">
          <div className="lcars-loading">LOADING MANIFEST…</div>
        </div>
      </div>
    );
  }

  if (!uploadedData && manifestState.status === 'error') {
    return (
      <div className="lcars-root" data-tier={tier}>
        <div className="lcars-frame lcars-frame--empty">
          <TopBar
            query=""
            onQueryChange={() => {}}
            tier={tier}
            disabled
            // SCAN LOCAL + UPLOAD CLOUD remain the primary actions out of
            // this state, so the top bar stays visible with both buttons
            // wired to the same handlers as the populated flow.
            onRescan={onRescan}
            rescanStatus={rescanCtl.status}
            rescanProgress={rescanCtl.progress}
            scanAvailable={rescanCtl.available}
            hasLocalData={false}
            {...(rescanToast ? { rescanHint: rescanToast } : {})}
            onCloudUpload={onCloudUpload}
            uploadStatus={uploadStatus}
            hasCloudData={false}
            {...(uploadHint ? { uploadHint } : {})}
            deleteAvailable={rescanCtl.available}
            onDeleteUnload={onUnload}
            deleteCounts={{ cloud: 0, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 }}
          />
          <main className="lcars-empty-main">
            <ErrorState
              title="NO DATA YET"
              detail={`Click SCAN LOCAL above to index your Claude Code / Desktop / Cowork transcripts, or UPLOAD CLOUD for a claude.ai Privacy-Export ZIP. Restart the dev server with pnpm dev to seed a sample corpus instead. See the README for the full walkthrough. (fetch: ${manifestState.message})`}
            />
            <UploadPanel onLoaded={onUpload} variant="prominent" onLoadDemo={onLoadDemo} />
          </main>
        </div>
      </div>
    );
  }

  const activeMode: Mode = selectedId && selectedSession ? 'detail' : mode;
  const modeColor = MODE_COLOR[activeMode];
  const sidebarVariant = tier === 'mobile' ? 'horizontal' : 'vertical';
  const showDetailOverlay = activeMode === 'detail' && !!selectedSession;
  const baseMode: Mode = mode === 'detail' ? 'command' : mode;

  const activeManifest = manifest!;

  const tierIndicator = (
    <TierIndicator
      tierStatus={analysisState.tierStatus}
      tierPresentCount={analysisState.tierPresentCount}
      tierFiles={analysisState.tierFiles}
    />
  );

  // Has-data flags drive the "Scan Local" → "Update Local" and
  // "Upload Cloud" → "Update Cloud" label swaps. Computed from the
  // effective manifest (fetched + uploaded merged), so a user who
  // uploads a ZIP with 10 conversations but has no local history
  // sees "Scan Local" + "Update Cloud" at the same time.
  const manifestCounts = manifest?.counts;
  const hasLocalData =
    (manifestCounts?.cowork ?? 0) +
      (manifestCounts?.['cli-direct'] ?? 0) +
      (manifestCounts?.['cli-desktop'] ?? 0) >
    0;
  const hasCloudData = (manifestCounts?.cloud ?? 0) > 0 || uploadedData !== null;

  return (
    <div
      className="lcars-root"
      data-mode={activeMode}
      data-tier={tier}
      data-demo={demoMode ? 'true' : undefined}
      data-booting={booting ? 'true' : undefined}
    >
      {demoMode && !demoBannerDismissed && (
        <div
          className="lcars-rescan-banner lcars-rescan-banner--demo"
          role="status"
          aria-live="polite"
        >
          <span className="lcars-rescan-banner__tag">DEMO DATA</span>
          <span className="lcars-rescan-banner__message">
            This is a fictional corpus so the viewer doesn&apos;t render empty. To see your own
            Claude transcripts: click <strong>SCAN LOCAL</strong> (top bar) for Claude Code /
            Desktop / Cowork, or <strong>UPLOAD CLOUD</strong> for a claude.ai Privacy-Export ZIP.{' '}
            <a
              href="https://github.com/BryceEWatson/chat-arch#getting-your-own-data"
              target="_blank"
              rel="noreferrer noopener"
              className="lcars-rescan-banner__link"
            >
              Step-by-step →
            </a>
          </span>
          <button
            type="button"
            className="lcars-rescan-banner__dismiss"
            aria-label="dismiss demo banner"
            onClick={() => {
              setDemoBannerDismissed(true);
              try {
                window.localStorage.setItem(DEMO_BANNER_DISMISSED_KEY, '1');
              } catch {
                // no-op: localStorage unavailable, in-memory dismissal is fine
              }
            }}
          >
            ✕
          </button>
        </div>
      )}
      {rescanBanner && (
        <div
          className={`lcars-rescan-banner lcars-rescan-banner--${rescanBanner.kind}`}
          role={rescanBanner.kind === 'error' ? 'alert' : 'status'}
          aria-live={rescanBanner.kind === 'error' ? 'assertive' : 'polite'}
        >
          <span className="lcars-rescan-banner__tag">
            {rescanBanner.kind === 'ok' ? 'RESCAN ✓' : 'RESCAN FAILED'}
          </span>
          <span className="lcars-rescan-banner__message">{rescanBanner.message}</span>
          <button
            type="button"
            className="lcars-rescan-banner__dismiss"
            aria-label="dismiss rescan banner"
            onClick={() => setRescanBanner(null)}
          >
            ✕
          </button>
        </div>
      )}
      {semanticStatus === 'error' && semanticError && (
        // Persistent banner — the chip's tooltip vanishes on focus loss
        // or keypress, which blocks diagnosis when the message is long.
        // Keep the error visible here until the user dismisses it,
        // with a Copy button so they can paste it into a bug report.
        <div
          className="lcars-rescan-banner lcars-rescan-banner--error"
          role="alert"
          aria-live="assertive"
        >
          <span className="lcars-rescan-banner__tag">SEMANTIC FAILED</span>
          <span className="lcars-rescan-banner__message">{semanticError}</span>
          <button
            type="button"
            className="lcars-rescan-banner__dismiss"
            aria-label="copy error to clipboard"
            title="copy error to clipboard"
            onClick={() => {
              try {
                void navigator.clipboard?.writeText(semanticError);
              } catch {
                /* older browsers without Clipboard API — user can select + copy manually */
              }
            }}
          >
            ⧉
          </button>
          <button
            type="button"
            className="lcars-rescan-banner__dismiss"
            aria-label="dismiss semantic error banner"
            onClick={() => {
              // Hide the banner but KEEP `semanticStatus === 'error'`
              // so the analyze chip stays as "ANALYZE FAILED · retry"
              // and the user has a persistent affordance to try again.
              // Clearing status here would roll the chip back to the
              // neutral "ANALYZE TOPICS" CTA and a user who dismisses
              // the banner would lose the error signal entirely — they
              // could walk away believing analysis was never attempted.
              // Only a successful re-run should transition back to
              // `idle`.
              setSemanticError(null);
            }}
          >
            ✕
          </button>
        </div>
      )}
      <div className="lcars-frame">
        <TopBar
          query={rawQuery}
          onQueryChange={setRawQuery}
          tier={tier}
          disabled={showDetailOverlay}
          // Scan Local: always render the button so web-only users
          // see *why* it's disabled. The button itself reads
          // `scanAvailable` to decide whether to fire.
          onRescan={onRescan}
          rescanStatus={rescanCtl.status}
          rescanProgress={rescanCtl.progress}
          scanAvailable={rescanCtl.available}
          hasLocalData={hasLocalData}
          {...(rescanToast ? { rescanHint: rescanToast } : {})}
          // Upload Cloud: always available (pure in-browser parse).
          onCloudUpload={onCloudUpload}
          uploadStatus={uploadStatus}
          hasCloudData={hasCloudData}
          {...(uploadHint ? { uploadHint } : {})}
          deleteAvailable={rescanCtl.available}
          onDeleteUnload={onUnload}
          deleteCounts={{
            cloud: manifestCounts?.cloud ?? 0,
            cowork: manifestCounts?.cowork ?? 0,
            'cli-direct': manifestCounts?.['cli-direct'] ?? 0,
            'cli-desktop': manifestCounts?.['cli-desktop'] ?? 0,
          }}
          rightSlot={
            <button
              type="button"
              className={`lcars-activity-log-toggle${activityLogOpen ? ' lcars-activity-log-toggle--open' : ''}`}
              aria-pressed={activityLogOpen}
              aria-label={activityLogOpen ? 'close activity log' : 'open activity log'}
              title={activityLogOpen ? 'Close activity log (Esc)' : 'Open activity log — see what the system is doing'}
              onClick={() => setActivityLogOpen((v) => !v)}
            >
              LOG
            </button>
          }
        />
        <div className="lcars-body">
          <Sidebar
            mode={activeMode}
            variant={sidebarVariant}
            onSelectMode={(m) => {
              if (m !== 'detail') {
                clearHash();
                setSelectedId(null);
              }
              // Direct-nav to COST from sidebar clears KPI state (no highlight).
              if (m === 'cost') {
                setCostKpiEntry(null);
                setCostToolFilter(undefined);
              }
              // Direct-nav to CONSTELLATION clears chip nav state.
              if (m === 'constellation') {
                setConstellationHighlightClusterId(null);
                setConstellationOriginSessionId(null);
                setZombieFilterActive(false);
              }
              setMode(m);
            }}
          />
          <div className="lcars-content-column">
            <UpperPanel
              manifest={activeManifest}
              filtered={filteredSorted}
              sourceFilter={sourceFilter}
              onToggleSource={toggleSource}
              onClearFilters={clearFilters}
              showSparkline={tier !== 'mobile'}
              uploadActive={uploadedData !== null}
              {...(uploadedData ? { uploadLabel: uploadedData.sourceLabel, onUnload } : {})}
              onUpload={onUpload}
              onKpiClick={onKpiClick}
              projectFilter={projectFilter}
              onToggleProject={toggleProject}
              unknownProjectActive={unknownProjectActive}
              onToggleUnknownProject={toggleUnknownProject}
              showEmpty={showEmpty}
              onToggleShowEmpty={toggleShowEmpty}
              tierIndicatorSlot={tierIndicator}
              semanticProjectsAvailable={
                !!uploadedData &&
                Array.isArray(uploadedData.projects) &&
                uploadedData.projects.length > 0
              }
              {...(uploadedData && Array.isArray(uploadedData.projects)
                ? { semanticProjectCount: uploadedData.projects.length }
                : {})}
              semanticStatus={semanticStatus}
              semanticBundle={semanticLabels}
              semanticProgress={semanticProgress}
              semanticError={semanticError}
              {...(uploadedData
                ? { onAnalyzeSemantic: () => void runSemanticAnalysis(uploadedData) }
                : {})}
              analysisCounts={analysisCounts}
              onOpenDupAnalysis={onOpenDupAnalysis}
              onOpenZombieAnalysis={onOpenZombieAnalysis}
              onOpenTopicAnalysis={onOpenTopicAnalysis}
              onOpenLabelsAnalysis={onOpenLabelsAnalysis}
            />
            <MidBar
              color={modeColor}
              label={activeMode.toUpperCase()}
              {...(baseMode === 'command'
                ? {
                    rightSlot: (
                      <label className="lcars-mid-bar__sort">
                        <span className="lcars-mid-bar__sort-label">SORT</span>
                        <select
                          className="lcars-mid-bar__sort-select"
                          aria-label="sort sessions"
                          value={sortBy}
                          onChange={(e) => setSortBy(e.target.value as SortBy)}
                        >
                          <option value="recent">RECENT</option>
                          <option value="oldest">OLDEST</option>
                          <option value="cost">COST ↓</option>
                          <option value="turns">TURNS ↓</option>
                          <option value="project">PROJECT</option>
                        </select>
                      </label>
                    ),
                  }
                : {})}
            />
            <FilterBar
              manifest={activeManifest}
              filtered={filteredSorted}
              sourceFilter={sourceFilter}
              onToggleSource={toggleSource}
              onClearFilters={clearFilters}
              projectFilter={projectFilter}
              onToggleProject={toggleProject}
              unknownProjectActive={unknownProjectActive}
              onToggleUnknownProject={toggleUnknownProject}
              showEmpty={showEmpty}
              onToggleShowEmpty={toggleShowEmpty}
              streaming={semanticStatus === 'running'}
              {...(filterFocus ? { filterFocus } : {})}
            />
            <main
              className="lcars-mode-area"
              aria-label={`${activeMode} mode`}
              style={{ ['--mode-color' as string]: modeColor } as React.CSSProperties}
            >
              {activeManifest.sessions.length === 0 ? (
                <EmptyState {...(uploadedData ? {} : { onUpload, onLoadDemo })} />
              ) : (
                <>
                  <div className="lcars-mode-area__base" hidden={showDetailOverlay}>
                    {baseMode === 'command' ? (
                      <CommandMode
                        sessions={filteredSorted}
                        onSelect={onSelect}
                        sessionDupIndex={sessionDupIndex}
                        zombieProjectIds={zombieProjectIds}
                        semanticSessionIds={semanticSessionIds}
                        onDuplicateChipClick={onDuplicateChipClick}
                        onZombieChipClick={onZombieChipClick}
                      />
                    ) : baseMode === 'timeline' ? (
                      <TimelineMode sessions={filteredSorted} onSelect={onSelect} />
                    ) : baseMode === 'constellation' ? (
                      <ConstellationMode
                        sessions={activeManifest.sessions}
                        mergedClusters={mergedClusters}
                        zombieProjects={zombieProjects}
                        tierFiles={analysisState.tierFiles}
                        highlightClusterId={constellationHighlightClusterId}
                        highlightOriginSessionId={constellationOriginSessionId}
                        zombieFilterActive={zombieFilterActive}
                        onSelect={onSelect}
                      />
                    ) : baseMode === 'cost' ? (
                      <CostMode
                        sessions={filteredSorted}
                        kpiEntry={costKpiEntry}
                        {...(costToolFilter !== undefined ? { toolFilter: costToolFilter } : {})}
                        onSelect={onSelect}
                        costDiagnosedPresent={
                          !!analysisState.tierFiles['cost-diagnoses.json']?.present
                        }
                      />
                    ) : null}
                  </div>
                  {showDetailOverlay && selectedSession && (
                    <DetailMode
                      session={selectedSession}
                      dataRoot={dataRoot}
                      cache={cache}
                      setCache={setCache}
                      onBack={onBack}
                      prevId={prevId}
                      nextId={nextId}
                      onPrev={onPrev}
                      onNext={onNext}
                      {...(uploadedData
                        ? { uploadedConversationsById: uploadedData.conversationsById }
                        : {})}
                    />
                  )}
                  {mode === 'detail' && !selectedId && (
                    <EmptyState title="NO SELECTION" message="Pick a session to view its detail." />
                  )}
                </>
              )}
            </main>
          </div>
        </div>
      </div>
      <ActivityLogPanel
        entries={logEntries}
        isOpen={activityLogOpen}
        onOpen={() => setActivityLogOpen(true)}
        onClose={() => setActivityLogOpen(false)}
        onClear={clearLog}
      />
    </div>
  );
}
