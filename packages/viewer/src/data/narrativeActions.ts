import type { Narrative, Pattern } from '@chat-arch/schema';

/**
 * v2 spec §§7-9, decisions D10-D12: client-side glue for the
 * narrative-card actions (corrective-prompt + encode-as-pattern).
 *
 * The three Astro endpoints (`/api/repo-ground`, `/api/save-prompt`,
 * `/api/encode-pattern`) live on the local-tier dev server and apply
 * a CSRF gate identical to `/api/rescan` — same local-origin check
 * plus a per-endpoint X-Requested-With token. This module is the
 * single client that knows which token belongs to which path so the
 * UI doesn't have to.
 *
 * Browser-tier deploys (no Node backend) fail every probe; the
 * narrative-card UI uses `probeNarrativeActionsAvailable()` to
 * decide whether to render the action buttons enabled or as
 * "available when running locally" disabled-with-explanation.
 */

interface RepoGroundResponse {
  ok: boolean;
  repoPath: string;
  repoOk: boolean;
  gitStatus: string | null;
  gitDiff: string | null;
  fileContents: Record<string, string>;
  errors: readonly string[];
}

export interface RepoGroundedState {
  repoPath: string;
  gitStatus: string;
  gitDiff: string;
  fileContents: Record<string, string>;
  errors: readonly string[];
}

/** Probe all three endpoints with HEAD-equivalent GETs in parallel. */
export async function probeNarrativeActionsAvailable(): Promise<boolean> {
  try {
    const results = await Promise.all(
      ['/api/repo-ground', '/api/save-prompt', '/api/encode-pattern'].map((url) =>
        fetch(url, { method: 'GET' }).then((r) => r.ok).catch(() => false),
      ),
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}

export async function fetchRepoGround(
  options: { repoPath?: string; namedFiles?: readonly string[] } = {},
): Promise<RepoGroundedState> {
  const res = await fetch('/api/repo-ground', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'chat-arch-repo-ground',
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      ...(options.repoPath ? { repoPath: options.repoPath } : {}),
      ...(options.namedFiles ? { namedFiles: options.namedFiles } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/repo-ground HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  const body = (await res.json()) as RepoGroundResponse;
  if (!body.repoOk) {
    throw new Error(body.errors[0] ?? `repo not grounded at ${body.repoPath}`);
  }
  return {
    repoPath: body.repoPath,
    gitStatus: body.gitStatus ?? '',
    gitDiff: body.gitDiff ?? '',
    fileContents: body.fileContents,
    errors: body.errors,
  };
}

/**
 * Mechanically assemble a corrective prompt body from a narrative +
 * grounded repo state. No LLM — strictly heuristic per spec §15 /
 * decision D7. Format optimized for paste into a fresh Claude Code
 * session: short context preamble, evidence pointers as anchors, then
 * the grounded repo snapshot as a fenced block.
 */
export function buildCorrectivePromptBody(
  narrative: Narrative,
  ground: RepoGroundedState,
): string {
  const evidenceLines = narrative.evidence
    .map((e, ix) => `${ix + 1}. session \`${e.sessionId}\`${e.excerpt ? ` — ${e.excerpt}` : ''}`)
    .join('\n');
  const namedSection = Object.keys(ground.fileContents).length
    ? Object.entries(ground.fileContents)
        .map(
          ([rel, text]) =>
            `### ${rel}\n\n\`\`\`\n${text.length > 4000 ? text.slice(0, 4000) + '\n… (truncated)' : text}\n\`\`\``,
        )
        .join('\n\n')
    : '_(no named files)_';
  return [
    `# Corrective prompt — ${narrative.title}`,
    '',
    `_Generated from chat-arch narrative \`${narrative.id}\` (project \`${narrative.projectId}\`, sentiment ${narrative.sentiment})._`,
    '',
    '## Context',
    '',
    narrative.body || '_(no narrative body)_',
    '',
    '## Evidence',
    '',
    evidenceLines || '_(no evidence)_',
    '',
    '## Repo state at generation',
    '',
    `**Repo:** \`${ground.repoPath}\``,
    '',
    '### `git status`',
    '',
    '```',
    ground.gitStatus.trim() || '(working tree clean)',
    '```',
    '',
    '### `git diff` (working tree)',
    '',
    '```',
    ground.gitDiff.trim() || '(no diff)',
    '```',
    '',
    '## Named files',
    '',
    namedSection,
    '',
    '---',
    '',
    'Use this context to adjust your approach in the next session.',
    '',
  ].join('\n');
}

export async function savePrompt(narrativeId: string, content: string): Promise<string> {
  const res = await fetch('/api/save-prompt', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'chat-arch-save-prompt',
    },
    credentials: 'same-origin',
    body: JSON.stringify({ narrativeId, content }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/save-prompt HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  const body = (await res.json()) as { ok: boolean; path: string };
  return body.path;
}

export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('clipboard API not available');
  }
  await navigator.clipboard.writeText(text);
}

export interface EncodePatternResult {
  sidecarPath: string;
  patternsCount: number;
  claudeMdAppended: boolean;
  claudeMdPath?: string;
  errors: readonly string[];
}

export async function encodePattern(
  pattern: Pattern,
  options: { projectPath?: string; claudeMdMarkdown?: string } = {},
): Promise<EncodePatternResult> {
  const res = await fetch('/api/encode-pattern', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'chat-arch-encode-pattern',
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      pattern,
      ...(options.projectPath ? { projectPath: options.projectPath } : {}),
      ...(options.claudeMdMarkdown ? { claudeMdMarkdown: options.claudeMdMarkdown } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/api/encode-pattern HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  const body = (await res.json()) as {
    ok: boolean;
    sidecarPath: string;
    patternsCount: number;
    claudeMdAppended?: boolean;
    claudeMdPath?: string;
    errors: string[];
  };
  return {
    sidecarPath: body.sidecarPath,
    patternsCount: body.patternsCount,
    claudeMdAppended: !!body.claudeMdAppended,
    ...(body.claudeMdPath ? { claudeMdPath: body.claudeMdPath } : {}),
    errors: body.errors,
  };
}

/**
 * Build a `Pattern` from a `Narrative` for the encode-as-pattern flow.
 *
 * Rev3-E E3 — the `falsifierOverride` option records the user's
 * explicit decision to skip the future falsifier check. The flag maps
 * to `falsifierStatus: 'skipped-by-user'` (the auditable bypass
 * sentinel). When `false` / omitted, `falsifierStatus` is left
 * undefined — the Rev3-F falsifier skill populates it on the next
 * encode pass (target: `'verified'`; or `'unavailable'` if the
 * `claude` CLI is missing / sandboxed).
 *
 * Default falsifier-gating per plan §Phase Rev3-E: the user does NOT
 * opt in to a value here; the absence of `falsifierStatus` means
 * "not yet falsified" rather than "explicitly skipped." That
 * distinction is load-bearing for the D3 audit-style surfaces and
 * the Rev3-F falsifier wiring.
 */
export function buildPatternFromNarrative(
  narrative: Narrative,
  appendedToClaudeMd: boolean,
  options: { falsifierOverride?: boolean } = {},
): Pattern {
  const base: Pattern = {
    id: `pattern_${narrative.id}`,
    sourceNarrativeId: narrative.id,
    projectId: narrative.projectId,
    title: narrative.title,
    body: narrative.body,
    encodedAt: new Date().toISOString(),
    appendedToClaudeMd,
  };
  if (options.falsifierOverride === true) {
    return { ...base, falsifierStatus: 'skipped-by-user' };
  }
  return base;
}

export function buildClaudeMdMarkdown(narrative: Narrative): string {
  return [
    `## Pattern: ${narrative.title}`,
    '',
    `_Encoded from chat-arch narrative \`${narrative.id}\` on ${new Date().toISOString().slice(0, 10)}._`,
    '',
    narrative.body || '_(no narrative body — see chat-arch viewer for evidence)_',
    '',
  ].join('\n');
}
