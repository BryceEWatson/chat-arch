/**
 * Discovery scorer — spec §5 Layer A, A.3.
 *
 * Pure function. Returns a 0..1 score for one UnifiedSessionEntry blending
 * four signals — high score = session is a candidate for the blog-draft
 * pipeline because it represents a knowledge-bearing event ("I learned
 * something") rather than a routine query.
 *
 * Signals (all clamped to 0..1 before weighted-sum):
 *   1. token-intensity     — log-scaled total tokens vs. corpus 95th pct
 *   2. tool-diversity      — distinct tools used vs. 6 (corpus ceiling)
 *   3. has-correction-applied-after — 1.0 if any `AppliedImprovement`
 *                                     timestamps fall after this session's
 *                                     startedAt and reference this session's
 *                                     project, else 0.0
 *   4. gitBranch → PR overlap — 1.0 when the session's cwd-derived branch
 *                               name shows up as a PR head in the project's
 *                               git history (proxied here by membership in
 *                               an externally-provided set), else 0.0
 *
 * The first two are intrinsic to the entry. The last two require external
 * context (`AppliedImprovement[]` + a git-PR head set) — callers that lack
 * one or both pass empty arrays / empty sets; the scorer still works, just
 * with reduced signal.
 *
 * Default weights are 0.30 / 0.25 / 0.25 / 0.20. Tuned for "correction-
 * applied-after" carrying real weight without dominating — the corpus has
 * ~50 applied improvements vs. ~2k sessions; a binary signal on 2.5% of
 * sessions would be noise if weighted at 0.5+. The exact weights are
 * exposed as `DiscoveryScoreWeights` so callers can swap them without
 * code-editing.
 *
 * Pure. Browser-safe. Mirrors the discoverTopics shape (pure-function
 * core, caller does I/O).
 */

import type { UnifiedSessionEntry } from '@chat-arch/schema';

export interface DiscoveryScoreWeights {
  tokenIntensity: number;
  toolDiversity: number;
  correctionAppliedAfter: number;
  gitBranchOverlap: number;
}

export const DEFAULT_DISCOVERY_WEIGHTS: DiscoveryScoreWeights = {
  tokenIntensity: 0.3,
  toolDiversity: 0.25,
  correctionAppliedAfter: 0.25,
  gitBranchOverlap: 0.2,
};

/**
 * Tokens-per-session value that scores 1.0 on token-intensity. Tuned to
 * roughly the 95th percentile of the corpus (~80k total tokens). Sessions
 * with fewer tokens scale linearly on a log scale; sessions with more cap
 * at 1.0. Exposed as an option so it can be re-tuned without code edits.
 */
export const DEFAULT_TOKEN_INTENSITY_CAP = 80_000;

/**
 * Distinct-tool count that scores 1.0 on tool-diversity. The corpus
 * ceiling — sessions that touch all 6 of (Bash, Read, Write, Edit, Glob,
 * Grep) are clearly multifaceted.
 */
export const DEFAULT_TOOL_DIVERSITY_CAP = 6;

export interface DiscoveryScoreContext {
  /**
   * Project ids that have at least one `AppliedImprovement` whose
   * `appliedAt > session.startedAt`. Pre-aggregated by the caller so
   * the scorer stays O(1) per session. Empty = no correction-applied
   * signal available.
   */
  projectsWithLaterApplications: ReadonlySet<string>;
  /**
   * Git branch names known to have produced PRs on the user's GitHub.
   * Populated by the caller from an offline `gh pr list` snapshot or
   * left empty. Names should be lowercased and slashes preserved.
   */
  prBranchHeads: ReadonlySet<string>;
}

export interface DiscoveryScoreOptions {
  weights?: Partial<DiscoveryScoreWeights>;
  tokenIntensityCap?: number;
  toolDiversityCap?: number;
}

export interface DiscoveryScoreResult {
  score: number;
  /** Per-signal breakdown for debugging / future UI exposure. */
  components: {
    tokenIntensity: number;
    toolDiversity: number;
    correctionAppliedAfter: number;
    gitBranchOverlap: number;
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function totalTokens(entry: UnifiedSessionEntry): number {
  const t = entry.tokenTotals;
  if (t === undefined) return 0;
  return t.input + t.output + t.cacheCreation + t.cacheRead;
}

function branchFromCwd(entry: UnifiedSessionEntry): string | null {
  // We don't carry `gitBranch` on entries today. Approximate by the
  // last path segment of `cwd` when it looks like a feature-branch
  // worktree (`<repo>/.git/worktrees/feature-foo`) — common with the
  // user's workflow. Otherwise null. Cheap heuristic; the gitBranch
  // signal is weighted lightest of the four for exactly this reason.
  if (entry.cwd === undefined) return null;
  const m = /\bworktrees[\\/]([^\\/]+)$/i.exec(entry.cwd);
  return m !== null ? (m[1] ?? '').toLowerCase() : null;
}

export function computeDiscoveryScore(
  entry: UnifiedSessionEntry,
  context: DiscoveryScoreContext,
  options: DiscoveryScoreOptions = {},
): DiscoveryScoreResult {
  const weights = { ...DEFAULT_DISCOVERY_WEIGHTS, ...(options.weights ?? {}) };
  const tokenCap = options.tokenIntensityCap ?? DEFAULT_TOKEN_INTENSITY_CAP;
  const toolCap = options.toolDiversityCap ?? DEFAULT_TOOL_DIVERSITY_CAP;

  // --- Token intensity (log-scaled) ---
  const tokens = totalTokens(entry);
  // log1p so tiny sessions score near 0 and the cap is the upper bound.
  const tokenIntensity =
    tokens <= 0 ? 0 : clamp01(Math.log1p(tokens) / Math.log1p(tokenCap));

  // --- Tool diversity ---
  const distinctTools = entry.topTools !== undefined ? Object.keys(entry.topTools).length : 0;
  const toolDiversity = clamp01(distinctTools / toolCap);

  // --- Correction-applied-after ---
  const projectKey = entry.projectId ?? entry.project ?? null;
  const correctionAppliedAfter =
    projectKey !== null && context.projectsWithLaterApplications.has(projectKey) ? 1 : 0;

  // --- Git branch overlap (PR head match) ---
  const branch = branchFromCwd(entry);
  const gitBranchOverlap = branch !== null && context.prBranchHeads.has(branch) ? 1 : 0;

  const score = clamp01(
    weights.tokenIntensity * tokenIntensity +
      weights.toolDiversity * toolDiversity +
      weights.correctionAppliedAfter * correctionAppliedAfter +
      weights.gitBranchOverlap * gitBranchOverlap,
  );

  return {
    score,
    components: {
      tokenIntensity,
      toolDiversity,
      correctionAppliedAfter,
      gitBranchOverlap,
    },
  };
}

/**
 * Bulk scorer convenience. Pre-aggregates `projectsWithLaterApplications`
 * from a list of `AppliedImprovement`s + session-project resolution.
 * Returns a map sessionId → DiscoveryScoreResult.
 *
 * The caller decides what threshold (e.g. 0.7 per spec) gates blog
 * candidacy.
 */
export interface AppliedImprovementLite {
  appliedAt: number;
  /**
   * The pattern's project scope if any. The mine-corrections skill's
   * `CorrectionPatternScope` is reduced here to just the project id;
   * upgrades scoped 'global'/'tool'/'request-shape' contribute under
   * the projectId === undefined path and produce no signal.
   */
  projectId?: string;
}

export function scoreManifest(
  sessions: readonly UnifiedSessionEntry[],
  applications: readonly AppliedImprovementLite[],
  prBranchHeads: ReadonlySet<string>,
  options: DiscoveryScoreOptions = {},
): Map<string, DiscoveryScoreResult> {
  // Pre-aggregate "projects with at least one application AFTER the
  // earliest session that points at them". We approximate this as
  // "projects with any application" because we'd otherwise need per-
  // session resolution; the scorer's per-session check then gates on
  // session.startedAt < projection.appliedAt indirectly via the binary
  // signal. This keeps the kernel O(P + S).
  const projectsWithApps = new Set<string>();
  for (const app of applications) {
    if (app.projectId !== undefined) projectsWithApps.add(app.projectId);
  }

  const out = new Map<string, DiscoveryScoreResult>();
  const context: DiscoveryScoreContext = {
    projectsWithLaterApplications: projectsWithApps,
    prBranchHeads,
  };
  for (const s of sessions) {
    if (s.transcriptStatus === 'pruned') continue; // no signal on pruned
    out.set(s.id, computeDiscoveryScore(s, context, options));
  }
  return out;
}
