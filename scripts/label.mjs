#!/usr/bin/env node
/**
 * Interactive labeling TUI for the three human-gated datasets that
 * the analysis pipeline needs for calibration:
 *
 *   - corrections gold set (~100 items): is each correction candidate
 *     an actionable correction-to-AI? + what kind?
 *   - playbook gold set (~50 items): did each user invocation actually
 *     precede a real strategy shift (vs. casual phrase)?
 *   - threshold pairs (~100 items): is each session pair in the 0.85–
 *     0.97 cosine band a near-duplicate?
 *
 * Single-keypress UX:
 *   y/n   = label
 *   s     = skip (no label written; can revisit later)
 *   q     = save and quit
 *   1-7   = kind label (corrections only, after 'y')
 *   ←     = re-label the previous item
 *
 * Resumable: every keypress writes the current state to
 * `apps/standalone/public/chat-arch-data/labels/<task>-labels.json`
 * (gitignored). Re-running skips already-labeled IDs by default.
 *
 * Usage:
 *   node scripts/label.mjs corrections [--n 100] [--data-dir <path>]
 *   node scripts/label.mjs playbook    [--n 50]
 *   node scripts/label.mjs threshold   [--n 100] [--band 0.85,0.97]
 *
 * Or via the npm shortcuts (see root package.json):
 *   pnpm label:corrections
 *   pnpm label:playbook
 *   pnpm label:threshold
 *
 * Pure ESM, no deps beyond node:* — runs anywhere Node 18+ runs.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// ---------- ANSI ----------
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  clear: '\x1b[2J\x1b[H',
};
const c = (col, s) => `${ANSI[col]}${s}${ANSI.reset}`;
const rule = () => c('gray', '─'.repeat(70));

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const task = argv[2];
  const out = { task, n: null, dataDir: null, band: null, strata: null };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--n') out.n = Number(argv[++i]);
    else if (argv[i] === '--data-dir') out.dataDir = argv[++i];
    else if (argv[i] === '--band') out.band = argv[++i];
    else if (argv[i] === '--strata') out.strata = Number(argv[++i]);
  }
  return out;
}

function usage() {
  process.stderr.write(
    `Usage:\n` +
      `  node scripts/label.mjs corrections [--n 100] [--data-dir <path>]\n` +
      `  node scripts/label.mjs playbook    [--n 50]\n` +
      `  node scripts/label.mjs threshold   [--n 100] [--band 0.85,1.0] [--strata 4]\n`,
  );
  process.exit(2);
}

// ---------- Keypress reader ----------
//
// Two modes:
//   - TTY: setRawMode(true), one byte/key per data event, resolve as soon
//     as a key arrives.
//   - Non-TTY (piped stdin, used for testing): buffer the stream and emit
//     one logical key per resolution. Strip whitespace separators so a
//     `printf "y\n1\nq\n"` test fixture acts like three TTY keypresses.
const stdinBuffer = { keys: [], closed: false, listening: false };

function ensureNonTtyListener() {
  if (stdinBuffer.listening) return;
  stdinBuffer.listening = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    for (const ch of String(chunk)) {
      // Skip whitespace separators in non-TTY mode so multi-byte fixtures
      // (`y\n1\n`) replay as discrete keys. Real interactive sessions go
      // through the TTY branch where setRawMode delivers one byte per
      // press without any separators.
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
  // If stdin closed and nothing left, resolve waiters with sentinel 'q'
  // so the script saves and exits gracefully rather than hanging.
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

// ---------- Task: corrections ----------
async function taskCorrections(opts) {
  const dataDir =
    opts.dataDir ?? path.join('apps', 'standalone', 'public', 'chat-arch-data');
  const candPath = path.join(dataDir, 'analysis', 'correction-candidates.json');
  const manifestPath = path.join(dataDir, 'manifest.json');
  const labelsPath = path.join(dataDir, 'labels', 'corrections-gold.json');
  const n = opts.n ?? 100;

  const candFile = JSON.parse(await readFile(candPath, 'utf8'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sessionsById = new Map(manifest.sessions.map((s) => [s.id, s]));

  const store = await loadLabels(labelsPath);
  // The exporter writes `corrections: [...]` (per CorrectionsFile in
  // packages/schema/src/correction.ts). Earlier drafts of this script
  // looked for `candidates: [...]` — preserve a fallback in case a
  // future schema bump renames the field.
  const pool = candFile.corrections ?? candFile.candidates ?? [];
  const candidates = pool.filter((c) => !store.labels[c.id]);

  if (candidates.length === 0) {
    console.log(c('green', `\nNo unlabeled candidates. ${store.completed} already labeled.\n`));
    return;
  }

  // Reservoir-sample up to n candidates (deterministic seed for repro).
  const sampled = sampleN(candidates, Math.min(n, candidates.length), 'seed-corrections');

  console.log(
    c('bold', `\nLabeling ${sampled.length} corrections.`) +
      ` Output: ${c('cyan', labelsPath)}\n`,
  );
  printKeyLegend('corrections');

  let i = 0;
  while (i < sampled.length) {
    const cand = sampled[i];
    const session = sessionsById.get(cand.sessionId);

    process.stdout.write(ANSI.clear);
    console.log(
      `${c('bold', `[${i + 1}/${sampled.length}]`)}  ${c('gray', cand.id)}  ${c('gray', '·')}  ${c('cyan', truncate(session?.title ?? '(unknown)', 50))}`,
    );
    if (cand.signals?.length) {
      console.log(
        c('gray', `signals: ${cand.signals.map((s) => s.kind).join(', ')}`),
      );
    }
    console.log(rule());

    if (cand.precedingAssistantExcerpt) {
      console.log(c('yellow', 'PRIOR ASSISTANT:'));
      console.log(indent(cand.precedingAssistantExcerpt, '> '));
      console.log();
    }
    console.log(c('green', 'USER:'));
    console.log(indent(cand.excerpt ?? '', '> '));
    console.log();
    console.log(c('dim', 'y=actionable  n=not  s=skip  q=save&quit  ←=back'));
    process.stdout.write('> ');

    const key = await readKey();
    const lower = key.trim().toLowerCase();

    if (lower === 'q') break;
    if (key === '[D' || key === 'b') {
      // back arrow or 'b' — revisit the previous item
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
    if (lower === 'n') {
      store.labels[cand.id] = { actionable: false, kind: null };
      await saveLabels(labelsPath, store);
      i += 1;
      continue;
    }
    if (lower === 'y') {
      // Solicit kind 1-7
      console.log();
      console.log(
        c(
          'dim',
          'kind:  1=behavior  2=format  3=tool  4=factual  5=tone  6=process  7=other  (s=skip kind)',
        ),
      );
      process.stdout.write('> ');
      const kindKey = await readKey();
      const kindMap = {
        1: 'behavior-rule',
        2: 'output-format',
        3: 'tool-preference',
        4: 'factual-fix',
        5: 'tone',
        6: 'process',
        7: 'other',
      };
      const kind = kindMap[kindKey] ?? null;
      store.labels[cand.id] = { actionable: true, kind };
      await saveLabels(labelsPath, store);
      i += 1;
      continue;
    }
    // Unknown key — re-prompt the same item.
  }

  const summary = summarize(store.labels, ['actionable', 'kind']);
  console.log(c('green', `\nSaved ${store.completed} labels to ${labelsPath}`));
  console.log(c('dim', JSON.stringify(summary, null, 2)));
}

// ---------- Task: playbook ----------
async function taskPlaybook(opts) {
  const dataDir =
    opts.dataDir ?? path.join('apps', 'standalone', 'public', 'chat-arch-data');
  const playbookPath = path.join(dataDir, 'analysis', 'playbook-candidates.json');
  const auditPath = path.join(dataDir, 'analysis', 'audit-results.json');
  const manifestPath = path.join(dataDir, 'manifest.json');
  const labelsPath = path.join(dataDir, 'labels', 'playbook-gold.json');
  const n = opts.n ?? 50;

  let pbFile;
  try {
    pbFile = JSON.parse(await readFile(playbookPath, 'utf8'));
  } catch (err) {
    console.error(c('red', `\nCould not read ${playbookPath}: ${err.message}`));
    console.error(
      c('dim', 'Run `pnpm exporter run start` first to produce playbook-candidates.json.'),
    );
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sessionsById = new Map(manifest.sessions.map((s) => [s.id, s]));

  // Best-effort: load audit verdicts so we can show pass/fail per session.
  let verdictBySession = new Map();
  try {
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    for (const r of audit.results ?? []) {
      const cur = verdictBySession.get(r.sessionId) ?? { pass: 0, total: 0 };
      cur.total += 1;
      if (r.outcome === 'pass') cur.pass += 1;
      verdictBySession.set(r.sessionId, cur);
    }
  } catch {
    /* audit-results may be absent; show "unknown" verdict */
  }

  const store = await loadLabels(labelsPath);
  // PlaybookCandidatesFile shape (packages/schema/src/playbook.ts):
  //   { patterns: [{ patternKey, label, hits: [{ sessionId, userTurnIndex, lineNumber, phrase, excerpt }], ... }] }
  // Flatten into per-hit items so we label each invocation, not each pattern.
  const items = [];
  for (const pat of pbFile.patterns ?? []) {
    for (const hit of pat.hits ?? []) {
      const id = `${pat.patternKey}::${hit.sessionId}::${hit.userTurnIndex ?? 0}`;
      if (store.labels[id]) continue;
      items.push({ id, patternKey: pat.patternKey, ...hit });
    }
  }
  if (items.length === 0) {
    console.log(c('green', `\nNo unlabeled playbook hits. ${store.completed} already labeled.\n`));
    return;
  }

  const sampled = sampleN(items, Math.min(n, items.length), 'seed-playbook');

  console.log(
    c('bold', `\nLabeling ${sampled.length} playbook invocations.`) +
      ` Output: ${c('cyan', labelsPath)}\n`,
  );
  printKeyLegend('playbook');

  let i = 0;
  while (i < sampled.length) {
    const item = sampled[i];
    const session = sessionsById.get(item.sessionId);
    const verdict = verdictBySession.get(item.sessionId);
    const verdictStr = verdict
      ? `audit: ${verdict.pass}/${verdict.total} pass`
      : 'audit: unknown';

    process.stdout.write(ANSI.clear);
    console.log(
      `${c('bold', `[${i + 1}/${sampled.length}]`)}  ${c('magenta', item.patternKey)}  ${c('gray', '·')}  ${c('cyan', truncate(session?.title ?? '(unknown)', 40))}  ${c('gray', `(${verdictStr})`)}`,
    );
    console.log(rule());
    console.log(c('green', 'USER INVOCATION:'));
    console.log(indent(item.excerpt ?? item.phrase ?? '', '> '));
    console.log();
    console.log(
      c(
        'dim',
        'y=real strategy shift  n=casual phrase / coincidence  s=skip  q=save&quit  ←=back',
      ),
    );
    process.stdout.write('> ');

    const key = await readKey();
    const lower = key.trim().toLowerCase();
    if (lower === 'q') break;
    if (key === '[D' || key === 'b') {
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
    if (lower === 'y' || lower === 'n') {
      store.labels[item.id] = {
        strategyShift: lower === 'y',
        patternKey: item.patternKey,
      };
      await saveLabels(labelsPath, store);
      i += 1;
      continue;
    }
  }

  console.log(c('green', `\nSaved ${store.completed} labels to ${labelsPath}`));
}

// ---------- Task: threshold pairs ----------
async function taskThreshold(opts) {
  const dataDir =
    opts.dataDir ?? path.join('apps', 'standalone', 'public', 'chat-arch-data');
  const metaPath = path.join(dataDir, 'analysis', 'embeddings.meta.json');
  const binPath = path.join(dataDir, 'analysis', 'embeddings.bin');
  const manifestPath = path.join(dataDir, 'manifest.json');
  const labelsPath = path.join(dataDir, 'labels', 'threshold-pairs.json');
  const n = opts.n ?? 100;
  const [bandLo, bandHi] = opts.band
    ? opts.band.split(',').map(Number)
    : [0.85, 1.0];
  const strata = Math.max(1, Math.floor(opts.strata ?? 4));
  const bucketBounds = computeBucketBounds([bandLo, bandHi], strata);

  let meta;
  let bin;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
    bin = await readFile(binPath);
  } catch (err) {
    console.error(c('red', `\nCould not read embeddings: ${err.message}`));
    console.error(
      c('dim', 'Run `pnpm exporter run start` with Ollama running first.'),
    );
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sessionsById = new Map(manifest.sessions.map((s) => [s.id, s]));

  // Read vectors.
  const dim = meta.dimensions;
  const stride = dim * 4;
  const vectors = [];
  for (const entry of meta.entries) {
    if (entry.offset + stride > bin.length) continue;
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = bin.readFloatLE(entry.offset + i * 4);
    // L2-normalize
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) v[i] /= norm;
    vectors.push({ sessionId: entry.sessionId, v });
  }

  console.log(c('dim', `Scanning ${vectors.length} embeddings for pairs in [${bandLo}, ${bandHi}]...`));

  // Find pairs in band. O(N²) but only at sample time; user's corpus
  // is ~1k so this is fine.
  const pairs = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      let dot = 0;
      const a = vectors[i].v;
      const b = vectors[j].v;
      for (let k = 0; k < dim; k++) dot += a[k] * b[k];
      // Inclusive at the top edge so cos=1.0 (perfect duplicates) and
      // the calibration band's terminal boundary are captured. Strict-
      // less-than would silently drop those — and they're exactly the
      // boilerplate/template false positives Task 2 is trying to surface.
      if (dot >= bandLo && dot <= bandHi) {
        pairs.push({
          id: `${vectors[i].sessionId}::${vectors[j].sessionId}`,
          a: vectors[i].sessionId,
          b: vectors[j].sessionId,
          cos: dot,
        });
      }
    }
  }

  const store = await loadLabels(labelsPath);
  const remaining = pairs.filter((p) => !store.labels[p.id]);
  if (remaining.length === 0) {
    console.log(c('green', `\nNo unlabeled pairs. ${store.completed} already labeled.\n`));
    printThresholdSweep(store.labels);
    return;
  }
  const sampled = stratifiedSample(
    remaining,
    Math.min(n, remaining.length),
    [bandLo, bandHi],
    strata,
    'seed-threshold',
  );

  console.log(
    c('bold', `\nLabeling ${sampled.length} pairs in cos[${bandLo}, ${bandHi}), stratified into ${strata} buckets:`) +
      ` Output: ${c('cyan', labelsPath)}`,
  );
  printBucketLegend(bucketBounds, sampled);
  console.log();

  let i = 0;
  while (i < sampled.length) {
    const pair = sampled[i];
    const sa = sessionsById.get(pair.a);
    const sb = sessionsById.get(pair.b);

    process.stdout.write(ANSI.clear);
    console.log(
      `${c('bold', `[${i + 1}/${sampled.length}]`)}  ${c('gray', `cos = ${pair.cos.toFixed(3)}`)}`,
    );
    console.log(rule());
    console.log(c('cyan', 'A: ') + (sa?.title ?? '(unknown)'));
    console.log(indent(truncate(sa?.preview ?? '', 200), '   '));
    console.log();
    console.log(c('magenta', 'B: ') + (sb?.title ?? '(unknown)'));
    console.log(indent(truncate(sb?.preview ?? '', 200), '   '));
    console.log();
    console.log(c('dim', 'y=near-duplicate  n=not  s=skip  q=save&quit  ←=back'));
    process.stdout.write('> ');

    const key = await readKey();
    const lower = key.trim().toLowerCase();
    if (lower === 'q') break;
    if (key === '[D' || key === 'b') {
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
    if (lower === 'y' || lower === 'n') {
      store.labels[pair.id] = {
        nearDup: lower === 'y',
        cos: pair.cos,
      };
      await saveLabels(labelsPath, store);
      i += 1;
      continue;
    }
  }

  console.log(c('green', `\nSaved ${store.completed} labels to ${labelsPath}`));
  // Bonus: compute precision-at-threshold sweep if we have enough data.
  printThresholdSweep(store.labels);
}

// ---------- Helpers ----------
function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function indent(s, prefix) {
  return s
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

// Mulberry32 PRNG so the sample is reproducible across runs.
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

function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function sampleN(arr, n, seedStr) {
  if (arr.length <= n) return arr;
  const rng = mulberry32(hashSeed(seedStr));
  // Fisher–Yates partial shuffle
  const copy = arr.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// Equal-width bucket bounds across [band[0], band[1]]. With band
// [0.85, 1.0] and strata 4 you get [0.85, 0.8875), [0.8875, 0.925),
// [0.925, 0.9625), [0.9625, 1.0]. The last bucket is closed on the
// right so cos = 1.0 (identical sessions) is still included.
export function computeBucketBounds(band, strata) {
  const width = (band[1] - band[0]) / strata;
  const out = [];
  for (let i = 0; i < strata; i++) {
    out.push({
      lo: band[0] + i * width,
      hi: band[0] + (i + 1) * width,
      isLast: i === strata - 1,
    });
  }
  return out;
}

export function bucketIndexFor(cos, band, strata) {
  if (strata <= 1) return 0;
  const width = (band[1] - band[0]) / strata;
  const idx = Math.floor((cos - band[0]) / width);
  return Math.max(0, Math.min(strata - 1, idx));
}

// Stratified-by-cosine-bucket sampling. Targets equal counts per
// bucket (floor(n/strata), with the remainder distributed to the
// lowest-index buckets). Falls back to whatever each bucket can
// supply when it has fewer pairs than the target — the deficit is
// reported by the caller, not silently re-routed to neighboring
// buckets, so the label distribution stays interpretable.
export function stratifiedSample(pairs, n, band, strata, seed) {
  if (strata <= 1) return sampleN(pairs, n, seed);
  const base = Math.floor(n / strata);
  const remainder = n - base * strata;
  const buckets = Array.from({ length: strata }, () => []);
  for (const p of pairs) {
    buckets[bucketIndexFor(p.cos, band, strata)].push(p);
  }
  const out = [];
  for (let i = 0; i < strata; i++) {
    const target = base + (i < remainder ? 1 : 0);
    const want = Math.min(target, buckets[i].length);
    out.push(...sampleN(buckets[i], want, `${seed}-bucket-${i}`));
  }
  return out;
}

function printBucketLegend(bounds, sampled) {
  // Show "[lo, hi): N sampled" per bucket so the labeler can see at
  // a glance that they're working a representative mix rather than
  // an uneven one (e.g. all the > 0.97 bucket would skew P upward).
  console.log(c('dim', '  buckets:'));
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i];
    const inBucket = sampled.filter(
      (p) => p.cos >= b.lo && (b.isLast ? p.cos <= b.hi : p.cos < b.hi),
    ).length;
    const close = b.isLast ? ']' : ')';
    console.log(
      c('dim', `    [${b.lo.toFixed(4)}, ${b.hi.toFixed(4)}${close}: ${inBucket} sampled`),
    );
  }
}

function printKeyLegend(task) {
  // Brief intro printed once before the loop starts.
  if (task === 'corrections') {
    console.log(
      c('dim', '— Labels save after every keypress; quit with q and resume later.'),
    );
  } else if (task === 'playbook') {
    console.log(
      c(
        'dim',
        '— "strategy shift" = the assistant materially changed approach (vs. just acknowledging the phrase).',
      ),
    );
  }
}

function summarize(labels, fields) {
  const out = {};
  for (const f of fields) out[f] = {};
  for (const v of Object.values(labels)) {
    for (const f of fields) {
      const key = String(v[f] ?? '(none)');
      out[f][key] = (out[f][key] ?? 0) + 1;
    }
  }
  out._total = Object.keys(labels).length;
  return out;
}

// Wilson score 95% CI for a binomial proportion p̂ over n samples.
// z = 1.96. Kept in sync with the TS copy in apps/standalone/src/
// pages/api/calibrate.ts — that one is the unit-tested source of
// truth.
export function wilsonCI(pHat, n, z = 1.96) {
  if (n <= 0) return { low: 0, high: 1 };
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function printThresholdSweep(labels) {
  const values = Object.values(labels);
  if (values.length < 20) {
    console.log(c('dim', `\n(threshold sweep needs ≥20 labels; have ${values.length})`));
    return;
  }
  const sorted = values
    .filter((v) => typeof v.cos === 'number')
    .sort((a, b) => a.cos - b.cos);
  // Sweep at 0.01-step thresholds and report precision @ threshold with
  // Wilson 95% CI — small-n point estimates in the [0.85, 0.97] band
  // are too noisy to interpret without a bound (Park et al. 2026 on
  // cosine anisotropy in mxbai-embed-large made this acute).
  console.log(c('bold', '\nPrecision sweep (threshold → precision [95% CI] · recall):'));
  for (let t = 0.85; t <= 1.0 + 1e-9; t += 0.01) {
    const above = sorted.filter((v) => v.cos >= t);
    if (above.length === 0) continue;
    const tp = above.filter((v) => v.nearDup === true).length;
    const total = above.length;
    const totalPos = sorted.filter((v) => v.nearDup === true).length;
    const precision = tp / total;
    const recall = totalPos > 0 ? tp / totalPos : 0;
    const ci = wilsonCI(precision, total);
    console.log(
      `  ${t.toFixed(2)}  ·  P=${precision.toFixed(2)} [${ci.low.toFixed(2)}–${ci.high.toFixed(2)}] · R=${recall.toFixed(2)} · n=${above.length}`,
    );
  }
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.task) usage();

  if (opts.task === 'corrections') await taskCorrections(opts);
  else if (opts.task === 'playbook') await taskPlaybook(opts);
  else if (opts.task === 'threshold') await taskThreshold(opts);
  else {
    console.error(c('red', `Unknown task: ${opts.task}`));
    usage();
  }
}

main().catch((err) => {
  console.error(c('red', `\nlabeler crashed: ${err.message}`));
  console.error(c('dim', err.stack));
  process.exit(1);
});
