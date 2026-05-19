#!/usr/bin/env node
/**
 * Auto-labeler for threshold pairs.
 *
 * Dual-judge: Haiku 4.5 + Sonnet 4.6 evaluate each pair independently.
 * Agreed labels are written to the same file the TUI labeler writes
 * (`chat-arch-data/labels/threshold-pairs.json`), so the existing
 * sweep + CI machinery consumes them unchanged. Disagreements are
 * dropped by default (logged for audit) or queued for the TUI via
 * `--confirm-disagreements`.
 *
 * Optimizations:
 *
 *   - Prompt caching on the rubric + tool schema (ephemeral, 5 min TTL).
 *     Reads at 10% of input cost; with ~1500 cacheable tokens, the
 *     rubric pays for itself after the second pair.
 *   - tool_use forced output (structured JSON), no parse failures.
 *   - Two judges run in parallel per pair; pairs are processed with
 *     bounded concurrency (default 5 in-flight, i.e. 10 API requests).
 *   - Resumable: every agreed label is persisted to disk immediately.
 *     A second run skips already-labeled pairs.
 *   - Stratified by cosine bucket — same deficit logic as the TUI, so
 *     re-running with the same `--n` fills the gaps without redoing.
 *   - Truncated inputs: title ≤ 120 chars, preview ≤ 800 chars per
 *     side. Keeps per-pair input under ~500 tokens.
 *
 * Cost: ~$0.30/100 pairs (Haiku $1/$5 + Sonnet $3/$15 per MTok, with
 * cached rubric). `--dry-run` prints the estimate before spending.
 *
 * Usage:
 *   node scripts/auto-label-threshold.mjs [--n 100] [--band 0.85,1.0]
 *     [--strata 4] [--concurrency 5] [--dry-run]
 *     [--confirm-disagreements] [--judges haiku,sonnet]
 *     [--data-dir <path>] [--max-retries 3]
 *
 * Requires ANTHROPIC_API_KEY in the environment.
 */

import Anthropic from '@anthropic-ai/sdk';
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
const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};
// Per-MTok pricing (USD), public list pricing as of model release.
// Cache reads are 10% of input; cache writes are 1.25x input. The
// cost preview uses these to give the user a sticker-shock estimate
// before they spend.
const PRICING = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
};

// ---------- Rubric ----------
//
// Kept terse and explicit so the two judges aren't fighting over
// definitional drift. The few-shot examples cover the three common
// failure modes mxbai-embed-large gets wrong in this band: high-cos
// topic overlap that isn't actually duplicate, low-cos paraphrases
// that ARE duplicate, and boilerplate template prompts that score
// > 0.97 but address different underlying tasks.
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

OUTPUT — call the submit_label tool with:
- label: "near-duplicate" or "not"
- confidence: 0.0–1.0 (how sure you are)
- reasoning: one sentence, ≤200 chars

Examples:

A: "Fix the auth middleware bug"  / "Getting 401 errors after the JWT refresh, here's the stack trace..."
B: "401 errors on JWT refresh"    / "Hi - I'm seeing 401s come back when the access token rotates..."
→ near-duplicate (same underlying bug, same fix), confidence 0.92

A: "Deploy Astro to Vercel"       / "What's the recommended deploy flow for an Astro site on Vercel?"
B: "Vercel deploy is failing"     / "My Astro project builds locally but fails on Vercel with ENOENT..."
→ not (same surface area, different task — one is planning, one is debugging), confidence 0.88

A: "/review PR #41"               / "Review the changes on this branch..."
B: "/review PR #52"               / "Review the changes on this branch..."
→ not (template overlap masks distinct PRs), confidence 0.95`;

const TOOL_DEF = {
  name: 'submit_label',
  description: 'Submit your near-duplicate judgement for the pair.',
  input_schema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        enum: ['near-duplicate', 'not'],
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      reasoning: {
        type: 'string',
        maxLength: 200,
      },
    },
    required: ['label', 'confidence', 'reasoning'],
  },
};

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
      `  --dry-run                show the plan + cost estimate, don't call the API\n` +
      `  --data-dir <path>        override the chat-arch-data root\n` +
      `  --max-retries <N>        per-call retry budget on 429/5xx (default 3)\n`,
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

// ---------- API call ----------
async function callJudge({ client, judge, pair, sessionsById, maxRetries }) {
  const a = sessionsById.get(pair.a);
  const b = sessionsById.get(pair.b);
  const userContent =
    `Session A:\n` +
    `  Title: ${truncate(a?.title ?? '(unknown)', 120)}\n` +
    `  Preview: ${truncate(a?.preview ?? '', 800)}\n\n` +
    `Session B:\n` +
    `  Title: ${truncate(b?.title ?? '(unknown)', 120)}\n` +
    `  Preview: ${truncate(b?.preview ?? '', 800)}\n\n` +
    `Cosine similarity (mxbai-embed-large): ${pair.cos.toFixed(4)} — do not let this anchor your judgement; the whole point of this labeling pass is to calibrate it.`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await client.messages.create({
        model: MODELS[judge],
        max_tokens: 400,
        system: [
          {
            type: 'text',
            text: RUBRIC,
            // Ephemeral cache on the rubric. Reads = 10% of input price;
            // a single run amortizes this across the whole pair pool.
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [TOOL_DEF],
        tool_choice: { type: 'tool', name: 'submit_label' },
        messages: [{ role: 'user', content: userContent }],
      });
      const toolUse = res.content.find((b2) => b2.type === 'tool_use');
      if (!toolUse) {
        throw new Error(`judge ${judge} returned no tool_use block`);
      }
      const input = toolUse.input;
      return {
        judge,
        label: input.label,
        confidence: Number(input.confidence ?? 0),
        reasoning: String(input.reasoning ?? ''),
        usage: res.usage,
      };
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt === maxRetries) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 250, 8000);
      console.warn(
        c('yellow', `  judge ${judge} retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms (status ${status})`),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`unreachable: callJudge ${judge}`);
}

// ---------- Cost ----------
function estimateCost({ pairs, judges }) {
  // Conservative per-pair token counts.
  const cachedSystem = 1500; // rubric + tool schema, cached
  const userPerPair = 450; // truncated content
  const outputPerPair = 80; // tool_use payload
  let usd = 0;
  for (const j of judges) {
    const p = PRICING[j];
    // First call writes cache (1.25x input), subsequent reads (0.1x input).
    // Approximate: ~all subsequent reads (write cost dominated by 1 call).
    const totalIn = cachedSystem * 0.1 + userPerPair;
    const totalOut = outputPerPair;
    usd += (pairs * totalIn * p.in) / 1_000_000;
    usd += (pairs * totalOut * p.out) / 1_000_000;
  }
  return usd;
}

// ---------- Main ----------
async function main() {
  const opts = parseArgs(process.argv);
  const dataDir =
    opts.dataDir ?? path.join('apps', 'standalone', 'public', 'chat-arch-data');
  const labelsPath = path.join(dataDir, 'labels', 'threshold-pairs.json');
  const auditPath = path.join(dataDir, 'labels', 'threshold-judges.json');
  const disagreePath = path.join(dataDir, 'labels', 'threshold-disagreements.json');

  if (!opts.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error(c('red', 'ANTHROPIC_API_KEY is not set. Export it before running, or use --dry-run.'));
    process.exit(1);
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

  const costUsd = estimateCost({ pairs: sampled.length, judges: opts.judges });
  console.log(
    c('bold', `Plan: ${sampled.length} pairs × ${opts.judges.length} judges (${opts.judges.join(', ')}), concurrency ${opts.concurrency}.`),
  );
  console.log(c('dim', `  Est. cost: ~$${costUsd.toFixed(3)} USD (rubric cached after first call).`));
  console.log(c('dim', `  Disagreements: ${opts.confirmDisagreements ? `queued to ${disagreePath}` : 'dropped (logged in audit only)'}.`));

  if (opts.dryRun) {
    console.log(c('green', '\n--dry-run: not calling the API. Drop the flag to spend the estimate above.\n'));
    return;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
  let usageIn = 0;
  let usageOut = 0;
  let usageCacheRead = 0;
  let usageCacheCreate = 0;

  let i = 0;
  await Promise.all(
    sampled.map(async (pair) => {
      const release = await acquire();
      try {
        const votes = await Promise.all(
          opts.judges.map((judge) =>
            callJudge({
              client,
              judge,
              pair,
              sessionsById,
              maxRetries: opts.maxRetries,
            }),
          ),
        );
        for (const v of votes) {
          usageIn += v.usage?.input_tokens ?? 0;
          usageOut += v.usage?.output_tokens ?? 0;
          usageCacheRead += v.usage?.cache_read_input_tokens ?? 0;
          usageCacheCreate += v.usage?.cache_creation_input_tokens ?? 0;
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
  console.log(c('dim', `  tokens: ${usageIn} in (${usageCacheRead} cache-read, ${usageCacheCreate} cache-create) / ${usageOut} out`));
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
