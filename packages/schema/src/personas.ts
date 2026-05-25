/**
 * Per-project persona sidecar shapes — V1 (feature: persona-mining).
 *
 * The persona-mining pipeline runs as SCAN chain step 5. Two artifacts
 * land under `apps/standalone/public/chat-arch-data/analysis/`:
 *
 *   - `persona-candidates.json` — Stage 1, deterministic heuristic
 *     extraction. Per-project buckets of user-prompt excerpts grouped
 *     by 6 categories (role/expertise, preferences, project-specific
 *     use, working rhythm, frictions, voice). Input to Stage 2.
 *   - `personas.json` — Stage 2 output index. One record per project
 *     in the corpus: either `generated` (markdown at the named path)
 *     or `skipped` with a reason.
 *
 * Per-project markdown lives at `analysis/personas/<project-id>.md`
 * and is rendered by the PERSONAS viewer surface. All persona files
 * are PII-bearing (verbatim user-prompt excerpts) — gitignored under
 * the existing `apps/standalone/public/chat-arch-data/*` wildcard.
 */

/** Six heuristic buckets that segment per-project user prompts. */
export type PersonaBucket =
  | 'role-expertise'
  | 'preferences'
  | 'project-specific'
  | 'working-rhythm'
  | 'frictions'
  | 'voice';

/**
 * One detected user-prompt excerpt assigned to a heuristic bucket.
 * Lightweight by design — Stage 2 (LLM) re-reads the full session
 * transcript when it needs more context than the excerpt carries.
 */
export interface PersonaCandidate {
  sessionId: string;
  /** 0-based index into the session's user turns. */
  userTurnIndex: number;
  /** Verbatim user-text excerpt (trimmed to ≤500 chars). */
  excerpt: string;
  /** Which bucket this candidate fired on. */
  bucket: PersonaBucket;
  /** Heuristic pattern key that fired (e.g. 'first-person-preference'). */
  patternKey: string;
}

/** One project's heuristic candidates + sampling metadata. */
export interface PersonaCandidateProject {
  projectId: string;
  projectName: string;
  /** Total sessions in this project (across all sources). */
  sessionsTotal: number;
  /** Sessions actually sampled for candidate extraction (≤ THRESHOLDS.persona.maxSessionsForCorpus). */
  sessionsSampled: number;
  /** Sessions that produced ≥1 candidate. */
  sessionsWithCandidates: number;
  /** Earliest sampled-session updatedAt (ms since epoch). */
  earliestSampledAt: number | null;
  /** Latest sampled-session updatedAt (ms since epoch). */
  latestSampledAt: number | null;
  /** All extracted candidates, keyed by bucket → array. */
  candidatesByBucket: Record<PersonaBucket, readonly PersonaCandidate[]>;
}

/** `analysis/persona-candidates.json` shape. */
export interface PersonaCandidatesFile {
  version: 1;
  generatedAt: number;
  heuristicVersion: number;
  thresholds: {
    minSessionsForGeneration: number;
    maxSessionsForCorpus: number;
    /** Stage-2 budget proxy. The mine-persona skill skips projects
     *  whose Stage-1 candidate count exceeds this value (V1 stand-in
     *  for the USD-cap until token-counting harness lands in V2). */
    candidateBudgetProxy: number;
    /** Per-bucket cap on candidates per project at Stage 1. */
    maxCandidatesPerBucket: number;
  };
  projects: readonly PersonaCandidateProject[];
}

/**
 * One persona record in the index. `status === 'generated'` projects
 * carry a `personaPath` (relative to `apps/standalone/public/chat-arch-
 * data/`); skipped projects carry a reason instead.
 */
export interface PersonaRecord {
  projectId: string;
  projectName: string;
  /** Sessions Stage 2 actually fed to the LLM synthesis. */
  sessionsAnalyzed: number;
  /** Sessions in the project at scan time. */
  sessionsTotal: number;
  /** Relative path to the per-project markdown, or null when skipped. */
  personaPath: string | null;
  /** ms since epoch; null when never generated. */
  generatedAt: number | null;
  status: 'generated' | 'insufficient-corpus' | 'budget-exceeded' | 'error';
  /** Free-form reason when status !== 'generated'. */
  reason?: string;
}

/** `analysis/personas.json` shape (the index over per-project records). */
export interface PersonasIndex {
  schemaVersion: 1;
  generatedAt: number;
  exporterVersion: string;
  thresholds: {
    minSessionsForGeneration: number;
    maxSessionsForCorpus: number;
    maxLlmUsdPerProject: number;
  };
  personas: readonly PersonaRecord[];
}
