import type { UnifiedSessionEntry, Project, Narrative } from '@chat-arch/schema';
import type { ZombieProject } from '../components/constellation/ZombieProjectCard.js';
import type { MergedDuplicateCluster } from './mergeDuplicates.js';

// Audit consumes whichever cluster shape the viewer has handy — the
// merged variant is structurally a superset of the analysis package's
// `DuplicateCluster`, and we only read `sessionIds` here so the
// stricter merged type is fine.
type DuplicateCluster = MergedDuplicateCluster;

/**
 * v2 spec §5.4 / decision D13: PRACTICE four-lens audit.
 *
 *   1. YOUR PATTERNS    — recurring approaches in how the user works.
 *   2. AGENT PATTERNS   — how Claude responds (helpful + failure modes).
 *   3. PROCESS GAPS     — what's missing in the workflow.
 *   4. VALUE LEAKS      — where time/effort/cost is being lost.
 *
 * Single pass over the shared inputs (sessions + projects +
 * narratives + the existing duplicates/zombies analysis kernel
 * outputs + cost data on each session). Outputs are heuristic and
 * pure — no LLM, no embeddings, browser-safe.
 *
 * Heuristics here are intentionally cautious: we'd rather emit too
 * few findings (and have the user wonder why) than too many (turning
 * the surface into noise). Each finding carries an `evidence[]` so
 * the user can verify by clicking through to the underlying
 * sessions / projects / clusters.
 */

export type Lens = 'your-patterns' | 'agent-patterns' | 'process-gaps' | 'value-leaks';

export type Severity = 'info' | 'warn' | 'alert';

export interface PracticeEvidence {
  kind: 'session' | 'project' | 'cluster' | 'narrative';
  id: string;
  label?: string;
}

export interface PracticeFinding {
  lens: Lens;
  /** Stable id so the UI can `key={}` and the user can deep-link via hash later. */
  id: string;
  title: string;
  body: string;
  severity: Severity;
  evidence: readonly PracticeEvidence[];
}

export interface PracticeAuditInput {
  sessions: readonly UnifiedSessionEntry[];
  projects: readonly Project[];
  narratives: readonly Narrative[];
  duplicateClusters: readonly DuplicateCluster[];
  zombieProjects: readonly ZombieProject[];
}

export interface PracticeAuditResult {
  generatedAt: number;
  findings: readonly PracticeFinding[];
}

/** Threshold knobs — tuned conservatively. See module docstring. */
const VALUE_LEAK_DUP_THRESHOLD = 3;
const TOP_COST_OUTLIERS = 5;
const TURN_OUTLIER_MIN = 50;

function topNByCost(
  sessions: readonly UnifiedSessionEntry[],
  n: number,
): readonly UnifiedSessionEntry[] {
  return [...sessions]
    .filter((s) => typeof s.totalCostUsd === 'number' || typeof s.costEstimatedUsd === 'number')
    .sort((a, b) => {
      const ac = (a.totalCostUsd ?? a.costEstimatedUsd ?? 0) as number;
      const bc = (b.totalCostUsd ?? b.costEstimatedUsd ?? 0) as number;
      return bc - ac;
    })
    .slice(0, n);
}

function topToolCounts(
  sessions: readonly UnifiedSessionEntry[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (!s.topTools) continue;
    for (const [name, n] of Object.entries(s.topTools)) {
      counts.set(name, (counts.get(name) ?? 0) + (n ?? 0));
    }
  }
  return counts;
}

function detectAgentPatterns(
  sessions: readonly UnifiedSessionEntry[],
): readonly PracticeFinding[] {
  const findings: PracticeFinding[] = [];
  const tools = topToolCounts(sessions);
  // Top-3 tool calls become a "Claude leans on these" finding when the
  // top tool clears 100 calls — below that the data's too thin to be
  // a pattern.
  const sorted = [...tools.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0 && sorted[0]![1] >= 100) {
    const top3 = sorted.slice(0, 3);
    findings.push({
      lens: 'agent-patterns',
      id: 'agent-top-tools',
      title: `Claude leans on ${top3[0]![0]}`,
      body: `Across the corpus, Claude's top tools are: ${top3.map(([n, c]) => `\`${n}\` × ${c}`).join(', ')}. This is a behavioral pattern, not a problem — but it's worth knowing which tools your sessions exercise most.`,
      severity: 'info',
      evidence: [],
    });
  }
  return findings;
}

function detectYourPatterns(
  sessions: readonly UnifiedSessionEntry[],
  projects: readonly Project[],
): readonly PracticeFinding[] {
  const findings: PracticeFinding[] = [];
  // Project breadth: when one project dominates the corpus (> 40% of
  // sessions), call it out as a "you spend most of your time here"
  // pattern. Useful self-knowledge for the user's planning.
  const total = sessions.length || 1;
  const dominant = projects
    .filter((p) => p.id !== '__unassigned__')
    .map((p) => ({ project: p, share: p.sessionIds.length / total }))
    .sort((a, b) => b.share - a.share)[0];
  if (dominant && dominant.share > 0.4) {
    findings.push({
      lens: 'your-patterns',
      id: 'your-dominant-project',
      title: `${(dominant.share * 100).toFixed(0)}% of your sessions sit in ${dominant.project.displayName}`,
      body: `One project dominates the corpus. That can be focus, or it can be tunnel vision — worth a sanity check against your other commitments.`,
      severity: 'info',
      evidence: [{ kind: 'project', id: dominant.project.id, label: dominant.project.displayName }],
    });
  }
  return findings;
}

function detectProcessGaps(
  sessions: readonly UnifiedSessionEntry[],
  narratives: readonly Narrative[],
): readonly PracticeFinding[] {
  const findings: PracticeFinding[] = [];
  // Sessions with no preview AND no recorded turns suggest aborted
  // starts that didn't finish — a process gap if it's a recurring
  // pattern (>= 5% of the corpus).
  const aborted = sessions.filter(
    (s) => (s.userTurns ?? 0) === 0 && (s.assistantTurns ?? 0) === 0,
  );
  if (aborted.length > 0 && aborted.length / sessions.length >= 0.05) {
    findings.push({
      lens: 'process-gaps',
      id: 'process-aborted-starts',
      title: `${aborted.length} sessions ended before any turn was logged`,
      body: `Sessions that close without a recorded user/assistant turn are usually accidental starts — a window opened then closed, a wrong-project drill-in. They're worth filtering out of cost / time analyses.`,
      severity: 'warn',
      evidence: aborted.slice(0, 5).map((s) => ({
        kind: 'session' as const,
        id: s.id,
        ...(s.title ? { label: s.title } : {}),
      })),
    });
  }
  // Negative narratives that the user hasn't acted on (no encoded
  // pattern derived from a sibling positive narrative, no corrective
  // prompt saved). Heuristic for v2.0: flag every negative narrative
  // as "still open" since we don't yet track action state.
  const negativeNarratives = narratives.filter((n) => n.sentiment === 'negative');
  if (negativeNarratives.length > 0) {
    findings.push({
      lens: 'process-gaps',
      id: 'process-open-negative-narratives',
      title: `${negativeNarratives.length} negative narrative${negativeNarratives.length === 1 ? '' : 's'} awaiting a corrective prompt`,
      body: `Each negative narrative represents a recurring failure mode in a project. Generating the corrective prompt and pasting it into the next session in that repo is the v2 way to close the loop (spec §8).`,
      severity: 'warn',
      evidence: negativeNarratives.slice(0, 5).map((n) => ({
        kind: 'narrative' as const,
        id: n.id,
        label: n.title,
      })),
    });
  }
  return findings;
}

function detectValueLeaks(
  sessions: readonly UnifiedSessionEntry[],
  duplicateClusters: readonly DuplicateCluster[],
  zombieProjects: readonly ZombieProject[],
): readonly PracticeFinding[] {
  const findings: PracticeFinding[] = [];

  // Big duplicate clusters → wasted re-asks.
  const bigDups = duplicateClusters.filter(
    (c) => c.sessionIds.length >= VALUE_LEAK_DUP_THRESHOLD,
  );
  if (bigDups.length > 0) {
    findings.push({
      lens: 'value-leaks',
      id: 'value-duplicate-clusters',
      title: `${bigDups.length} duplicate cluster${bigDups.length === 1 ? '' : 's'} of ≥ ${VALUE_LEAK_DUP_THRESHOLD} sessions`,
      body: `When the same prompt body recurs, you're either retrying without context, restarting an aborted session, or rebuilding a workflow you already had. Deduplicating these earns time back across all four lenses.`,
      severity: 'warn',
      evidence: bigDups.slice(0, 5).map((c) => ({
        kind: 'cluster' as const,
        id: c.id,
        label: `${c.sessionIds.length} sessions`,
      })),
    });
  }

  // Active zombie projects (status = 'zombie' per heuristic).
  const zombies = zombieProjects.filter((z) => z.classification === 'zombie');
  if (zombies.length > 0) {
    findings.push({
      lens: 'value-leaks',
      id: 'value-zombie-projects',
      title: `${zombies.length} project${zombies.length === 1 ? '' : 's'} classified zombie`,
      body: `A zombie project is one where activity died without a clear close-out. Each one is either ready to be archived or due for a deliberate revive — both are better than the in-between state.`,
      severity: 'alert',
      evidence: zombies.slice(0, 5).map((z) => ({
        kind: 'project' as const,
        id: z.id,
        label: z.displayName,
      })),
    });
  }

  // Cost outliers — top 5 by cost. Useful for spotting runaway loops.
  const costTop = topNByCost(sessions, TOP_COST_OUTLIERS);
  if (costTop.length > 0) {
    const total = costTop.reduce(
      (acc, s) => acc + (s.totalCostUsd ?? s.costEstimatedUsd ?? 0),
      0,
    );
    findings.push({
      lens: 'value-leaks',
      id: 'value-cost-outliers',
      title: `Top ${costTop.length} sessions by cost: $${total.toFixed(2)}`,
      body: `These sessions burned the most spend. Each one is worth a 30-second look — was the work proportional to the cost, or did a loop run away?`,
      severity: 'info',
      evidence: costTop.map((s) => ({
        kind: 'session' as const,
        id: s.id,
        ...(s.title ? { label: s.title } : {}),
      })),
    });
  }

  // Turn-count outliers — sessions over TURN_OUTLIER_MIN turns suggest
  // a marathon that may have hidden a stuck loop.
  const turnOutliers = sessions
    .filter((s) => ((s.userTurns ?? 0) + (s.assistantTurns ?? 0)) >= TURN_OUTLIER_MIN)
    .sort(
      (a, b) =>
        (b.userTurns ?? 0) +
        (b.assistantTurns ?? 0) -
        ((a.userTurns ?? 0) + (a.assistantTurns ?? 0)),
    );
  if (turnOutliers.length > 0) {
    findings.push({
      lens: 'value-leaks',
      id: 'value-turn-outliers',
      title: `${turnOutliers.length} session${turnOutliers.length === 1 ? '' : 's'} above ${TURN_OUTLIER_MIN} turns`,
      body: `Long sessions are sometimes legitimate, but a turn count above ${TURN_OUTLIER_MIN} is often the signature of a stuck loop the user wasn't aware of. Skim the top few.`,
      severity: 'warn',
      evidence: turnOutliers.slice(0, 5).map((s) => ({
        kind: 'session' as const,
        id: s.id,
        ...(s.title ? { label: s.title } : {}),
      })),
    });
  }

  return findings;
}

export function runPracticeAudit(input: PracticeAuditInput): PracticeAuditResult {
  const findings: PracticeFinding[] = [];
  findings.push(...detectYourPatterns(input.sessions, input.projects));
  findings.push(...detectAgentPatterns(input.sessions));
  findings.push(...detectProcessGaps(input.sessions, input.narratives));
  findings.push(...detectValueLeaks(input.sessions, input.duplicateClusters, input.zombieProjects));
  return { generatedAt: Date.now(), findings };
}

export const LENS_LABEL: Record<Lens, string> = {
  'your-patterns': 'YOUR PATTERNS',
  'agent-patterns': 'AGENT PATTERNS',
  'process-gaps': 'PROCESS GAPS',
  'value-leaks': 'VALUE LEAKS',
};

export const LENS_BLURB: Record<Lens, string> = {
  'your-patterns': 'How you work — recurring approaches and decision shapes.',
  'agent-patterns': 'How Claude responds — modes, failures, helpful behaviors.',
  'process-gaps': 'What is missing in the workflow — verification, artifacts, follow-through.',
  'value-leaks': 'Where time, effort, or cost is being lost — duplicates, zombies, runaway loops.',
};
