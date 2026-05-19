#!/usr/bin/env node
/**
 * Auto-labeler for threshold pairs.
 *
 * Dual-judge: Haiku 4.5 + Sonnet 4.6 evaluate each pair independently
 * via `claude -p` (Claude Code in headless mode), so this uses your
 * existing Claude Code auth/plan — no ANTHROPIC_API_KEY needed.
 * Agreed labels are written to the same file the TUI labeler writes
 * (`chat-arch-data/labels/threshold-pairs.json`), so the existing
 * sweep + CI machinery consumes them unchanged. Disagreements are
 * dropped by default (logged for audit) or queued for the TUI via
 * `--confirm-disagreements`.
 *
 * Why `claude -p` over the Anthropic SDK:
 *
 *   - One auth: same Claude Code subscription that powers the editor,
 *     no separate API key to manage.
 *   - Structured output via `--json-schema` — the model's response
 *     is validated against a schema at the CLI layer, no parse races.
 *   - System prompt override (`--system-prompt`) strips the default
 *     CLAUDE.md / cwd / git-status injection so the rubric is the
 *     only context; same prompt across pairs → caching reuse.
 *   - `--tools "" --no-session-persistence --disable-slash-commands
 *     --strict-mcp-config` keeps each call isolated and side-effect
 *     free.
 *   - Per-call cost is reported in the JSON `total_cost_usd` field;
 *     we sum it across pairs for an actual (not estimated) total.
 *
 * Other optimizations:
 *
 *   - Two judges run in parallel per pair; pairs are processed with
 *     bounded concurrency (default 5 in-flight, i.e. 10 spawns).
 *   - Resumable: every agreed label is persisted to disk immediately.
 *     A second run skips already-labeled pairs.
 *   - Stratified by cosine bucket — same deficit logic as the TUI, so
 *     re-running with the same `--n` fills the gaps without redoing.
 *   - Truncated inputs: title ≤ 120 chars, preview ≤ 800 chars per
 *     side. Keeps per-pair input small.
 *
 * Usage:
 *   node scripts/auto-label-threshold.mjs [--n 100] [--band 0.85,1.0]
 *     [--strata 4] [--concurrency 5] [--dry-run]
 *     [--confirm-disagreements] [--judges haiku,sonnet]
 *     [--data-dir <path>] [--max-retries 3]
 *
 * Requires `claude` (the Claude Code CLI) on PATH. If your install's
 * `claude` shim is broken (postinstall didn't write claude.exe — only
 * .old.* rotations remain in bin/), set:
 *
 *   CLAUDE_BIN="node $(npm root -g)/@anthropic-ai/claude-code/cli-wrapper.cjs"
 *
 * to use the Node fallback wrapper that ships in the same package.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  bucketIndexFor,
  computeBucketBounds,
  computeBucketStats,
  stratifiedSampleDeficit,
  scanInBandPairs,
  loadLabels,
  saveLabels,
  truncate,
} from './label.mjs';

// ---------- ANSI ----------
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const c = (col, s) => `${ANSI[col]}${s}${ANSI.reset}`;

// ---------- Models ----------
// Passed verbatim to `claude --model`. Pinned full IDs (not aliases
// like 'haiku' / 'sonnet') so the calibration sample stays
// reproducible if the alias points elsewhere later.
const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

// ---------- Rubric ----------
//
// Two-part:
//   - SYSTEM_PROMPT (short, single line, escape-safe) — goes to
//     `--system-prompt`. Must survive Windows cmd.exe quoting under
//     shell:true with no special characters or newlines.
//   - RUBRIC (multi-line, full definition + examples) — prepended to
//     the per-pair user content, sent via stdin so shell escaping
//     never touches it.
//
// Splitting it this way also lets us override the default Claude Code
// system prompt entirely — without an explicit --system-prompt, every
// call would carry ~34k tokens of Claude Code context (~$0.04/call,
// ~$8 for a 100-pair run vs <$1 with the override).
const SYSTEM_PROMPT =
  'You are a JSON-only classification API. Reply with a single JSON object matching the schema described in the user message. No prose, no commentary, no markdown fences.';

// Few-shot examples cover the three common failure modes
// mxbai-embed-large gets wrong in this band: high-cos topic overlap
// that isn't actually duplicate, low-cos paraphrases that ARE
// duplicate, and boilerplate template prompts that score > 0.97 but
// address different underlying tasks.
const RUBRIC = `You are judging whether two chat sessions are near-duplicates.

DEFINITION — two sessions are NEAR-DUPLICATES iff a knowledgeable user, shown one of them, would want a tool to surface the other as "you already asked this." Concretely:

- Same underlying question, even if phrased differently (paraphrase, language switch, summary vs. detail).
- Template/boilerplate prompts where the substantive task is identical.
- One session is a direct continuation of the other (same task, same context, picking up where the prior left off).

They are NOT near-duplicates when:
- They share a topic but ask different questions ("How do I deploy to Vercel?" vs. "Why is my Vercel deploy failing?" — same topic, different task).
- They reuse a prompt template but with different substance (e.g. "/review PR #41" vs "/review PR #52" — same scaffold, different work).
- They reference common tooling but the actual goal differs.
- One is exploratory ("what's possible with X?") and the other is operational ("do X now").

When uncertain, prefer NOT — the cost of a false-positive duplicate (silently hiding a session the user wanted to find again) is higher than a false-negative.

You will receive title + preview for each side. The preview is truncated; judge on what's visible, do not speculate about content past the cutoff.

OUTPUT — respond with a single JSON object matching the provided schema. Emit the fields IN ORDER — reasoning first (3-5 sentences working through the comparison), then confidence (0.0–1.0), then label ("near-duplicate" or "not"). The reasoning field is for chain-of-thought; use it to compare the two sessions explicitly before committing to a label.

Examples (showing field order — reasoning first, label last):

A: "Fix the auth middleware bug"  / "Getting 401 errors after the JWT refresh, here's the stack trace..."
B: "401 errors on JWT refresh"    / "Hi - I'm seeing 401s come back when the access token rotates..."
→ near-duplicate (same underlying bug, same fix), confidence 0.92

A: "Deploy Astro to Vercel"       / "What's the recommended deploy flow for an Astro site on Vercel?"
B: "Vercel deploy is failing"     / "My Astro project builds locally but fails on Vercel with ENOENT..."
→ not (same surface area, different task — one is planning, one is debugging), confidence 0.88

A: "/review PR #41"               / "Review the changes on this branch..."
B: "/review PR #52"               / "Review the changes on this branch..."
→ not (template overlap masks distinct PRs), confidence 0.95`;

// JSON schema passed to `claude --json-schema`. The CLI validates the
// model's response against this; an invalid response surfaces as a
// failed run we can retry.
//
// Field order matters: with autoregressive generation, the model emits
// keys in declared order. `reasoning` first forces chain-of-thought
// before the model commits to a label — the empirical 2025 study
// (arXiv:2506.13639) shows κ improves when reasoning precedes the
// final verdict. maxLength bumped from 200 → 500 to allow genuine CoT.
const LABEL_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', maxLength: 500 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    label: { type: 'string', enum: ['near-duplicate', 'not'] },
  },
  required: ['reasoning', 'confidence', 'label'],
  additionalProperties: false,
};
const LABEL_SCHEMA_JSON = JSON.stringify(LABEL_SCHEMA);

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = {
    n: 100,
    band: [0.85, 1.0],
    strata: 4,
    concurrency: 5,
    dryRun: false,
    confirmDisagreements: false,
    judges: ['haiku', 'sonnet'],
    dataDir: null,
    maxRetries: 3,
    // 60s per claude -p invocation. CLI cold-start + a Haiku call
    // typically finishes in 5-10s; 60s leaves headroom for the
    // first-spawn warm-up on a fresh shell and the occasional slow
    // Sonnet response. Tunable for slow networks.
    timeoutMs: 60_000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--band') {
      const [lo, hi] = argv[++i].split(',').map(Number);
      out.band = [lo, hi];
    } else if (a === '--strata') out.strata = Math.max(1, Math.floor(Number(argv[++i])));
    else if (a === '--concurrency') out.concurrency = Math.max(1, Math.floor(Number(argv[++i])));
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--confirm-disagreements') out.confirmDisagreements = true;
    else if (a === '--judges') out.judges = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--max-retries') out.maxRetries = Math.max(0, Math.floor(Number(argv[++i])));
    else if (a === '--timeout-ms') out.timeoutMs = Math.max(1000, Math.floor(Number(argv[++i])));
    else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(c('red', `unknown arg: ${a}`));
      usage();
      process.exit(2);
    }
  }
  for (const j of out.judges) {
    if (!(j in MODELS)) {
      console.error(c('red', `unknown judge: ${j} (known: ${Object.keys(MODELS).join(', ')})`));
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  process.stderr.write(
    `Usage: node scripts/auto-label-threshold.mjs [opts]\n\n` +
      `  --n <N>                  target labels per band, stratified across buckets (default 100)\n` +
      `  --band <lo,hi>           cosine band (default 0.85,1.0)\n` +
      `  --strata <N>             buckets to split the band into (default 4)\n` +
      `  --concurrency <N>        pairs in flight at once (default 5)\n` +
      `  --judges <a,b>           comma-separated judge models (default haiku,sonnet)\n` +
      `  --confirm-disagreements  write disagreements to a separate file for TUI follow-up\n` +
      `  --dry-run                show the plan, don't invoke claude -p\n` +
      `  --data-dir <path>        override the chat-arch-data root\n` +
      `  --max-retries <N>        per-call retry budget on failure (default 3)\n` +
      `  --timeout-ms <N>         per-spawn wall-clock timeout (default 60000)\n`,
  );
}

// ---------- Semaphore ----------
function makeSemaphore(limit) {
  let inFlight = 0;
  const queue = [];
  const release = () => {
    inFlight -= 1;
    const next = queue.shift();
    if (next) {
      inFlight += 1;
      next();
    }
  };
  return async function acquire() {
    if (inFlight < limit) {
      inFlight += 1;
      return release;
    }
    await new Promise((resolve) => queue.push(resolve));
    inFlight += 1;
    return release;
  };
}

// ---------- claude -p invocation ----------
//
// Spawns Claude Code in headless print mode with all the isolation
// flags so the call has no project-context side effects: no tools,
// no session persistence, no slash commands, no MCP servers, system
// prompt overridden so CLAUDE.md / cwd / env / git-status aren't
// injected. `--json-schema` validates the model's response against
// LABEL_SCHEMA before the CLI exits 0, so by the time we see output
// it's already shape-correct.

// Resolve the claude command + leading args. CLAUDE_BIN can be a
// single binary ("claude") or a multi-token command line
// ("node C:/path/to/cli-wrapper.cjs") for users whose `claude` shim
// is broken (postinstall didn't write claude.exe — the Node-fallback
// cli-wrapper.cjs is the official escape hatch in that case). The
// string is split on whitespace; first token is the binary, the rest
// are leading args.
function resolveClaudeCommand() {
  const raw = (process.env.CLAUDE_BIN ?? 'claude').trim();
  const parts = raw.split(/\s+/);
  return { bin: parts[0], leadingArgs: parts.slice(1) };
}

function stripJsonFence(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return (fenced ? fenced[1] : s).trim();
}

// Probe `claude --version` before the main loop. Fast (~ms) and gives
// a clean early exit when Claude Code isn't installed / shim broken
// / auth missing — much better than 100 pairs × 3 retries of the same
// failure. Returns { ok, message }.
function probeClaude({ timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const { bin, leadingArgs } = resolveClaudeCommand();
    const useShell = process.platform === 'win32' && bin === 'claude';
    const child = spawn(bin, [...leadingArgs, '--version'], {
      shell: useShell,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, message: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, message: '' });
      else resolve({ ok: false, message: stderr.trim() || `exit ${code}` });
    });
  });
}

function spawnClaudeJudge({ judge, prompt, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const { bin, leadingArgs } = resolveClaudeCommand();
    const args = [
      ...leadingArgs,
      '-p',
      '--model',
      MODELS[judge],
      '--output-format',
      'json',
      '--input-format',
      'text',
      '--system-prompt',
      SYSTEM_PROMPT,
      '--json-schema',
      LABEL_SCHEMA_JSON,
      '--tools',
      '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config',
      '',
      '--setting-sources',
      '',
    ];
    // shell:true on Windows so a bare `claude` resolves to claude.cmd
    // when CLAUDE_BIN isn't set. When CLAUDE_BIN points at `node` +
    // a script path, shell isn't needed and skipping it avoids extra
    // argument-quoting risk.
    const useShell = process.platform === 'win32' && bin === 'claude';
    const child = spawn(bin, args, {
      shell: useShell,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Send the full prompt (rubric + pair content) on stdin. This
    // sidesteps shell escaping for everything multi-line.
    child.stdin.write(prompt);
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn claude failed: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
      }
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim();
        // Common Windows breakage: `claude.cmd` points at a
        // `node_modules/.../bin/claude.exe` that was rotated out by
        // a partial postinstall, leaving only `claude.exe.old.*`
        // files. The user's editor still works because it spawns
        // claude through a different channel. Surface the fix
        // proactively so they don't have to grep the error.
        const isBrokenShim = /claude\.exe.*not recognized|not found.*claude\.exe|ENOENT.*claude/i.test(msg);
        const hint = isBrokenShim
          ? '\n\nHint: the `claude` shim points at a missing claude.exe. Either:\n' +
            '  1) Reinstall: `npm i -g @anthropic-ai/claude-code` (or `claude install`)\n' +
            '  2) Override: set CLAUDE_BIN to the Node fallback wrapper, e.g.:\n' +
            '     CLAUDE_BIN="node $(npm root -g)/@anthropic-ai/claude-code/cli-wrapper.cjs"'
          : '';
        return reject(new Error(`claude -p exited ${code}: ${msg}${hint}`));
      }
      resolve(stdout);
    });
  });
}

async function callJudge({ judge, pair, sessionsById, maxRetries, timeoutMs, rng }) {
  // A/B position randomization. Zheng et al. 2023 (MT-Bench) and Shi
  // et al. 2024 (arXiv:2406.07791) name position bias as one of the
  // three canonical LLM-judge failure modes. Without this fix, fixed
  // A=session1/B=session2 order systematically biases verdicts on
  // borderline pairs. Per-call coin flip is cheaper than
  // swap-and-average and averages out the bias across the run.
  const swap = rng() < 0.5;
  const first = swap ? sessionsById.get(pair.b) : sessionsById.get(pair.a);
  const second = swap ? sessionsById.get(pair.a) : sessionsById.get(pair.b);
  // The cosine value is deliberately NOT included in the prompt. Lou
  // et al. 2024 (arXiv:2412.06593) and the ICLR HCAIR 2026 anchoring
  // paper (arXiv:2505.15392) both find that "don't be anchored by X"
  // instructions don't neutralize anchoring — the number still shifts
  // the verdict. Drop it entirely.
  const pairPayload =
    `Session A:\n` +
    `  Title: ${truncate(first?.title ?? '(unknown)', 120)}\n` +
    `  Preview: ${truncate(first?.preview ?? '', 800)}\n\n` +
    `Session B:\n` +
    `  Title: ${truncate(second?.title ?? '(unknown)', 120)}\n` +
    `  Preview: ${truncate(second?.preview ?? '', 800)}`;
  // Rubric goes in the user message (via stdin) rather than the
  // system prompt, so multi-line content never goes through cmd.exe
  // quoting. The short SYSTEM_PROMPT on the command line just pins
  // the model in JSON-only mode.
  const userPrompt = `${RUBRIC}\n\n---\n\n${pairPayload}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await spawnClaudeJudge({ judge, prompt: userPrompt, timeoutMs });
      const envelope = JSON.parse(raw);
      // claude -p with --json-schema puts the schema-conformant
      // payload in envelope.structured_output (typed). `result` is
      // the model's conversational summary of what it did and is not
      // schema-bound. Fall back to parsing result text (with fence
      // stripping) for the rare case where structured_output is
      // missing — e.g. the model refused to call the structured-
      // output tool.
      let label;
      if (envelope.structured_output && typeof envelope.structured_output === 'object') {
        label = envelope.structured_output;
      } else {
        const resultText = stripJsonFence(
          typeof envelope.result === 'string' ? envelope.result : '',
        );
        label = JSON.parse(resultText);
      }
      return {
        judge,
        label: label.label,
        confidence: Number(label.confidence ?? 0),
        reasoning: String(label.reasoning ?? ''),
        costUsd: Number(envelope.total_cost_usd ?? 0),
        usage: envelope.usage ?? null,
        durationMs: Number(envelope.duration_ms ?? envelope.duration ?? 0),
      };
    } catch (err) {
      // claude -p doesn't expose typed retryable errors via the JSON
      // envelope yet, so retry on any failure up to maxRetries. The
      // common transient failures (rate limits, network, kernel
      // schedule blips on cold start) all recover within seconds.
      if (attempt === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 250, 8000);
      console.warn(
        c('yellow', `  judge ${judge} retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms (${err.message ?? err})`),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`unreachable: callJudge ${judge}`);
}

// ---------- Main ----------
async function main() {
  const opts = parseArgs(process.argv);
  const dataDir =
    opts.dataDir ?? path.join('apps', 'standalone', 'public', 'chat-arch-data');
  const labelsPath = path.join(dataDir, 'labels', 'threshold-pairs.json');
  const auditPath = path.join(dataDir, 'labels', 'threshold-judges.json');
  const disagreePath = path.join(dataDir, 'labels', 'threshold-disagreements.json');

  if (!opts.dryRun) {
    const probe = await probeClaude();
    if (!probe.ok) {
      console.error(
        c('yellow', `\nClaude Code CLI not available — skipping auto-label.`),
      );
      console.error(c('dim', `  reason: ${probe.message}`));
      const broken = /claude\.exe.*not recognized|ENOENT.*claude/i.test(probe.message);
      if (broken) {
        console.error(
          c('dim', `  hint: postinstall didn't write claude.exe. Reinstall via \`npm i -g @anthropic-ai/claude-code\`, or set\n` +
            `        CLAUDE_BIN="node $(npm root -g)/@anthropic-ai/claude-code/cli-wrapper.cjs"`),
        );
      }
      // Exit 0 so the exporter doesn't log this as a soft-fail with a
      // non-zero exit. Missing Claude Code is an environment fact,
      // not a script error.
      process.exit(0);
    }
  }

  let scan;
  try {
    scan = await scanInBandPairs({ dataDir, band: opts.band });
  } catch (err) {
    console.error(c('red', `Could not read embeddings: ${err.message}`));
    console.error(c('dim', 'Run `pnpm exporter run start` with Ollama running first.'));
    process.exit(1);
  }
  const { pairs: allPairs, sessionsById, vectorCount } = scan;
  console.log(
    c('dim', `Scanned ${vectorCount} embeddings; ${allPairs.length} pairs in cos[${opts.band[0]}, ${opts.band[1]}].`),
  );

  const store = await loadLabels(labelsPath);
  const labeled = new Set(Object.keys(store.labels));
  const unlabeled = allPairs.filter((p) => !labeled.has(p.id));
  const stats = computeBucketStats(store.labels, opts.band, opts.strata, opts.n);
  const sampled = stratifiedSampleDeficit(
    unlabeled,
    stats,
    opts.band,
    opts.strata,
    'seed-threshold',
  );

  // Bucket-level preview, same shape the TUI prints.
  const bounds = computeBucketBounds(opts.band, opts.strata);
  console.log(c('bold', `\nDeficit per bucket (target: ${Math.floor(opts.n / opts.strata)} per bucket):`));
  for (let i = 0; i < bounds.length; i++) {
    const s = stats[i];
    const sampledInBucket = sampled.filter(
      (p) => bucketIndexFor(p.cos, opts.band, opts.strata) === i,
    ).length;
    const close = bounds[i].isLast ? ']' : ')';
    const color = s.deficit > 0 ? 'yellow' : 'dim';
    let line = `  [${bounds[i].lo.toFixed(4)}, ${bounds[i].hi.toFixed(4)}${close}: ${s.alreadyLabeled}/${s.target} labeled`;
    if (s.deficit > 0) line += `, ${s.deficit} more needed → ${sampledInBucket} auto-sample`;
    console.log(c(color, line));
  }
  console.log();

  if (sampled.length === 0) {
    console.log(c('green', 'All bucket targets met. Nothing to do.'));
    return;
  }

  console.log(
    c('bold', `Plan: ${sampled.length} pairs × ${opts.judges.length} judges (${opts.judges.join(', ')}), concurrency ${opts.concurrency}.`),
  );
  console.log(
    c('dim', `  Auth: Claude Code subscription — counts against your plan, no out-of-pocket per-token spend.`),
  );
  console.log(
    c('dim', `  claude -p reports an API-equivalent cost per call; we sum it at the end as a plan-usage estimate.`),
  );
  console.log(
    c('dim', `  Disagreements: ${opts.confirmDisagreements ? `queued to ${disagreePath}` : 'dropped (logged in audit only)'}.`),
  );

  if (opts.dryRun) {
    console.log(
      c('green', '\n--dry-run: not invoking claude. Drop the flag to run.\n'),
    );
    return;
  }

  const acquire = makeSemaphore(opts.concurrency);

  // Audit log: every per-judge vote, keyed by pairId. Survives across
  // runs (read-modify-write) so re-running adds new votes rather than
  // overwriting.
  const audit = await loadAudit(auditPath);
  const disagreements = await loadAudit(disagreePath);

  let agreedNearDup = 0;
  let agreedNot = 0;
  let disagreed = 0;
  let errors = 0;
  let totalCostUsd = 0;

  // Position-randomization RNG. Math.random is fine here — the audit
  // care is "averages out across the run," not reproducibility (each
  // judge's per-pair A/B order is independent).
  const rng = () => Math.random();

  let i = 0;
  await Promise.all(
    sampled.map(async (pair) => {
      const release = await acquire();
      try {
        const votes = await Promise.all(
          opts.judges.map((judge) =>
            callJudge({
              judge,
              pair,
              sessionsById,
              maxRetries: opts.maxRetries,
              timeoutMs: opts.timeoutMs,
              rng,
            }),
          ),
        );
        for (const v of votes) {
          totalCostUsd += v.costUsd;
        }
        audit.entries[pair.id] = {
          cos: pair.cos,
          votes: votes.map((v) => ({
            judge: v.judge,
            label: v.label,
            confidence: v.confidence,
            reasoning: v.reasoning,
          })),
        };

        const labels = votes.map((v) => v.label);
        const allAgree = labels.every((l) => l === labels[0]);
        if (allAgree) {
          const nearDup = labels[0] === 'near-duplicate';
          store.labels[pair.id] = { nearDup, cos: pair.cos };
          await saveLabels(labelsPath, store);
          if (nearDup) agreedNearDup += 1;
          else agreedNot += 1;
        } else {
          disagreed += 1;
          if (opts.confirmDisagreements) {
            disagreements.entries[pair.id] = audit.entries[pair.id];
            await saveAudit(disagreePath, disagreements);
          }
        }
        await saveAudit(auditPath, audit);

        i += 1;
        const tag = allAgree
          ? labels[0] === 'near-duplicate'
            ? c('green', 'dup')
            : c('cyan', 'not')
          : c('yellow', 'split');
        const conf = (
          votes.reduce((s, v) => s + v.confidence, 0) / votes.length
        ).toFixed(2);
        console.log(
          c('gray', `  [${i}/${sampled.length}]`) +
            ` cos=${pair.cos.toFixed(3)} ${tag} (avg conf ${conf}) ${c('gray', votes.map((v) => `${v.judge}:${v.label[0]}`).join(' '))}`,
        );
      } catch (err) {
        errors += 1;
        console.error(c('red', `  pair ${pair.id} failed: ${err.message ?? err}`));
      } finally {
        release();
      }
    }),
  );

  console.log(c('bold', `\nResults:`));
  console.log(`  agreed near-dup: ${c('green', agreedNearDup)}`);
  console.log(`  agreed not:      ${c('cyan', agreedNot)}`);
  console.log(`  disagreements:   ${c('yellow', disagreed)}${opts.confirmDisagreements ? ` (queued to ${disagreePath})` : ''}`);
  if (errors) console.log(`  errors:          ${c('red', errors)}`);
  console.log(
    c('dim', `  plan usage (API-equivalent): $${totalCostUsd.toFixed(4)} USD — actual cost is bounded by your Claude Code plan.`),
  );
  console.log(c('dim', `  audit log: ${auditPath}`));
  console.log(c('dim', `  labels:    ${labelsPath}`));
  if (disagreed && opts.confirmDisagreements) {
    console.log(
      c('yellow', `\nNext: run \`pnpm label:threshold\` to adjudicate the ${disagreed} disagreement(s) interactively.`),
    );
  }
}

async function loadAudit(p) {
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.entries ? parsed : { entries: {}, lastUpdated: null };
  } catch {
    return { entries: {}, lastUpdated: null };
  }
}

async function saveAudit(p, store) {
  store.lastUpdated = Date.now();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

main().catch((err) => {
  console.error(c('red', `\nauto-labeler crashed: ${err.message ?? err}`));
  console.error(c('dim', err.stack ?? ''));
  process.exit(1);
});
