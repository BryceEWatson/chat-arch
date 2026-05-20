#!/usr/bin/env node
/**
 * Hand-label audit for the methods-playbook recall pipeline. Walks every
 * pattern family in `playbook-candidates.json`, deterministically samples
 * 10 sessions per family, prints the manifest title + last user-prompt
 * sample for each, and asks the human to mark whether the method
 * appeared *effective* (good) or not (bad). Writes the per-family
 * hand-labeled rate alongside the playbook auditor's reported rate to
 * `research/playbook-recall-audit-<YYYY-MM-DD>.md` and classifies each
 * family as "regex-fixable" or "structural".
 *
 * This is the calibration gate for #7 in the outcome-substrate roadmap:
 * if every family is regex-fixable, no new #7 code is needed — just
 * tighten `CLAIM_PATTERNS`. If most are structural, we have evidence
 * for the embeddings-clustering extension.
 *
 * Read-only — no writes to chat-arch-data; output goes to `research/`.
 *
 * Single-keypress UX:
 *   g = good (method appeared effective)
 *   b = bad  (method appeared ineffective / casual phrasing / coincidence)
 *   s = skip (no label written; rolls forward to the next item)
 *   q = save and quit
 *   ← = re-label the previous item
 *
 * Usage:
 *   node scripts/audit-playbook-recall.mjs
 *   node scripts/audit-playbook-recall.mjs --data-dir <path>
 *   node scripts/audit-playbook-recall.mjs --per-family 5
 *   node scripts/audit-playbook-recall.mjs --labels-file path/to/labels.json
 *   node scripts/audit-playbook-recall.mjs --report-only --labels-file path
 *
 * Defaults:
 *   --data-dir     apps/standalone/public/chat-arch-data
 *   --per-family   10
 *   --labels-file  (timestamped path under research/ — see below)
 *   --seed         seed-playbook-audit  (deterministic sampling)
 *
 * Resumable: every keypress writes the current state to the labels file
 * so an interrupted run resumes cleanly. Pass `--labels-file <path>` to
 * point at a specific in-progress file. With `--report-only`, writes the
 * markdown without prompting for more labels.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------- ANSI ----------
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  clear: '\x1b[2J\x1b[H',
};
const col = (c, s) => `${ANSI[c]}${s}${ANSI.reset}`;
const rule = () => col('gray', '─'.repeat(72));

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = {
    dataDir: 'apps/standalone/public/chat-arch-data',
    perFamily: 10,
    seed: 'seed-playbook-audit',
    labelsFile: null,
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--data-dir' && next !== undefined) {
      out.dataDir = next;
      i += 1;
    } else if (a === '--per-family' && next !== undefined) {
      out.perFamily = Number(next);
      i += 1;
    } else if (a === '--labels-file' && next !== undefined) {
      out.labelsFile = next;
      i += 1;
    } else if (a === '--seed' && next !== undefined) {
      out.seed = next;
      i += 1;
    } else if (a === '--report-only') {
      out.reportOnly = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'audit-playbook-recall — calibration gate for #7 (methods playbook).',
      '',
      'Usage:',
      '  node scripts/audit-playbook-recall.mjs [opts]',
      '',
      'Options:',
      '  --data-dir <path>      Default: apps/standalone/public/chat-arch-data',
      '  --per-family <n>       Default: 10 — hand-labels per pattern family',
      '  --labels-file <path>   Resume / load a specific labels JSON',
      '  --seed <string>        Default: seed-playbook-audit — deterministic sampling',
      '  --report-only          Skip prompting; write markdown from existing labels',
      '  -h, --help             Show this help',
      '',
    ].join('\n'),
  );
}

// ---------- Deterministic sampling (mulberry32 over hashed seed) ----------
function hashSeed(s) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampleN(items, n, seedString) {
  if (items.length <= n) return items.slice();
  const rng = mulberry32(hashSeed(seedString));
  // Fisher-Yates partial shuffle.
  const arr = items.slice();
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

// ---------- Wilson 95% CI (inlined; the analysis package's dist/ may
// not exist on a fresh clone, same situation as audit-correction-recall.mjs) ----------
const Z_95 = 1.96;
function wilsonCI(pHat, n) {
  if (n <= 0) return { low: 0, high: 1 };
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const margin =
    (Z_95 * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

// ---------- Keyboard input (mirrors scripts/label.mjs) ----------
const stdinBuffer = { keys: [], closed: false, listening: false };
function ensureNonTtyListener() {
  if (stdinBuffer.listening) return;
  stdinBuffer.listening = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const ch of String(chunk)) {
      if (ch === '\n' || ch === '\r' || ch === ' ') continue;
      stdinBuffer.keys.push(ch);
    }
    flushPending();
  });
  process.stdin.on('end', () => {
    stdinBuffer.closed = true;
    flushPending();
  });
}
const pendingResolvers = [];
function flushPending() {
  while (pendingResolvers.length > 0 && stdinBuffer.keys.length > 0) {
    const resolve = pendingResolvers.shift();
    resolve(stdinBuffer.keys.shift());
  }
  if (stdinBuffer.closed && stdinBuffer.keys.length === 0) {
    while (pendingResolvers.length > 0) {
      pendingResolvers.shift()('q');
    }
  }
}
function readKey() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const handler = (key) => {
        stdin.off('data', handler);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
        if (key === '') {
          process.stderr.write('\n[ctrl-c] aborting without save\n');
          process.exit(130);
        }
        resolve(key);
      };
      stdin.on('data', handler);
    } else {
      ensureNonTtyListener();
      pendingResolvers.push(resolve);
      flushPending();
    }
  });
}

// ---------- Labels store ----------
async function loadLabels(labelsPath) {
  try {
    const raw = await readFile(labelsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { labels: {}, completed: 0, lastUpdated: null };
  }
}
async function saveLabels(labelsPath, store) {
  store.lastUpdated = Date.now();
  store.completed = Object.keys(store.labels).length;
  await mkdir(path.dirname(labelsPath), { recursive: true });
  await writeFile(labelsPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function truncate(s, n) {
  if (s == null) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
function indent(s, prefix) {
  return s
    .split(/\r?\n/)
    .map((line) => prefix + line)
    .join('\n');
}

// ---------- Build per-family sample ----------
// One hand-labeled item is keyed by `${patternKey}::${sessionId}::${userTurnIndex}`
// so the user labels each invocation (not just the family).
function makeItemId(patternKey, sessionId, userTurnIndex) {
  return `${patternKey}::${sessionId}::${userTurnIndex ?? 0}`;
}

function flattenItemsByFamily(playbookFile) {
  const byFamily = new Map(); // patternKey -> items[]
  for (const fam of playbookFile.patterns ?? []) {
    const items = [];
    for (const hit of fam.hits ?? []) {
      items.push({
        id: makeItemId(fam.patternKey, hit.sessionId, hit.userTurnIndex),
        patternKey: fam.patternKey,
        familyLabel: fam.label,
        familyDescription: fam.description,
        familyAudit: fam.audit ?? null,
        sessionId: hit.sessionId,
        userTurnIndex: hit.userTurnIndex,
        lineNumber: hit.lineNumber,
        phrase: hit.phrase,
        excerpt: hit.excerpt,
      });
    }
    byFamily.set(fam.patternKey, { family: fam, items });
  }
  return byFamily;
}

// Last user-prompt sample for a session — pulled from manifest.userTextSamples
// (already on disk; no transcript re-read required).
function lastUserSample(sessionEntry) {
  const samples = sessionEntry?.userTextSamples;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  return samples[samples.length - 1];
}

// ---------- Classify regex-fixable vs structural ----------
// Heuristic: if the hand-labeled "method-effective" rate is within
// ±10% of the auditor's reported pass-rate, the discrepancy is
// small — regex-fixable (or no discrepancy at all). If the gap is
// >10%, the regex is mis-firing on cases the hand-labels say aren't
// real method invocations — structural problem (would need
// embeddings clustering to separate good from bad invocations).
const REGEX_FIXABLE_GAP = 0.1;
function classifyFamily(handRate, auditRate) {
  if (handRate === null || auditRate === null) return 'insufficient-data';
  const gap = Math.abs(handRate - auditRate);
  return gap <= REGEX_FIXABLE_GAP ? 'regex-fixable' : 'structural';
}

// ---------- Hand-label loop for one family ----------
async function labelFamily(famKey, famData, sessionsById, store, labelsPath, perFamily, seed) {
  const sampled = sampleN(famData.items, Math.min(perFamily, famData.items.length), `${seed}::${famKey}`);
  const remaining = sampled.filter((it) => store.labels[it.id] === undefined);
  if (remaining.length === 0) {
    return { sampled, alreadyLabeled: true };
  }

  let i = 0;
  while (i < sampled.length) {
    const item = sampled[i];
    if (store.labels[item.id] !== undefined) {
      i += 1;
      continue;
    }
    const session = sessionsById.get(item.sessionId);
    const lastSample = lastUserSample(session);

    process.stdout.write(ANSI.clear);
    console.log(
      `${col('bold', `[${famKey}]`)}  ${col('magenta', famData.family.label)}  ${col('gray', `(${i + 1}/${sampled.length})`)}`,
    );
    console.log(col('gray', famData.family.description ?? ''));
    if (famData.family.audit) {
      const a = famData.family.audit;
      const pr = (a.passRate ?? 0) * 100;
      console.log(
        col('gray', `auditor rate: ${pr.toFixed(1)}% pass  (${a.pass}/${(a.pass ?? 0) + (a.fail ?? 0) + (a.inconclusive ?? 0)})`),
      );
    }
    console.log(rule());
    console.log(
      `${col('cyan', 'TITLE: ')}${col('bold', truncate(session?.title ?? '(no title)', 90))}`,
    );
    console.log(col('gray', `session ${item.sessionId} · turn ${item.userTurnIndex} · line ${item.lineNumber}`));
    console.log();
    console.log(col('green', 'INVOCATION:'));
    console.log(indent(truncate(item.excerpt ?? item.phrase ?? '', 480), '> '));
    if (lastSample) {
      console.log();
      console.log(col('yellow', 'LAST USER PROMPT IN SESSION:'));
      console.log(indent(truncate(lastSample, 320), '> '));
    }
    console.log();
    console.log(
      col('dim', 'g=good (method worked)  b=bad (didn\'t / casual)  s=skip  q=save&quit  ←=back'),
    );
    process.stdout.write('> ');

    const key = await readKey();
    const lower = (key ?? '').trim().toLowerCase();

    if (lower === 'q') return { sampled, alreadyLabeled: false, quit: true };
    if (key === '[D' || lower === '' || lower === 'p') {
      if (i > 0) {
        delete store.labels[sampled[i - 1].id];
        await saveLabels(labelsPath, store);
        i -= 1;
      }
      continue;
    }
    if (lower === 's') {
      i += 1;
      continue;
    }
    if (lower === 'g' || lower === 'b') {
      store.labels[item.id] = {
        patternKey: famKey,
        effective: lower === 'g',
        labeledAt: Date.now(),
      };
      await saveLabels(labelsPath, store);
      i += 1;
      continue;
    }
    // Unknown key — re-prompt.
  }
  return { sampled, alreadyLabeled: false };
}

// ---------- Markdown report ----------
function todayISODate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function summarizeByFamily(playbookByFamily, store) {
  const rows = [];
  for (const [famKey, famData] of playbookByFamily) {
    const labels = [];
    for (const item of famData.items) {
      const lab = store.labels[item.id];
      if (lab !== undefined) labels.push(lab);
    }
    const labeledN = labels.length;
    const labeledGood = labels.filter((l) => l.effective === true).length;
    const handRate = labeledN > 0 ? labeledGood / labeledN : null;
    const ci = labeledN > 0 ? wilsonCI(handRate, labeledN) : null;

    const aud = famData.family.audit ?? null;
    const auditPass = aud?.pass ?? 0;
    const auditFail = aud?.fail ?? 0;
    const auditInc = aud?.inconclusive ?? 0;
    const auditTotal = auditPass + auditFail + auditInc;
    const auditRate = auditTotal > 0 ? auditPass / auditTotal : null;

    rows.push({
      patternKey: famKey,
      label: famData.family.label,
      hitsTotal: famData.items.length,
      labeledN,
      labeledGood,
      handRate,
      ci,
      auditRate,
      auditPass,
      auditFail,
      auditInc,
      classification: classifyFamily(handRate, auditRate),
    });
  }
  return rows;
}

function renderMarkdown(rows, args, generatedAtMs) {
  const lines = [];
  const date = todayISODate();
  lines.push(`# Playbook recall audit — ${date}`);
  lines.push('');
  lines.push(
    `Hand-label gate for the #7 calibration step in the outcome-substrate roadmap. Compares the playbook auditor's reported pass-rate against a deterministic ${args.perFamily}-sample-per-family hand-label rating of *whether the method appeared effective in context*.`,
  );
  lines.push('');
  lines.push(
    `**Classification rule:** family is *regex-fixable* when the gap between hand-rate and auditor-rate is within ±${(REGEX_FIXABLE_GAP * 100).toFixed(0)}% — the regex catalogue captures the right invocations and the auditor's signal is the bottleneck (or already correct). Family is *structural* when the gap exceeds ±${(REGEX_FIXABLE_GAP * 100).toFixed(0)}% — the regex catches casual phrasings the hand-label rejects, so an embeddings-clustering pass is needed to separate real invocations from coincidental matches.`,
  );
  lines.push('');
  lines.push(`Generated: ${new Date(generatedAtMs).toISOString()}  ·  data dir: \`${args.dataDir}\`  ·  seed: \`${args.seed}\``);
  lines.push('');
  lines.push('## Per-family results');
  lines.push('');
  lines.push('| family | hand-rate (n) | 95% CI | auditor-rate | gap | classification |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const handStr =
      r.handRate === null
        ? '—'
        : `${(r.handRate * 100).toFixed(1)}% (${r.labeledGood}/${r.labeledN})`;
    const ciStr =
      r.ci === null ? '—' : `[${(r.ci.low * 100).toFixed(1)}, ${(r.ci.high * 100).toFixed(1)}]`;
    const audStr =
      r.auditRate === null
        ? '—'
        : `${(r.auditRate * 100).toFixed(1)}% (${r.auditPass}/${r.auditPass + r.auditFail + r.auditInc})`;
    const gapStr =
      r.handRate === null || r.auditRate === null
        ? '—'
        : `${(Math.abs(r.handRate - r.auditRate) * 100).toFixed(1)}%`;
    lines.push(`| \`${r.patternKey}\` | ${handStr} | ${ciStr} | ${audStr} | ${gapStr} | ${r.classification} |`);
  }
  lines.push('');

  // Aggregate.
  const labeled = rows.filter((r) => r.handRate !== null);
  const totalLabeled = labeled.reduce((s, r) => s + r.labeledN, 0);
  const totalGood = labeled.reduce((s, r) => s + r.labeledGood, 0);
  const allHand = totalLabeled > 0 ? totalGood / totalLabeled : null;
  const regexFixable = rows.filter((r) => r.classification === 'regex-fixable').length;
  const structural = rows.filter((r) => r.classification === 'structural').length;
  const insufficient = rows.filter((r) => r.classification === 'insufficient-data').length;

  lines.push('## Aggregate');
  lines.push('');
  lines.push(`- families: ${rows.length}`);
  lines.push(`- labeled: ${totalLabeled} hits across ${labeled.length} families`);
  if (allHand !== null) {
    lines.push(`- overall hand-rate: ${(allHand * 100).toFixed(1)}% (${totalGood}/${totalLabeled})`);
  }
  lines.push(`- regex-fixable: ${regexFixable}`);
  lines.push(`- structural: ${structural}`);
  if (insufficient > 0) lines.push(`- insufficient labels: ${insufficient}`);
  lines.push('');

  // Verdict block.
  lines.push('## Verdict');
  lines.push('');
  if (insufficient > 0 && labeled.length < rows.length / 2) {
    lines.push(
      `**Insufficient data.** Re-run with hand-labels for the remaining families before drawing a conclusion.`,
    );
  } else if (structural === 0 && regexFixable > 0) {
    lines.push(
      `**All evaluated families are regex-fixable.** No new #7 code is needed. Tune \`CLAIM_PATTERNS\` in \`packages/analysis/src/auditConfig.ts\` to close the auditor-side gap (where present) and stop.`,
    );
  } else if (structural >= Math.ceil(labeled.length / 2)) {
    lines.push(
      `**Structural problem dominates.** ${structural} of ${labeled.length} evaluated families show a >${(REGEX_FIXABLE_GAP * 100).toFixed(0)}% gap between hand-rate and auditor-rate, indicating the regex catalogue catches casual phrasings the hand-label rejects. Proceed with the embeddings-clustering extension to \`detectPlaybookCandidates.ts\` — NOT a parallel \`prompt-patterns.json\`.`,
    );
  } else {
    lines.push(
      `**Mixed.** ${regexFixable} regex-fixable, ${structural} structural. The structural cases (${rows.filter((r) => r.classification === 'structural').map((r) => `\`${r.patternKey}\``).join(', ')}) likely warrant an embeddings pass; the regex-fixable cases can be tuned in \`CLAIM_PATTERNS\` first.`,
    );
  }
  lines.push('');

  // Methodology note.
  lines.push('## Methodology');
  lines.push('');
  lines.push(
    `- Sampled ${args.perFamily} hits per family with deterministic seed \`${args.seed}\` (mulberry32 / Fisher-Yates partial shuffle).`,
  );
  lines.push(
    `- Each item shown with: manifest title, the invocation excerpt (≤480 chars), the *last user prompt* of that session (from \`userTextSamples\` ≤320 chars, used as a coarse "did the session conclude well" proxy).`,
  );
  lines.push(
    `- Hand-label \`g\` = method appeared effective in context (steered the session toward a useful next step); \`b\` = casual phrasing / coincidence / no apparent steering.`,
  );
  lines.push(
    `- 95% CIs computed via Wilson interval (z=${Z_95}). Auditor-rate is \`pass / (pass + fail + inconclusive)\` from the \`audit\` field on each pattern in \`playbook-candidates.json\`.`,
  );
  lines.push('');

  return lines.join('\n') + '\n';
}

// ---------- Main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirAbs = path.resolve(repoRoot, args.dataDir);

  const playbookPath = path.join(dataDirAbs, 'analysis', 'playbook-candidates.json');
  const manifestPath = path.join(dataDirAbs, 'manifest.json');

  // Default labels file lives under research/ so the markdown + the
  // backing JSON sit side by side. Resume with --labels-file <path>.
  const labelsDefault = path.join(
    repoRoot,
    'research',
    `playbook-recall-audit-${todayISODate()}.labels.json`,
  );
  const labelsPath = path.resolve(repoRoot, args.labelsFile ?? labelsDefault);
  const reportPath = path.join(
    repoRoot,
    'research',
    `playbook-recall-audit-${todayISODate()}.md`,
  );

  let playbookFile;
  try {
    playbookFile = JSON.parse(await readFile(playbookPath, 'utf8'));
  } catch (err) {
    console.error(col('red', `\nCould not read ${playbookPath}: ${err.message}`));
    console.error(
      col('dim', 'Run `pnpm exporter run start` first to produce playbook-candidates.json.'),
    );
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sessionsById = new Map(manifest.sessions.map((s) => [s.id, s]));
  const byFamily = flattenItemsByFamily(playbookFile);
  const store = await loadLabels(labelsPath);

  if (args.reportOnly) {
    const rows = summarizeByFamily(byFamily, store);
    const md = renderMarkdown(rows, args, Date.now());
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, md, 'utf8');
    console.log(col('green', `\nReport written to ${reportPath}`));
    console.log(col('dim', `(labels: ${labelsPath})`));
    return;
  }

  console.log(col('bold', `\nPlaybook recall audit — ${todayISODate()}`));
  console.log(`families: ${byFamily.size}  ·  per-family target: ${args.perFamily}`);
  console.log(`labels: ${labelsPath}`);
  console.log(`report: ${reportPath}`);
  console.log();

  let quit = false;
  for (const [famKey, famData] of byFamily) {
    if (quit) break;
    const out = await labelFamily(
      famKey,
      famData,
      sessionsById,
      store,
      labelsPath,
      args.perFamily,
      args.seed,
    );
    if (out.quit) quit = true;
  }

  // Write the markdown report regardless of whether the user quit
  // early — partial reports are useful too (they'll show fewer rows
  // with labels but include all families' auditor-rates).
  const rows = summarizeByFamily(byFamily, store);
  const md = renderMarkdown(rows, args, Date.now());
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, md, 'utf8');

  console.log();
  console.log(col('green', `Report written to ${reportPath}`));
  console.log(col('dim', `(labels saved at ${labelsPath})`));
  if (existsSync(reportPath)) {
    const stat = (await readFile(reportPath, 'utf8')).length;
    console.log(col('dim', `(${stat} bytes)`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
