import type { SessionManifest, SessionSource, UnifiedSessionEntry } from '@chat-arch/schema';
import type {
  AppliedImprovementsFile,
  CloudConversation,
  CloudProject,
  CorrectionsFile,
  Project,
  Topic,
  Narrative,
} from '@chat-arch/schema';
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
  /**
   * Phase 4 — demo path only. When the viewer is loaded with a
   * generated demo fixture, the demo populates corrections + applied-
   * improvements + a synthesized rescan delta inline so the workshop
   * loop is visible on the hosted demo without requiring a back-end
   * mining pass. Real cloud-zip uploads (`parseCloudZip`) never
   * provide these fields — the corresponding signals come from
   * `corrections.json` / `applied-improvements.json` on disk instead.
   */
  corrections?: CorrectionsFile;
  appliedImprovements?: AppliedImprovementsFile;
  /**
   * Phase 4 — demo path only. The corrections-candidates file is what
   * drives the CoverageMeter + pipeline-stage markers (EXPORTER SCAN /
   * LLM MINE) in the panel. Real cloud-zip uploads omit this — the
   * panel falls back to the network fetch of `correction-candidates.
   * json` from disk. On the hosted demo there's nothing on disk, so
   * without a synthesized candidates file the CoverageMeter never
   * mounts and PR #33's stage markers ship invisible.
   */
  correctionCandidates?: CorrectionsFile;
  /**
   * Synthesized "what just rescanned" payload for the persistent
   * rescan-delta chip. The chip's normal source is the `/api/rescan`
   * success branch in onRescan; demo loads have no such pass to feed
   * it, so we hand-author the delta and the chip's existing dismiss
   * flow handles the rest.
   */
  synthesizedRescanDelta?: {
    totalLocal: number;
    cowork: number;
    cli: number;
    desktop: number;
  };
}

/** UI mode — which main-content surface is active. */
export type Mode =
  | 'command'
  | 'timeline'
  | 'detail'
  /** v2 spec §5.1: PROJECTS surface (index + detail in one mode, driven by hash). */
  | 'projects'
  /** v2 spec §5.2: TOPICS surface (index + detail in one mode, driven by hash). */
  | 'topics'
  /** v2 spec §5.4: PRACTICE four-lens adversarial audit dashboard. */
  | 'practice'
  /** Correction-mining surface: clustered patterns + proposed CLAUDE.md upgrades. */
  | 'corrections'
  /**
   * Phase 1 outcome-substrate expansion #4: trajectory chart over the
   * composite-outcome score (weekly mean + EWMA + Wilson-CI ribbon on
   * the binarized-good share). Reads `analysis/composite-outcomes.json`.
   */
  | 'effectiveness'
  /**
   * Phase 1 outcome-substrate expansions #2 + #11 + #14 collected into
   * one descriptive-contrast surface: config-window snapshots,
   * recurring-question clusters, reflexive matched-pair contrast.
   * Reads `analysis/its-analysis.json` + `knowledge-debt.json` +
   * `reflexive.json` + `config-history.json`.
   */
  | 'insights'
  /**
   * Agentic Q&A + opportunity-finding over the corpus. The "chat with
   * your archive" surface — drives `/api/chat-answer`, which spawns the
   * local Claude Code CLI against the `chat-answer` skill. Driven by
   * `#chat` hash.
   */
  | 'chat'
  /**
   * Stream J #1: DECISIONS surface — table of LLM-classified decisions
   * grouped by topic, joined to composite outcomes via outcomeRef.
   */
  | 'decisions'
  /**
   * Stream J #10: TRUST surface — 2×2 accept/override × landed/didn't,
   * with Wilson CIs and a mis-calibration flag.
   */
  | 'trust'
  /**
   * Stream J #5: TRENDS surface — project trajectory + workflow
   * archetypes + cross-surface comparison + skill curves.
   */
  | 'trends'
  /**
   * Stream J #7: EXPORT surface — checklist of export kinds with
   * filters; GENERATE drives `/api/generate-exports`.
   */
  | 'export';

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
  projects: 'var(--lcars-sunflower)',
  topics: 'var(--lcars-ice)',
  practice: 'var(--lcars-violet)',
  corrections: 'var(--lcars-peach)',
  // Phase 1 outcome-substrate surfaces — share the ANALYTICS group's
  // accent palette so the active-mode dot reads as part of the
  // analytics-side IA, distinct from the FIX RULES corrections accent.
  effectiveness: 'var(--lcars-ice)',
  insights: 'var(--lcars-violet)',
  // Chat picks up the design-system's sunflower yellow at chrome level
  // (matches "talk to it" affordance — the user's primary verb for this
  // surface) — distinct from the projects accent so the active-mode dot
  // doesn't blur the two.
  chat: 'var(--lcars-sunflower)',
  // Stream J surfaces — placed under FIX RULES (decisions, trust),
  // ANALYTICS (trends), and standalone (export). Accent reuses
  // existing palette tokens.
  decisions: 'var(--lcars-peach)',
  trust: 'var(--lcars-peach)',
  trends: 'var(--lcars-ice)',
  export: 'var(--lcars-butterscotch)',
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
  /**
   * v2 (Phase 2) entity sidecars. `null` until Phase 6 wires in-browser
   * parallel emission for uploads — for fetched manifests these come
   * from `analysis/projects.json`, `topics.json`, `narratives.json`
   * written by the exporter. The viewer treats them as best-effort:
   * a missing file just means no chips for that surface.
   */
  v2Projects: readonly Project[] | null;
  v2Topics: readonly Topic[] | null;
  v2Narratives: readonly Narrative[] | null;
}

export type { SessionManifest, UnifiedSessionEntry, SessionSource };
