import type { SessionManifest, SessionSource, UnifiedSessionEntry } from '@chat-arch/schema';
import type { CloudConversation, CloudProject } from '@chat-arch/schema';
import type { TierFileState } from './data/analysisFetch.js';

/**
 * In-memory manifest produced by parsing a user-uploaded cloud-export ZIP.
 *
 * Held in React state during the session and mirrored into IndexedDB
 * (`chat-arch` → `uploaded-cloud-data` → `archive`) by `ChatArchViewer` so
 * a page refresh restores the upload — see `data/uploadedDataStore.ts`.
 * IDB stores the structure verbatim (the `Map` survives `structuredClone`).
 *
 * When present it replaces the fetched manifest for all viewer surfaces;
 * drill-in reads conversations from `conversationsById` without a fetch.
 */
export interface UploadedCloudData {
  manifest: SessionManifest;
  conversationsById: Map<string, CloudConversation>;
  /**
   * User's claude.ai projects as shipped inside the export ZIP's own
   * `projects.json`. Retained on the upload so the semantic classifier
   * (Phase 3) can build centroid embeddings from each project's name,
   * description, and prompt_template. Optional because older exports /
   * partial ZIPs may omit it.
   */
  projects?: readonly CloudProject[];
  /** Human-readable label (original filename + size) for the unload UI. */
  sourceLabel: string;
}

/** UI mode — which main-content surface is active. */
export type Mode = 'command' | 'timeline' | 'detail' | 'constellation' | 'cost';

/** Generic async-fetch state. Used uniformly for manifest + drill-in fetches. */
export type FetchState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

/**
 * Source-filter set. Empty Set means "show all" (per plan decision 15).
 * The user-facing "ALL" pill resets to an empty set; individual pills toggle
 * membership.
 */
export type FilterState = ReadonlySet<SessionSource>;

/**
 * Shape of a parsed local transcript line. Best-effort:
 * known types pass through; malformed lines are wrapped so the viewer can
 * render them visibly rather than swallow them.
 */
export type LocalTranscriptEntry =
  | { type: 'known'; line: Record<string, unknown> }
  | { type: '_malformed'; raw: string; error: string };

/** What gets cached per drill-in. Keyed by `${source}:${id}`. */
export type DrillInBody =
  | { kind: 'cloud'; conversation: CloudConversation }
  | { kind: 'local'; entries: readonly LocalTranscriptEntry[] };

/**
 * In-memory cache of drill-in bodies. Per plan decision 5: no sessionStorage,
 * no cross-mount persistence. A plain Map is enough.
 */
export type ConversationCache = Map<string, FetchState<DrillInBody>>;

/** Fixed source-color mapping (plan LCARS spec). */
export const SOURCE_COLOR: Record<SessionSource, string> = {
  cloud: 'var(--lcars-violet)',
  cowork: 'var(--lcars-butterscotch)',
  'cli-direct': 'var(--lcars-ice)',
  'cli-desktop': 'var(--lcars-peach)',
};

/** Single-letter badge for color-independence a11y (plan decision 15). */
export const SOURCE_BADGE: Record<SessionSource, string> = {
  cloud: 'C',
  cowork: 'W',
  'cli-direct': 'D',
  'cli-desktop': 'K',
};

/** Display label for the source. */
export const SOURCE_LABEL: Record<SessionSource, string> = {
  cloud: 'CLOUD',
  cowork: 'COWORK',
  'cli-direct': 'CLI-DIRECT',
  'cli-desktop': 'CLI-DESKTOP',
};

/** Per-mode accent color key (plan decision 3). */
export const MODE_COLOR: Record<Mode, string> = {
  command: 'var(--lcars-butterscotch)',
  timeline: 'var(--lcars-ice)',
  detail: 'var(--lcars-sunflower)',
  constellation: 'var(--lcars-violet)',
  cost: 'var(--lcars-peach)',
};

/**
 * `analysis/` state slice (Phase 6 file manifest).
 *
 * Populated by `data/analysisFetch.ts` + Team C's tier-1 fetch path.
 * `duplicatesExact` and `zombiesHeuristic` are tier-1 payloads (Team A's
 * exporter writes them; Team C wires the fetch). `tierStatus` /
 * `tierPresentCount` / `tierFiles` cover the six Phase-7-reserved
 * tier-2 files and drive `TierIndicator` / `TierSheet`.
 *
 * Shape is intentionally tolerant of the tier-1 slots being empty — the
 * viewer loads successfully when `analysis/` is absent, per AC6.
 */
export interface AnalysisState {
  /**
   * `analysis/duplicates.exact.json` payload (Phase 6, written by Team A's
   * exporter). `null` when absent. Team C consumes in CONSTELLATION.
   */
  duplicatesExact: unknown | null;
  /**
   * `analysis/zombies.heuristic.json` payload (Phase 6, written by Team A).
   * `null` when absent. Team C consumes in CONSTELLATION.
   */
  zombiesHeuristic: unknown | null;
  /** `'browser'` when zero tier-2 files present; `'browser+local'` otherwise. */
  tierStatus: 'browser' | 'browser+local';
  /** Count of tier-2 files present out of 6. Renders as `(N/6)` in the pill. */
  tierPresentCount: number;
  /** Per-Phase-7-reserved-filename state map. Keys are the six reserved filenames. */
  tierFiles: Record<string, TierFileState>;
}

export type { SessionManifest, UnifiedSessionEntry, SessionSource };
