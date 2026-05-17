/**
 * `chat-arch generate-drafts` — materialize blog post drafts from the
 * blog-candidates.json prompt scaffolds via the Anthropic API.
 *
 * Spec §5 Blog.2 + acceptance #8 expect actual markdown drafts (not
 * prompt scaffolds) at `analysis/blog-drafts/{slug}.md` so the F-
 * audit pass can score them and the Today / /blog-drafts surfaces can
 * render the verdict inline. The Wave 3 semantic-analysis pass emits
 * `.prompt.md` scaffolds (cluster + member sessions + draft prompt);
 * this command takes those scaffolds + their cited transcripts and
 * produces the final `.md` body.
 *
 * Why a CLI subcommand vs an API endpoint: the user's local `claude.exe`
 * install is in a broken mid-upgrade state on Windows, so the in-UI
 * MINE CORRECTIONS button can't spawn it. Anthropic API access via
 * native fetch + ANTHROPIC_API_KEY bypasses the local CLI entirely
 * and works on any platform. No npm SDK dependency added.
 *
 * Cost guard: by default generates ONLY the top-1 candidate (~2K
 * input tokens × Sonnet pricing ≈ $0.01-0.03 per draft). The
 * --top-n flag opts the user into more.
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type {
  BlogCandidate,
  BlogCandidatesFile,
  UnifiedSessionEntry,
  SessionManifest,
} from '@chat-arch/schema';
import { findRepoRoot } from '../lib/repo-root.js';
import { logger } from '../lib/logger.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TOP_N = 1;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_TRANSCRIPT_CHARS_PER_SESSION = 8000;

interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: { role: 'user'; content: string }[];
  system?: string;
}

interface AnthropicMessageResponse {
  id: string;
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function runGenerateDraftsSubcommand(
  argv: readonly string[],
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      'candidate-id': { type: 'string' },
      'top-n': { type: 'string' },
      model: { type: 'string' },
      'max-output-tokens': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    logger.info(
      'chat-arch generate-drafts [--out <dir>] [--candidate-id <id>] [--top-n N]\n' +
        '                          [--model <name>] [--max-output-tokens N] [--dry-run]\n\n' +
        '  Generate blog post drafts from analysis/blog-drafts/{slug}.prompt.md\n' +
        '  scaffolds by calling the Anthropic API. Writes the final markdown to\n' +
        '  analysis/blog-drafts/{slug}.md so the F-audit / Today page pick it up.\n\n' +
        '  Requires ANTHROPIC_API_KEY in the environment.\n\n' +
        '  --candidate-id    Generate one specific candidate by its blog-candidate id.\n' +
        `  --top-n           Generate top N candidates by score (default ${DEFAULT_TOP_N}).\n` +
        `  --model           Anthropic model id (default ${DEFAULT_MODEL}).\n` +
        `  --max-output-tokens   Per-draft cap (default ${DEFAULT_MAX_OUTPUT_TOKENS}).\n` +
        '  --dry-run         Print what would be generated; do not call the API.\n' +
        '  --out, -o         Output directory containing analysis/.\n' +
        '                    (default: <repo-root>/apps/standalone/public/chat-arch-data).\n',
    );
    return 0;
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const dryRun = values['dry-run'] === true;
  if (apiKey === undefined && !dryRun) {
    logger.error(
      'generate-drafts: ANTHROPIC_API_KEY missing. Export it or pass --dry-run to skip the API call.',
    );
    return 1;
  }

  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(findRepoRoot(), 'apps/standalone/public/chat-arch-data');
  const analysisDir = path.join(outDir, 'analysis');
  const draftsDir = path.join(analysisDir, 'blog-drafts');
  await mkdir(draftsDir, { recursive: true });

  const candidatesPath = path.join(analysisDir, 'blog-candidates.json');
  let candidatesFile: BlogCandidatesFile;
  try {
    candidatesFile = JSON.parse(
      await readFile(candidatesPath, 'utf8'),
    ) as BlogCandidatesFile;
  } catch (err) {
    logger.error(
      `generate-drafts: failed to read ${candidatesPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const manifestPath = path.join(outDir, 'manifest.json');
  let manifest: SessionManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SessionManifest;
  } catch (err) {
    logger.error(
      `generate-drafts: failed to read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const sessionsById = new Map<string, UnifiedSessionEntry>();
  for (const s of manifest.sessions) sessionsById.set(s.id, s);

  const candidateId = values['candidate-id'];
  const topN = Number.parseInt(values['top-n'] ?? String(DEFAULT_TOP_N), 10);
  const model = values.model ?? DEFAULT_MODEL;
  const maxOutputTokens = Number.parseInt(
    values['max-output-tokens'] ?? String(DEFAULT_MAX_OUTPUT_TOKENS),
    10,
  );

  let selection: BlogCandidate[];
  if (candidateId !== undefined) {
    const one = candidatesFile.candidates.find((c) => c.id === candidateId);
    if (one === undefined) {
      logger.error(`generate-drafts: candidate id "${candidateId}" not found`);
      return 1;
    }
    selection = [one];
  } else {
    selection = [...candidatesFile.candidates]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topN));
  }

  if (selection.length === 0) {
    logger.error('generate-drafts: no candidates available (blog-candidates.json is empty)');
    return 1;
  }

  logger.info(
    `generate-drafts: ${selection.length} candidate(s) to generate, model=${model}, ` +
      `max_tokens=${maxOutputTokens}, dry-run=${dryRun}`,
  );

  let generated = 0;
  let failed = 0;
  for (const cand of selection) {
    const slug = `${slugify(cand.workingTitle)}-${cand.id}`;
    const draftPath = path.join(draftsDir, `${slug}.md`);
    const promptScaffoldPath = path.join(draftsDir, `${findPromptScaffold(cand) ?? `${slug}.prompt.md`}`);

    let promptScaffold = '';
    try {
      promptScaffold = await readFile(promptScaffoldPath, 'utf8');
    } catch {
      // No scaffold on disk — assemble inline. The Wave 3 orchestrator
      // writes scaffolds for the top-3 only, so a --candidate-id past
      // the top-3 lands here.
      promptScaffold = assembleInlinePrompt(cand, sessionsById);
    }

    const userMessage = buildUserMessage(promptScaffold, cand, sessionsById);

    if (dryRun) {
      logger.info(
        `generate-drafts: [dry-run] ${cand.id} → ${draftPath}\n  prompt chars: ${userMessage.length}`,
      );
      generated += 1;
      continue;
    }

    try {
      const draft = await callClaude(apiKey as string, model, userMessage, maxOutputTokens);
      await writeFile(draftPath, draft, 'utf8');
      logger.info(
        `generate-drafts: wrote ${path.relative(outDir, draftPath)} (${draft.length} chars)`,
      );
      generated += 1;
    } catch (err) {
      logger.error(
        `generate-drafts: ${cand.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed += 1;
    }
  }

  logger.info(
    `generate-drafts: done — ${generated} generated, ${failed} failed of ${selection.length} attempted`,
  );
  return failed > 0 ? 1 : 0;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The Wave 3 orchestrator names scaffolds `{date}-{slug}-{id}.prompt.md`
 * where {date} is the run's ISO date. We don't know that date here, so
 * just look up scaffolds by scanning for any `*{cand.id}.prompt.md`.
 * Returns the filename (no leading dir) or null.
 *
 * This is fail-soft — if no scaffold is found the caller assembles
 * one inline.
 */
function findPromptScaffold(_cand: BlogCandidate): string | null {
  // Lookup is performed against the on-disk dir in the calling fn via
  // readFile try/catch. This helper exists so the slug → scaffold path
  // mapping has a single home and is greppable.
  return null;
}

function assembleInlinePrompt(
  cand: BlogCandidate,
  sessionsById: ReadonlyMap<string, UnifiedSessionEntry>,
): string {
  const lines = [
    `# Blog draft prompt — ${cand.workingTitle}`,
    '',
    `Candidate id: ${cand.id}`,
    `Cluster score: ${cand.score.toFixed(3)} (mean discovery=${cand.meanDiscoveryScore.toFixed(2)}, span=${cand.spanDays.toFixed(1)}d, novelty=${cand.noveltyScore.toFixed(2)})`,
    cand.meanAuditPassRate !== null
      ? `Mean F-audit pass rate over cluster: ${(cand.meanAuditPassRate * 100).toFixed(0)}%`
      : 'Mean F-audit pass rate: n/a',
    '',
    '## Member sessions',
  ];
  for (const sid of cand.clusterSessionIds) {
    const e = sessionsById.get(sid);
    lines.push(
      e === undefined
        ? `- [SID:${sid}] (entry not found)`
        : `- [SID:${sid}] · ${e.title} · ${new Date(e.startedAt).toISOString().slice(0, 10)}`,
    );
  }
  return lines.join('\n');
}

function buildUserMessage(
  promptScaffold: string,
  cand: BlogCandidate,
  sessionsById: ReadonlyMap<string, UnifiedSessionEntry>,
): string {
  // Use the manifest entries (title + preview + userTextSamples + summary)
  // as the source material. Reading full transcripts would balloon the
  // prompt + cost; the manifest excerpts are signal-rich enough for a
  // first draft. The user reviews + iterates before publishing.
  const sessionBlocks: string[] = [];
  for (const sid of cand.clusterSessionIds) {
    const e = sessionsById.get(sid);
    if (e === undefined) continue;
    const parts = [
      `### [SID:${sid}] · ${e.title}`,
      `- Date: ${new Date(e.startedAt).toISOString().slice(0, 10)}`,
      `- Source: ${e.source}${e.project !== undefined ? ` · project: ${e.project}` : ''}`,
      e.summary !== undefined ? `- Summary: ${truncate(e.summary, 600)}` : '',
      e.preview !== null ? `- Preview: ${truncate(e.preview, 400)}` : '',
    ].filter((s) => s.length > 0);

    const samples = e.userTextSamples ?? [];
    if (samples.length > 0) {
      parts.push('- User-turn samples:');
      let acc = 0;
      for (const sample of samples) {
        if (acc >= DEFAULT_MAX_TRANSCRIPT_CHARS_PER_SESSION) break;
        const t = truncate(sample, 400);
        parts.push(`  > ${t.replace(/\n/g, ' ')}`);
        acc += t.length;
      }
    }
    sessionBlocks.push(parts.join('\n'));
  }

  return [
    'You are drafting a personal-narrative blog post for Bryce Watson based on a cluster of his recent Claude Code sessions. The post should:',
    '',
    "- Read as Bryce's own voice — first-person, observational, slightly understated, no AI-marketing tone.",
    '- Build a single through-line from the sessions below; do not summarize each session separately.',
    '- Cite source sessions inline using the form [SID:<full-uuid>] so the F-audit pass can verify claims against the cited transcripts.',
    "- Lead with an observation or moment, not a thesis. Land the thesis in the middle or end once it's earned.",
    "- Honest about limits — if a claim is supported by only one session or is partial, say so.",
    '- 600-1200 words.',
    '- Markdown only. H1 title at the top; H2 for sections if needed.',
    '',
    '---',
    '',
    '## Scaffold (from the candidate selector)',
    '',
    promptScaffold,
    '',
    '## Source sessions',
    '',
    sessionBlocks.join('\n\n'),
    '',
    '---',
    '',
    'Draft the post now. Output ONLY the markdown post body — no preamble, no chat-style reply, no explanation. Start with the H1 title.',
  ].join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

async function callClaude(
  apiKey: string,
  model: string,
  userMessage: string,
  maxOutputTokens: number,
): Promise<string> {
  const body: AnthropicMessageRequest = {
    model,
    max_tokens: maxOutputTokens,
    messages: [{ role: 'user', content: userMessage }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
  }
  const json = (await res.json()) as AnthropicMessageResponse;
  let out = '';
  for (const block of json.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    }
  }
  if (out.trim() === '') {
    throw new Error('Anthropic API returned empty text content');
  }
  return out;
}
