/**
 * Correction extraction — feature-design notes live in `_planning/`.
 *
 * Pipeline: heuristic recall pre-filter (this module's input) →
 * LLM distillation+classification (precision) → embedding clustering →
 * proposed upgrade inference. The first stage is heuristic-cheap; later
 * stages are LLM-cost-bearing and gated behind the `--corrections-llm`
 * exporter flag.
 *
 * Persistence: `analysis/corrections.json`, sibling of `projects.json` etc.
 * No session-level foreign key on `UnifiedSessionEntry` — corrections
 * point to sessions, not the reverse, because a session may contain zero
 * corrections (the common case) and stuffing optional arrays bloats the
 * manifest for no UI benefit.
 */

export type CorrectionSignalKind =
  // Explicit negation directed at the immediately-preceding assistant turn.
  | 'explicit-stop'
  | 'explicit-no'
  | 'instead-of'
  // User reissues an instruction that already appeared earlier in the thread.
  | 'repeat-instruction'
  // ALL CAPS / multiple exclamation / repeated punctuation in the same turn.
  | 'frustration'
  // Imperative correction without negation: "use X" / "always do Y".
  | 'imperative-override'
  // Pivot away from the current path: "actually,", "wait,", "let's …".
  // Added 2026-05 after a recall audit found ~177 missed corrections of
  // this shape in the chat-arch corpus (see scripts/audit-correction-recall.mjs).
  | 'soft-redirect'
  // First-person preference statement: "I want", "I'd prefer", "I would like".
  | 'want-prefer';

export interface CorrectionSignal {
  kind: CorrectionSignalKind;
  /** Verbatim phrase that triggered the signal. */
  phrase: string;
}

/** Single detected correction instance. */
export interface Correction {
  id: string;
  sessionId: string;
  /** 0-based index into the session's user turns. */
  userTurnIndex: number;
  /**
   * The user's correcting message, trimmed to ≤500 chars.
   * Longer messages are truncated with a trailing ellipsis.
   */
  excerpt: string;
  /**
   * The assistant turn the correction is directed at (≤500 chars).
   * Null when the correction is the first turn of the session.
   */
  precedingAssistantExcerpt: string | null;
  /** Heuristic signals that fired. ≥1 by construction. */
  signals: readonly CorrectionSignal[];
  /**
   * LLM-pass classification. Null until the precision pass has run.
   *   - kind: what kind of correction this is, normalized.
   *   - distilledRule: canonical rule statement, used for clustering.
   *   - confidence: 0..1, classifier-reported.
   * When null, consumers MUST treat the correction as a candidate, not a fact.
   */
  classification: CorrectionClassification | null;
}

export type CorrectionKind =
  | 'behavior-rule'        // "don't add docstrings unless asked"
  | 'output-format'        // "use bullets, not paragraphs"
  | 'tool-preference'      // "use ripgrep, not grep"
  | 'factual-fix'          // "no, X is actually Y" — domain knowledge, not a rule
  | 'tone'                 // "stop being so verbose"
  | 'process'              // "always run tests before committing"
  | 'other';

export interface CorrectionClassification {
  kind: CorrectionKind;
  /**
   * Canonical rule text, normalized for clustering. Imperative voice,
   * no first-person pronouns, no project-specific identifiers unless
   * the rule is genuinely scoped (those go to scope.projectId instead).
   */
  distilledRule: string;
  confidence: number;
  /**
   * Whether the LLM judged this an actual instruction-to-the-model
   * (vs. a factual correction about the world, an aside, or noise).
   * Only `actionable: true` corrections feed pattern clustering.
   */
  actionable: boolean;
}

export type UpgradeTarget =
  | 'global-claude-md'
  | 'project-claude-md'
  | 'settings-hook'
  | 'skill'
  | 'agent'
  | 'command'
  | 'prompt-snippet';

export interface ProposedUpgrade {
  target: UpgradeTarget;
  /**
   * Suggested file path or settings.json key. Examples:
   *   global-claude-md     → "~/.claude/CLAUDE.md"
   *   project-claude-md    → "<repo>/CLAUDE.md"
   *   settings-hook        → "settings.json :: hooks.PostToolUse"
   *   skill                → "~/.claude/skills/<name>/SKILL.md"
   *   prompt-snippet       → "(reusable, no fixed path)"
   */
  targetPath: string;
  /** The literal text to add. User reviews before applying. */
  patch: string;
  /** Why this target — cites the inference rule that fired. */
  rationale: string;
  /**
   * Set true ONLY by the user (or a tool acting on the user's behalf).
   * The exporter never sets this — auto-apply is out of scope by design.
   */
  applied: boolean;
  /** ms-since-epoch when applied; null until then. */
  appliedAt: number | null;
}

export interface CorrectionPatternScope {
  /**
   * 'global' when instances span ≥3 distinct projects; 'project' when all
   * instances share one project; 'tool' when all instances cite the same
   * tool name; 'request-shape' when instances cluster around a workflow
   * (e.g. test-writing, refactoring) regardless of project.
   */
  kind: 'global' | 'project' | 'tool' | 'request-shape';
  projectId?: string;
  tool?: string;
  requestShape?: string;
}

export interface CorrectionPattern {
  /**
   * Stable id derived from a hash of `canonicalRule` so re-runs across
   * exporter passes assign the same pattern the same id, enabling
   * applied/appliedAt bookkeeping to survive regeneration.
   */
  id: string;
  /** Canonical rule text, the cluster centroid in human-readable form. */
  canonicalRule: string;
  /** Member Correction.ids. */
  instanceIds: readonly string[];
  /** ≥3 distinct sessionIds enforced before a pattern is emitted. */
  occurrenceCount: number;
  firstSeen: number;
  lastSeen: number;
  scope: CorrectionPatternScope;
  /**
   * Ranked candidates, highest-confidence first. Plural so the user can
   * pick — the system never decides target on the user's behalf.
   */
  proposedUpgrades: readonly ProposedUpgrade[];
  /**
   * 0..1. Combines: classifier confidence, recurrence count, recency,
   * and whether ≥1 instance has been observed post-appliedAt (which
   * lowers confidence in any not-yet-applied upgrade because the
   * existing rule is evidently failing — the recurrence is itself the
   * signal that something else is needed).
   */
  confidence: number;
  /**
   * True when ≥1 instance was detected after a member ProposedUpgrade's
   * appliedAt. Indicates the applied rule is failing in practice and
   * the user should reword, add an example, or move it to a hook.
   */
  recurringPostApplication: boolean;
  /**
   * True when canonicalRule semantically matches existing CLAUDE.md
   * content the exporter was pointed at. Like recurringPostApplication,
   * this means the rule exists but isn't being followed — high-value
   * finding, surfaced separately in the viewer.
   */
  alreadyEncoded: boolean;
  /**
   * Short LLM-derived topic label (1-3 words, Title Case) shared
   * across all patterns in the same theme — drives dynamic bucketing
   * in the viewer instead of the predefined RECURRING/ENCODED/NEW
   * taxonomy. Set by the mine-corrections skill's `tag-topics` stage,
   * which sees ALL patterns in one LLM call so labels stay coherent
   * across the corpus (no fragmentation between "Git Workflow" and
   * "Git Practices"). Optional for back-compat: patterns from prior
   * mining runs without this field render in an "Untagged" bucket
   * until re-mined.
   */
  topic?: string;
}

export interface CorrectionsFile {
  generatedAt: number;
  corrections: readonly Correction[];
  patterns: readonly CorrectionPattern[];
  /**
   * Detection-pipeline metadata so consumers know which stages ran.
   * When `llmClassification` is false, every correction has
   * classification === null and no patterns are emitted (clustering
   * requires distilledRule).
   */
  pipeline: {
    heuristicRecall: true;
    llmClassification: boolean;
    embeddingClustering: boolean;
    claudeMdCrossCheck: boolean;
  };
  /**
   * Identifier for the heuristic-recall ruleset that produced
   * `corrections[].signals`. Cache key for the incremental rescan in
   * `buildCorrectionsCandidatesFile` — when this changes (we add a
   * pattern family, broaden a regex), the cache invalidates and every
   * session is re-scanned. Optional for back-compat with files written
   * before the version field existed; absence is treated as cache miss.
   */
  heuristicRecallVersion?: number;
  /**
   * Session ids the most recent heuristic-recall pass actually scanned
   * (regardless of whether it produced any candidates). Required for
   * the incremental rescan to distinguish "unchanged session with zero
   * candidates" (reuse → skip transcript I/O) from "newly added
   * session" (scan). Without this, sessions whose candidate count was
   * zero get re-scanned every rescan even if they haven't changed.
   * Optional for back-compat.
   */
  scannedSessionIds?: readonly string[];
  /**
   * Aggregate funnel stats for the heuristic-recall pass. Powers the
   * viewer's expandable "PIPELINE" callout — answers "how many
   * sessions / turns / drops produced these candidates" without the
   * viewer having to re-walk transcripts. Optional for back-compat.
   */
  scanStats?: ScanStats;
  /**
   * Per-session funnel breakdown: `[rawTurns, wrapperFiltered,
   * tooLongFiltered]`. Tuple form (not object) to keep the candidates
   * file from ballooning — typical 400+ session corpus adds ~25KB.
   * Required for accurate aggregation under incremental rescans:
   * cache-hit sessions copy their prior tuple, fresh scans write a
   * new one. The top-level `scanStats` is recomputed by summing.
   */
  scanStatsBySession?: Record<string, readonly [number, number, number]>;
}

export interface ScanStats {
  /** Sessions present in the manifest at scan time. */
  sessionsInManifest: number;
  /** Sessions whose transcripts the scan actually opened. */
  sessionsScanned: number;
  /** Sessions skipped because no transcript could be read (manifest
   *  stub entries, or files that disappeared between manifest write
   *  and scan). */
  sessionsMissing: number;
  /** Sessions broken out by source string (`cli-direct`, `cowork`,
   *  `cli-desktop`, `cloud`). */
  sessionsBySource: Record<string, number>;
  /** Missing-transcript sessions broken out by source. Useful for
   *  diagnosing whether all the gaps are concentrated in one ingester. */
  sessionsMissingBySource: Record<string, number>;
  /** Total user-role turns across all scanned transcripts, BEFORE the
   *  wrapper / length filter. */
  rawUserTurns: number;
  /** User turns dropped because they began with a known wrapper prefix
   *  (`<system-reminder>`, `<bash-stdout>`, etc.). */
  wrapperFiltered: number;
  /** User turns dropped because their trimmed text exceeded 4000 chars
   *  (pasted code/files). */
  tooLongFiltered: number;
  /** User turns that survived the filter and were fed to the heuristic.
   *  = rawUserTurns - wrapperFiltered - tooLongFiltered (- empties). */
  survivingTurns: number;
}
