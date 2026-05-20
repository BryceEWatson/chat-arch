/**
 * Auto-generated post-mortem markdown for top-quintile sessions (#12).
 *
 * Pure function — takes a session, its composite outcome record, the
 * decisions extracted in Phase 2, and optional review signals, and
 * returns a `{ path, frontmatter, body }` triple. The caller (the
 * viewer's export panel in Wave 4, or a CLI) is responsible for
 * writing the file and updating the export manifest.
 *
 * Eligibility filter (matches plan §Phase 4 #12):
 *   - composite-percentile in top quintile (≥ 0.80)
 *   - ≥ 1 actionable decision attached to the session
 *   - session has a `project` (proxies "clear single-project scope")
 *   - landed PR is preferred but optional; absent rows still qualify
 *     when the percentile + decision gates are met
 *
 * LLM templating is invoked via `claude -p` subprocess (the user
 * prefers plan usage over API spend per session memory). The
 * subprocess call is wrapped in `summarize()`; tests inject a stub
 * via the `runLlm` option so the generator stays deterministic.
 *
 * Manual-trigger only — no auto-publish. Output lives at
 * `chat-arch-data/exports/post-mortems/<session-id>.md`.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type {
  CompositeOutcome,
  Decision,
  UnifiedSessionEntry,
} from '@chat-arch/schema';
import {
  serializeFrontmatter,
  type FrontmatterObject,
} from './obsidianFrontmatter.js';

/** Composite percentile (0..1) at which a session is "top quintile". */
export const POST_MORTEM_PERCENTILE_FLOOR = 0.8;

/**
 * Optional review signals (Phase 2 #13). When present the post-mortem
 * surfaces a "Review feedback" section.
 */
export interface PostMortemReviewSignals {
  prNumber?: number;
  reviewSubstantiveCount?: number;
  reviewNitCount?: number;
  reviewIterations?: number;
  timeToMergeMs?: number;
}

export interface PostMortemEligibilityInputs {
  session: UnifiedSessionEntry;
  composite: CompositeOutcome;
  decisions: readonly Decision[];
  /** Composite percentile in [0, 1]; computed by the caller. */
  outcomePercentile: number;
}

export interface PostMortemGenerateInputs extends PostMortemEligibilityInputs {
  reviewSignals?: PostMortemReviewSignals;
  /** Override for tests; defaults to `summarizeViaClaudeCli`. */
  runLlm?: (prompt: string) => string;
  /** Override `Date.now()` for deterministic tests. */
  now?: number;
}

export interface PostMortemDocument {
  /** Path relative to `chat-arch-data/`. */
  path: string;
  /** Parsed frontmatter (the structure the viewer reads). */
  frontmatter: FrontmatterObject;
  /** Full file body — frontmatter block + markdown sections. */
  body: string;
}

export interface PostMortemEligibility {
  eligible: boolean;
  reasons: readonly string[];
}

/**
 * Apply the eligibility filter. Returns `{ eligible: false, reasons }`
 * with a structured-rejection list so the caller (and the audit log)
 * can show why a session was skipped.
 */
export function checkEligibility(
  inputs: PostMortemEligibilityInputs,
): PostMortemEligibility {
  const reasons: string[] = [];
  if (inputs.outcomePercentile < POST_MORTEM_PERCENTILE_FLOOR) {
    reasons.push(`percentile ${inputs.outcomePercentile.toFixed(2)} < ${POST_MORTEM_PERCENTILE_FLOOR}`);
  }
  const actionableDecisions = inputs.decisions.filter(
    d => d.classification?.actionable === true,
  );
  if (actionableDecisions.length < 1) {
    reasons.push('no actionable decisions');
  }
  if (!inputs.session.project) {
    reasons.push('no single-project scope');
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Build the markdown body. Pure — no I/O, no LLM call.
 *
 * Sections (Obsidian-flavored):
 *   1. H1 title
 *   2. Outcome panel (callout) — composite score, percentile, binary
 *   3. Decisions table — per-decision row
 *   4. LLM summary placeholder (the caller injects the LLM result here)
 *   5. Review feedback section (optional)
 *   6. Session footer — startedAt, project, source
 */
export function renderPostMortemBody(
  inputs: PostMortemGenerateInputs,
  llmSummary: string,
): string {
  const { session, composite, decisions, reviewSignals, outcomePercentile } = inputs;
  const actionable = decisions.filter(d => d.classification?.actionable === true);
  const lines: string[] = [];

  lines.push(`# Post-mortem: ${session.title}`);
  lines.push('');
  lines.push('> [!summary] Outcome');
  lines.push(`> - Composite score: **${composite.score.toFixed(3)}** (${composite.binary})`);
  lines.push(`> - Percentile: **${(outcomePercentile * 100).toFixed(0)}th**`);
  lines.push(`> - Test pass: ${formatTriBool(composite.testPass)} · Build pass: ${formatTriBool(composite.buildPass)} · PR: ${composite.prLand ?? 'none'}`);
  lines.push('');

  lines.push('## Decisions');
  lines.push('');
  if (actionable.length === 0) {
    lines.push('_No actionable decisions extracted._');
  } else {
    lines.push('| Kind | Chosen | Rejected | Confidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of actionable) {
      const c = d.classification!;
      lines.push(
        `| ${c.kind} | ${escapeCell(c.chosen.join('; '))} | ${escapeCell(c.rejected.join('; '))} | ${c.confidence.toFixed(2)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(llmSummary.trim() || '_LLM summary unavailable._');
  lines.push('');

  if (reviewSignals && hasReviewContent(reviewSignals)) {
    lines.push('## Review feedback');
    lines.push('');
    if (reviewSignals.prNumber !== undefined) lines.push(`- PR: #${reviewSignals.prNumber}`);
    if (reviewSignals.reviewSubstantiveCount !== undefined) {
      lines.push(`- Substantive comments: ${reviewSignals.reviewSubstantiveCount}`);
    }
    if (reviewSignals.reviewNitCount !== undefined) {
      lines.push(`- Nit comments: ${reviewSignals.reviewNitCount}`);
    }
    if (reviewSignals.reviewIterations !== undefined) {
      lines.push(`- Review iterations: ${reviewSignals.reviewIterations}`);
    }
    if (reviewSignals.timeToMergeMs !== undefined) {
      lines.push(`- Time-to-merge: ${formatDuration(reviewSignals.timeToMergeMs)}`);
    }
    lines.push('');
  }

  lines.push('## Session');
  lines.push('');
  lines.push(`- Started: ${new Date(session.startedAt).toISOString()}`);
  if (session.project) lines.push(`- Project: ${session.project}`);
  lines.push(`- Source: ${session.source}`);
  lines.push(`- Session id: \`${session.id}\``);
  lines.push('');

  return lines.join('\n');
}

/**
 * Build the frontmatter block. Tags pinned to `[post-mortem]`; aliases
 * empty for the user to populate. Outcome percentile rounded to 2 dp
 * for stable YAML.
 */
export function buildPostMortemFrontmatter(
  inputs: PostMortemGenerateInputs,
): FrontmatterObject {
  const nowMs = inputs.now ?? Date.now();
  const fm: Record<string, FrontmatterObject[keyof FrontmatterObject]> = {
    tags: ['post-mortem'],
    aliases: [],
    created: new Date(nowMs).toISOString(),
    session: inputs.session.id,
    'outcome-percentile': Number(inputs.outcomePercentile.toFixed(2)),
    'composite-score': Number(inputs.composite.score.toFixed(3)),
    'composite-binary': inputs.composite.binary,
  };
  if (inputs.session.project) fm.project = inputs.session.project;
  if (inputs.reviewSignals?.prNumber !== undefined) {
    fm['pr-number'] = inputs.reviewSignals.prNumber;
  }
  return fm as FrontmatterObject;
}

/**
 * Main entrypoint. Composes frontmatter + body + path.
 *
 * Throws when called on an ineligible session — callers must
 * `checkEligibility` first or the throw will surface to the export
 * pipeline (intentional: silent skip would mask filter regressions).
 */
export function generatePostMortem(inputs: PostMortemGenerateInputs): PostMortemDocument {
  const eligibility = checkEligibility(inputs);
  if (!eligibility.eligible) {
    throw new Error(
      `generatePostMortem: session ${inputs.session.id} ineligible (${eligibility.reasons.join('; ')})`,
    );
  }
  const llm = inputs.runLlm ?? summarizeViaClaudeCli;
  const prompt = buildSummaryPrompt(inputs);
  let summary: string;
  try { summary = llm(prompt); }
  catch (e) {
    // Degrade gracefully — emit a stub the user can edit later. The
    // composite/decision structure is the load-bearing part; the
    // narrative summary is glaze.
    summary = `_LLM summary unavailable: ${e instanceof Error ? e.message : String(e)}._`;
  }
  const frontmatter = buildPostMortemFrontmatter(inputs);
  const body = serializeFrontmatter(frontmatter) + renderPostMortemBody(inputs, summary);
  return {
    path: path.posix.join('exports', 'post-mortems', `${inputs.session.id}.md`),
    frontmatter,
    body,
  };
}

/**
 * Build the LLM prompt. Kept small and structured so we can cache the
 * `claude -p` invocation; the prompt is fully derived from on-disk
 * data, no transcript text included (the post-mortem is a SUMMARY of
 * structured signals, not a re-tell of the whole conversation).
 */
export function buildSummaryPrompt(inputs: PostMortemGenerateInputs): string {
  const { session, composite, decisions } = inputs;
  const actionable = decisions
    .filter(d => d.classification?.actionable === true)
    .map(d => ({
      kind: d.classification!.kind,
      chosen: d.classification!.chosen,
      rejected: d.classification!.rejected,
      decision: d.classification!.distilledDecision,
    }));
  return [
    'You are writing a brief post-mortem summary for a software-engineering session.',
    'Format: 2-4 short paragraphs. No headings. No code blocks.',
    'Focus on: what was decided, what worked, what to repeat next time.',
    '',
    'Session metadata:',
    `- Title: ${session.title}`,
    `- Project: ${session.project ?? 'unspecified'}`,
    `- Composite score: ${composite.score.toFixed(3)} (${composite.binary})`,
    `- Test pass: ${formatTriBool(composite.testPass)}`,
    `- Build pass: ${formatTriBool(composite.buildPass)}`,
    `- PR landing: ${composite.prLand ?? 'none'}`,
    '',
    'Decisions:',
    JSON.stringify(actionable, null, 2),
  ].join('\n');
}

/**
 * Invoke `claude -p <prompt>` as a subprocess and return its stdout.
 * Per the user's stated preference (Claude Code plan usage over API
 * spend), the post-mortem summary path uses the local CLI rather than
 * the Anthropic SDK directly.
 *
 * Throws on non-zero exit so the caller's catch-and-degrade path runs.
 */
export function summarizeViaClaudeCli(prompt: string): string {
  const r = spawnSync('claude', ['-p', prompt], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (typeof r.status === 'number' && r.status !== 0) {
    throw new Error(`claude -p exited ${r.status}: ${r.stderr ?? ''}`);
  }
  return (r.stdout ?? '').trim();
}

// ---- helpers ----

function formatTriBool(v: boolean | null): string {
  if (v === null) return 'n/a';
  return v ? 'yes' : 'no';
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function hasReviewContent(r: PostMortemReviewSignals): boolean {
  return (
    r.prNumber !== undefined ||
    r.reviewSubstantiveCount !== undefined ||
    r.reviewNitCount !== undefined ||
    r.reviewIterations !== undefined ||
    r.timeToMergeMs !== undefined
  );
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
