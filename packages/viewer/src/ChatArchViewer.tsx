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
import { Sidebar } from './components/Sidebar.js';
import { UpperPanel } from './components/UpperPanel.js';
import { MidBar } from './components/MidBar.js';
import { EmptyState } from './components/EmptyState.js';
import { ErrorState } from './components/ErrorState.js';
import { UploadPanel } from './components/UploadPanel.js';
import { NuclearReset } from './components/NuclearReset.js';
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
import { filterSessions, sortByUpdatedDesc } from './data/search.js';
import { effectiveManifest, mergeUploads } from './data/mergeUpload.js';
import { useRescan } from './data/rescan.js';
import { parseCloudZip } from './data/zipUpload.js';
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

  // --- UI state ---
  const [mode, setMode] = useState<Mode>('command');
  const [selectedId, setSelectedId] = useState<string | null>(() => readSessionHash());
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<FilterState>(new Set<SessionSource>());
  const [projectFilter, setProjectFilter] = useState<ReadonlySet<string>>(new Set());
  const [unknownProjectActive, setUnknownProjectActive] = useState(false);
  const [showEmpty, setShowEmpty] = useState<boolean>(() => readEmptyParam());
  const [cache, setCache] = useState<ConversationCache>(new Map());

  // --- analysis state (Phase 6) ---
  const [analysisState, setAnalysisState] = useState<AnalysisState>({
    duplicatesExact: null,
    zombiesHeuristic: null,
    tierStatus: 'browser',
    tierPresentCount: 0,
    tierFiles: {},
  });

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
    if (manifestProp) return;
    let cancelled = false;
    setManifestState({ status: 'loading' });
    fetchManifest(manifestUrl)
      .then((m) => {
        if (!cancelled) setManifestState({ status: 'ready', data: m });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setManifestState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [manifestUrl, manifestProp]);

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

  // --- derived: active manifest ---
  //
  // Uploaded cloud entries merge on top of the fetched manifest (dedup by
  // id, uploaded cloud wins); non-cloud fetched entries (cli/cowork) pass
  // through so local history isn't lost when a ZIP is uploaded. See
  // `data/mergeUpload.ts` for the rules.
  const fetchedManifest = manifestState.status === 'ready' ? manifestState.data : null;
  const manifest: SessionManifest | null = useMemo(
    () => effectiveManifest(fetchedManifest, uploadedData),
    [fetchedManifest, uploadedData],
  );

  // --- derived: merged duplicate clusters + per-session index ---
  const exactDupFile = useMemo(
    () => parseDuplicatesFile(analysisState.duplicatesExact, 'browser'),
    [analysisState.duplicatesExact],
  );
  // Phase 6: semantic file is always absent. Wire the merge path now so
  // Phase 7 Just Works.
  const mergedClusters = useMemo(() => mergeDuplicateClusters(exactDupFile, null), [exactDupFile]);
  const sessionDupIndex = useMemo(
    () => buildSessionDuplicateIndex(mergedClusters),
    [mergedClusters],
  );

  // --- derived: zombie projects parsed into the card shape ---
  const zombieProjects = useMemo<readonly ZombieProject[]>(() => {
    const payload = analysisState.zombiesHeuristic;
    if (!payload || typeof payload !== 'object') return [];
    const arr = (payload as Record<string, unknown>)['projects'];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is ZombieProject =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as ZombieProject).id === 'string' &&
        typeof (p as ZombieProject).classification === 'string',
    );
  }, [analysisState.zombiesHeuristic]);

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
    return sortByUpdatedDesc(filtered);
  }, [manifest, debouncedQuery, sourceFilter, showEmpty, projectFilter, unknownProjectActive]);

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
  };

  // Top-bar Upload Cloud button handler: takes a File, parses the
  // ZIP, then reuses the same `onUpload` merge path. The legacy
  // EmptyState UploadPanel keeps owning its own flow (it still shows
  // when there's no manifest at all), so this lives alongside that
  // path — not a replacement of it.
  const onCloudUpload = async (file: File): Promise<void> => {
    setUploadStatus('running');
    setUploadHint(undefined);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadStatus('error');
      setUploadHint(`Upload failed: ${msg}`);
      setRescanBanner({ kind: 'error', message: `Upload failed: ${msg}` });
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

  if (!uploadedData && (manifestState.status === 'idle' || manifestState.status === 'loading')) {
    return (
      <div className="lcars-root" data-tier={tier}>
        <div className="lcars-frame">
          <div className="lcars-loading">LOADING MANIFEST…</div>
        </div>
        <NuclearReset available={rescanCtl.available} onUnload={onUnload} />
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
          />
          <main className="lcars-empty-main">
            <ErrorState
              title="NO DATA YET"
              detail={`Click SCAN LOCAL above to index your Claude Code / Desktop / Cowork transcripts, or UPLOAD CLOUD for a claude.ai Privacy-Export ZIP. Restart the dev server with pnpm dev to seed a sample corpus instead. See the README for the full walkthrough. (fetch: ${manifestState.message})`}
            />
            <UploadPanel onLoaded={onUpload} variant="prominent" />
          </main>
        </div>
        <NuclearReset available={rescanCtl.available} onUnload={onUnload} />
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
          // Clear-upload `×` chip: only when an uploaded ZIP is the
          // active manifest. Reuses the same `onUnload` path as the
          // UpperPanel chip (clears cache + filters + selection).
          uploadActive={uploadedData !== null}
          {...(uploadedData ? { onClearUpload: onUnload } : {})}
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
            />
            <MidBar color={modeColor} label={activeMode.toUpperCase()} />
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
            />
            <main
              className="lcars-mode-area"
              aria-label={`${activeMode} mode`}
              style={{ ['--mode-color' as string]: modeColor } as React.CSSProperties}
            >
              {activeManifest.sessions.length === 0 ? (
                <EmptyState {...(uploadedData ? {} : { onUpload })} />
              ) : (
                <>
                  <div className="lcars-mode-area__base" hidden={showDetailOverlay}>
                    {baseMode === 'command' ? (
                      <CommandMode
                        sessions={filteredSorted}
                        onSelect={onSelect}
                        sessionDupIndex={sessionDupIndex}
                        zombieProjectIds={zombieProjectIds}
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
      <NuclearReset available={rescanCtl.available} onUnload={onUnload} />
    </div>
  );
}
