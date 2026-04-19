/**
 * UnifiedSessionEntry — normalized record shape produced by Cowork, CLI-direct,
 * CLI-desktop, and cloud exporters.
 *
 * PRIMARY KEY: (source, id) — see `id` JSDoc.
 *
 * Design rules (enforced by exactOptionalPropertyTypes):
 *   - REQUIRED fields: always present regardless of source.
 *   - REQUIRED-NULLABLE (`T | null`): always present; value is null when the
 *     source genuinely lacks the data. The key always appears in JSON so
 *     consumers can distinguish "checked and missing" from "bug / key absent."
 *   - OPTIONAL (`?:`): key genuinely absent for certain sources; consumers
 *     must branch on presence.
 */

export type SessionSource = 'cloud' | 'cowork' | 'cli-direct' | 'cli-desktop';

export type TitleSource =
  | 'manifest' // Cowork manifest.title, Desktop-CLI manifest.title
  | 'cloud-name' // Cloud conversation.name
  | 'ai-title' // CLI ai-title line
  | 'first-prompt' // CLI first user message or last-prompt fallback
  | 'fallback'; // UNTITLED_SESSION placeholder

export type CwdKind = 'host' | 'vm' | 'none';

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface UnifiedSessionEntry {
  // ---- Identity ----

  /**
   * Primary key component (paired with `source`).
   *
   * IMPORTANT: `id` alone is NOT unique across sources. A cliSessionId can appear
   * in both `cli-desktop` (via manifest) and `cli-direct` (via filesystem walk)
   * pointing at the same underlying transcript. The Phase 2/3 exporter
   * de-duplicates by preferring `cli-desktop` when both exist.
   *
   * Use `(source, id)` as the composite primary key in all downstream code.
   *
   *   Cowork/Desktop-CLI/CLI-direct: bare cliSessionId UUID
   *   Cloud: conversation.uuid
   */
  id: string;

  /** Ingestion path that produced this record. */
  source: SessionSource;

  /**
   * Original raw sessionId from the source (debugging aid).
   * Cowork/Desktop-CLI: "local_<uuid>". CLI-direct: UUID. Cloud: conversation.uuid.
   */
  rawSessionId: string;

  // ---- Temporal (ms-since-epoch) ----

  startedAt: number;
  updatedAt: number;
  durationMs: number;

  // ---- Content ----

  /** Display title. Never empty — falls back to UNTITLED_SESSION. */
  title: string;

  titleSource: TitleSource;

  /**
   * Short preview of session content (max 200 chars).
   * - When `summary` is present: first 200 chars of summary.
   * - Else: first 200 chars of the first user message.
   * - null only when no content exists.
   *
   * Populating this in the manifest avoids forcing the viewer to eager-fetch
   * per-session chunks for card previews (~11 MB saved at 1033 sessions).
   */
  preview: string | null;

  /**
   * Count of user-initiated turns. Uniform across sources.
   *   Cowork: count of 'user' lines in audit.jsonl (result.num_turns counts
   *           batch cycles, not user events, so it is NOT used here)
   *   CLI: count of 'user' lines in the transcript
   *   Cloud: count of chat_messages where sender === 'human'
   *
   * NOTE: Desktop-CLI entries emitted by Phase 2 are initialized to 0 and
   * overwritten by Phase 3's transcript walk (see `source === 'cli-desktop'`).
   */
  userTurns: number;

  /**
   * Count of assistant responses when computable. Present for cloud (sender
   * split), CLI (assistant lines), often for Cowork. Absent when not derivable
   * without deeper parsing than Phase 2 performs.
   */
  assistantTurns?: number;

  /**
   * Primary model string. Defined as the model of the LAST assistant turn in
   * the session — stable, no aggregation. Raw strings preserved (no normalization
   * of Desktop-CLI's `[1m]` context-length suffix). May differ from modelsUsed
   * when the session switched models mid-run.
   *
   * null only when the source genuinely has no per-message model info
   * (cloud exports lack this).
   */
  model: string | null;

  /** All distinct model strings seen in the session. */
  modelsUsed?: readonly string[];

  // ---- Location ----

  /**
   * Working directory at session start.
   *   host: real filesystem path (CLI-direct, CLI-desktop)
   *   vm: synthetic Cowork VM path `/sessions/<processName>`
   *   none: cloud (cwd absent entirely)
   *
   * NEVER derive cwd from the encoded directory name — path encoding is lossy
   * (see CONTRADICTIONS C3). Read from transcript event.cwd (CLI) or manifest.cwd.
   */
  cwd?: string;

  /** Discriminator for `cwd` interpretation. Required so the viewer never guesses. */
  cwdKind: CwdKind;

  /** Project name, derived from cwd via case-insensitive match. Cloud/VM have none. */
  project?: string;

  // ---- Economics ----

  /**
   * Session cost in USD. null when:
   *   - Cowork has no result line (CONTRADICTIONS C5 — common)
   *   - CLI has no precomputed cost (CONTRADICTIONS C4 — always)
   *   - Cloud export has no cost (doc 06 §8 — always)
   */
  totalCostUsd: number | null;

  /** Aggregated token counts. Absent when not computable. */
  tokenTotals?: TokenTotals;

  /**
   * Phase 6 (schemaVersion 2): exporter-computed cost in USD.
   *   - When `totalCostUsd != null`: mirrors `totalCostUsd` (exact), `costIsEstimate = false`.
   *   - When `totalCostUsd == null` AND `tokenTotals != null` AND model is in the rate table:
   *     estimated from rate table (input/output/cache rates), `costIsEstimate = true`.
   *   - Otherwise null (unknown model, missing tokenTotals, or no matching rate).
   *
   * Optional on the TS type so v1 manifests (no cost-estimate pass) still
   * satisfy the shape (AC13 back-compat). The exporter always populates both
   * fields together when writing a v2 manifest. Consumers branch on presence
   * for v1 compatibility.
   *
   * Phase 7 corrected cost lives in `analysis/cost-diagnoses.json` as a side-map —
   * never overwrites this field. The viewer renders both when present.
   */
  costEstimatedUsd?: number | null;

  /**
   * True iff `costEstimatedUsd` is a rate-table estimate (not an authoritative
   * `totalCostUsd` from the source). False when the value comes from an exact
   * Cowork `totalCostUsd`. Absent on v1 manifests (see `costEstimatedUsd` JSDoc).
   */
  costIsEstimate?: boolean;

  /**
   * Optional diagnostic breakdown attached when `costIsEstimate === true`.
   * Present only on estimated sessions; absent on exact or null-cost sessions.
   */
  costBreakdown?: {
    modelIdUsed: string;
    inputUsd: number;
    outputUsd: number;
    cacheWriteUsd: number;
    cacheReadUsd: number;
    note?: string;
  };

  // ---- Cloud-ish enrichments ----

  /** Auto-generated summary (cloud only for now, 27.6% of cloud conversations). */
  summary?: string;

  /**
   * Tool-use histogram (tool name → call count). Populated by every
   * source by mining `tool_use` content blocks on assistant messages:
   *
   *   - cloud: walks `chat_messages[].content[]` (cloud-mapping.ts).
   *   - cli-direct / cli-desktop: walks assistant-line `message.content[]`
   *     during the streaming transcript aggregate (cli.ts + lib/toolUses.ts).
   *   - cowork: second streaming pass over the copied transcript
   *     (cowork.ts + lib/toolUses.ts) — cowork's audit.jsonl carries only
   *     `tool_use_summary` lines with ids, not tool names, so the
   *     transcript is the authoritative source.
   *
   * Absent when the session records no tool calls OR the transcript was
   * unreadable. Consumers must treat "key missing" as "unknown", not
   * "zero" — though in practice assistant-heavy CLI sessions are almost
   * certain to have at least one tool_use when the key is present.
   */
  topTools?: Readonly<Record<string, number>>;

  /**
   * Source-file modification time (ms since epoch) at the moment this
   * entry was produced. Used by the exporter's incremental rescan to
   * skip re-aggregating transcripts that haven't changed since the last
   * run — a stat call + number compare is cheap, streaming a 10k-line
   * transcript is not.
   *
   * Set by local sources (cli-direct / cli-desktop on the transcript
   * file, cowork on the session manifest JSON). Absent on cloud
   * entries (which are rebuilt wholesale from a ZIP — incremental
   * reuse there would buy nothing).
   *
   * Consumers SHOULD treat absence as "no cached mtime; always rebuild"
   * rather than as an error.
   */
  sourceMtimeMs?: number;

  // ---- Pointers (always output-relative POSIX paths, never host-absolute) ----

  /**
   * Path to the full transcript, relative to the exporter's output dir. Always
   * POSIX slashes so the viewer can fetch it from the static server.
   *
   * IMPORTANT: local-source exporters (Cowork, CLI) MUST copy the transcript into
   * the output dir (e.g. `local-transcripts/<source>/<uuid>.jsonl`) so the path
   * is browser-resolvable. Never reference a host-absolute path here.
   *
   * Cloud: `cloud-conversations/<uuid>.json`.
   */
  transcriptPath?: string;

  /** Output-relative path to the source manifest (Cowork, Desktop-CLI only). */
  manifestPath?: string;

  /** Output-relative path to the Cowork audit log. */
  auditPath?: string;
}

export interface SessionManifest {
  schemaVersion: 1 | 2;
  generatedAt: number;
  counts: Readonly<Record<SessionSource, number>>;
  sessions: readonly UnifiedSessionEntry[];
}

export const UNTITLED_SESSION = 'Untitled session';

/**
 * Current manifest schema version. Phase 6 bumps to 2 (adds cost-estimate
 * fields on every entry). The viewer tolerates v1 manifests by treating the
 * new fields as absent. Future schema changes bump this constant.
 */
export const CURRENT_SCHEMA_VERSION = 2;
