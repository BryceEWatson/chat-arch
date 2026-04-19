/**
 * Deterministic generator for realistic-manifest.json.
 *
 * Run `node test/fixtures/generate-manifest.mjs` from packages/viewer/ to regenerate.
 * The produced file is committed and is the source of truth for tests and the
 * dev harness. Entries are synthetic / redacted — no data from real sessions.
 *
 * Coverage targets:
 *   - 100 entries total: 30 cloud / 30 cowork / 20 cli-direct / 20 cli-desktop
 *   - Date spread 2023-03-01 .. 2026-04-15, weighted recent
 *   - Edge cases:
 *       * 2 entries with titleSource:'fallback' (empty/placeholder title)
 *       * 1 entry with preview: null
 *       * 1 entry with topTools: {}
 *       * cost spread: null, 0 (meaningful), and positive numbers
 *       * models include '[1m]' context-length suffix on one cli-desktop
 *       * CLI cwds contain '.' and '_' characters (lossy-path avoidance)
 *   - Drill-in pointers that match files in conversations/ and local-transcripts/
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'realistic-manifest.json');

// --- deterministic pseudo-random ---
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xc0ffee);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function uuid(i, prefix = '') {
  // Deterministic, human-skimmable synthetic UUIDs.
  const h = (n) => n.toString(16).padStart(4, '0');
  const p = Math.floor(rand() * 0xffff);
  const a = h(0x1000 + i);
  const b = h(p);
  const c = h(0x2000 + i);
  const d = h((p * 3) & 0xffff);
  return `${prefix}${a}${b.slice(0, 4)}-${a}-4${b.slice(1)}-8${c.slice(1)}-${d}${a}${b}`;
}

// Date spread: weighted-recent. 50% in last 6mo, 30% previous year, 20% older.
function weightedDate(i, total) {
  const END = Date.parse('2026-04-15T00:00:00Z');
  const MID = Date.parse('2025-10-01T00:00:00Z');
  const BEGIN_OLD = Date.parse('2024-04-15T00:00:00Z');
  const OLDEST = Date.parse('2023-03-01T00:00:00Z');
  const r = rand();
  let t;
  if (r < 0.5) t = MID + (END - MID) * rand();
  else if (r < 0.8) t = BEGIN_OLD + (MID - BEGIN_OLD) * rand();
  else t = OLDEST + (BEGIN_OLD - OLDEST) * rand();
  return Math.floor(t);
}

const TITLES = [
  'Refactor archive-scan worker-pool limiter',
  'Debug flaky websocket reconnection',
  'Plan migration from REST to GraphQL',
  'Design telemetry pipeline for edge agents',
  'Review PR: auth middleware rewrite',
  'Write Terraform for GCP Cloud Run deploy',
  'Investigate memory leak in export pipeline',
  'Draft RFC: typed event bus',
  'Prototype Astro static viewer',
  'Fix race condition in session manifest writer',
  'Postgres index tuning for timeline query',
  'Add OpenTelemetry spans to ingestion job',
  'Document onboarding for new contributors',
  'Audit secrets handling in CI',
  'Explore high-contrast color palette for admin UI',
  'Migrate fixture data to synthetic corpus',
  'Benchmark JSONL streaming parser',
  'Reproduce intermittent 503 in staging',
  'Design contract for conversation export',
  'Unified schema for four session sources',
  'Prompt engineering for summary extraction',
  'Retry storm post-mortem',
  'Vendor-drift audit of OpenAI proxy',
  'Wire up sparkline in viewer top panel',
  'Consolidate date-utility helpers',
  'Measure bundle size regression',
];
const PREVIEWS = [
  'Sample prompt about architecture patterns and how to enforce invariants at the type level.',
  'Follow-up on yesterday\u2019s discussion about the worker-pool queueing behavior.',
  'User wants help drafting a migration plan that keeps rollbacks cheap.',
  'Investigating why the ingest job silently drops messages under load.',
  'Designing a telemetry pipeline without vendor lock-in; comparing approaches.',
  'Refactor hinges on splitting the mixed concerns in the orchestrator.',
  'Discussion of contrast ratios and palette usage in accessible UIs.',
  'Clarifying the difference between user turns and assistant turns in the schema.',
  'Working through a tricky bug where retries accumulate duplicate side effects.',
  'Exploring the trade-off between eager and lazy fetching for conversation bodies.',
];
const SUMMARIES = [
  'Comprehensive analysis of architectural options and their trade-offs; concluded with a recommended path forward.',
  'Extended troubleshooting session; root cause identified in the retry policy and patched.',
  'Design sketch for a typed event bus; captured open questions and next steps.',
  'Review of integration tests; migrated brittle tests to hermetic fixtures.',
];
const TOPTOOLS_POOL = [
  { Read: 12, Edit: 8, Grep: 5 },
  { Bash: 20, Read: 7, Write: 3 },
  { WebFetch: 4, Read: 9 },
  { Read: 30, Edit: 15, Grep: 10, Bash: 4, Write: 3, Glob: 2 },
];
const CLOUD_MODELS = [null, 'claude-opus-4-5', 'claude-sonnet-4-5'];
const CLI_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-7',
  'claude-opus-4-7[1m]', // context-length suffix — must round-trip verbatim
  'claude-haiku-4-5',
];
const COWORK_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6', null];

const CLI_PROJECTS = [
  { cwd: 'C:/Users/example/Projects/chat-arch', project: 'chat-arch' },
  { cwd: 'C:/Users/example/Projects/my.dotted.project', project: 'my.dotted.project' },
  { cwd: 'C:/Users/example/Projects/snake_case_proj', project: 'snake_case_proj' },
  { cwd: '/home/example/work/analytics.v2', project: 'analytics.v2' },
  { cwd: '/home/example/work/graphql_gateway', project: 'graphql_gateway' },
];

const sessions = [];

// --- 30 cloud ---
const CLOUD_DRILLIN_IDS = [];
for (let i = 0; i < 30; i++) {
  const id = uuid(i, 'c');
  const updated = weightedDate(i, 30);
  const started = updated - Math.floor(rand() * 1000 * 60 * 45);
  const hasSummary = i < 10;
  const hasTopTools = i >= 5 && i < 10;
  const emptyTopTools = i === 9;
  const fallbackTitle = i === 28; // 1 cloud with fallback title
  const nullPreview = i === 17;
  const hasModel = i % 3 !== 0;
  const userTurns = 2 + Math.floor(rand() * 40);
  const assistantTurns = userTurns + (rand() < 0.5 ? 0 : 1);
  const cost = i === 3 ? 0 : i === 7 ? 4.8732 : i % 4 === 0 ? null : Math.round(rand() * 500) / 100;
  const entry = {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: started,
    updatedAt: updated,
    durationMs: updated - started,
    title: fallbackTitle ? 'Untitled session' : pick(TITLES),
    titleSource: fallbackTitle ? 'fallback' : 'cloud-name',
    preview: nullPreview ? null : pick(PREVIEWS),
    userTurns,
    assistantTurns,
    model: hasModel ? pick(CLOUD_MODELS.filter(Boolean)) : null,
    cwdKind: 'none',
    totalCostUsd: cost,
  };
  // Only the first 3 cloud sessions have a real companion fixture file on
  // disk (conversations/<id>.json). Advertising transcriptPath without the
  // file would 404 at fetch time and surface as "TRANSCRIPT ERROR"; leaving
  // it off lets the viewer render the graceful DetailMissing state instead.
  if (i < 3) {
    entry.transcriptPath = `cloud-conversations/${id}.json`;
    CLOUD_DRILLIN_IDS.push(id);
  }
  if (hasSummary) entry.summary = pick(SUMMARIES);
  if (hasTopTools) entry.topTools = emptyTopTools ? {} : pick(TOPTOOLS_POOL);
  sessions.push(entry);
}

// --- 30 cowork ---
for (let i = 0; i < 30; i++) {
  const id = uuid(30 + i, 'w');
  const updated = weightedDate(30 + i, 30);
  const started = updated - Math.floor(rand() * 1000 * 60 * 90);
  const userTurns = 1 + Math.floor(rand() * 25);
  const assistantTurns = userTurns;
  const proj = `process-${(i % 7) + 1}`;
  const fallbackTitle = i === 2; // 1 cowork with fallback title
  const cost = i < 20 ? Math.round(rand() * 200) / 100 : null; // 20 with cost, 10 null
  const entry = {
    id,
    source: 'cowork',
    rawSessionId: `local_${id}`,
    startedAt: started,
    updatedAt: updated,
    durationMs: updated - started,
    title: fallbackTitle ? 'Untitled session' : pick(TITLES),
    titleSource: fallbackTitle ? 'fallback' : 'manifest',
    preview: pick(PREVIEWS),
    userTurns,
    assistantTurns,
    model: pick(COWORK_MODELS),
    cwd: `/sessions/${proj}`,
    cwdKind: 'vm',
    totalCostUsd: cost,
  };
  if (i === 0) entry.transcriptPath = `local-transcripts/cowork/${id}.jsonl`;
  sessions.push(entry);
}

// --- 20 cli-direct ---
for (let i = 0; i < 20; i++) {
  const id = uuid(60 + i, 'd');
  const updated = weightedDate(60 + i, 20);
  const started = updated - Math.floor(rand() * 1000 * 60 * 60);
  const userTurns = 1 + Math.floor(rand() * 18);
  const { cwd, project } = CLI_PROJECTS[i % CLI_PROJECTS.length];
  const entry = {
    id,
    source: 'cli-direct',
    rawSessionId: id,
    startedAt: started,
    updatedAt: updated,
    durationMs: updated - started,
    title: pick(TITLES),
    titleSource: i % 3 === 0 ? 'ai-title' : 'first-prompt',
    preview: pick(PREVIEWS),
    userTurns,
    assistantTurns: userTurns,
    model: pick(CLI_MODELS),
    cwd,
    cwdKind: 'host',
    project,
    totalCostUsd: null,
  };
  if (i === 0) entry.transcriptPath = `local-transcripts/cli-direct/${id}.jsonl`;
  sessions.push(entry);
}

// --- 20 cli-desktop (all userTurns > 0 per Phase 3 post-pass) ---
for (let i = 0; i < 20; i++) {
  const id = uuid(80 + i, 'k');
  const updated = weightedDate(80 + i, 20);
  const started = updated - Math.floor(rand() * 1000 * 60 * 60);
  const userTurns = 1 + Math.floor(rand() * 20); // always > 0
  const assistantTurns = userTurns + (rand() < 0.5 ? 0 : 1);
  const { cwd, project } = CLI_PROJECTS[(i + 2) % CLI_PROJECTS.length];
  const modelIdx = i === 4 ? 2 : i % CLI_MODELS.length; // force one [1m] suffix
  const entry = {
    id,
    source: 'cli-desktop',
    rawSessionId: `local_${id}`,
    startedAt: started,
    updatedAt: updated,
    durationMs: updated - started,
    title: pick(TITLES),
    titleSource: 'manifest',
    preview: pick(PREVIEWS),
    userTurns,
    assistantTurns,
    model: CLI_MODELS[modelIdx],
    cwd,
    cwdKind: 'host',
    project,
    totalCostUsd: i % 5 === 0 ? null : Math.round(rand() * 300) / 100,
  };
  if (i === 0) entry.transcriptPath = `local-transcripts/cli-desktop/${id}.jsonl`;
  sessions.push(entry);
}

const manifest = {
  schemaVersion: 1,
  generatedAt: Date.parse('2026-04-15T12:00:00Z'),
  counts: {
    cloud: sessions.filter((s) => s.source === 'cloud').length,
    cowork: sessions.filter((s) => s.source === 'cowork').length,
    'cli-direct': sessions.filter((s) => s.source === 'cli-direct').length,
    'cli-desktop': sessions.filter((s) => s.source === 'cli-desktop').length,
  },
  sessions,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');

// Emit the drill-in target IDs to stdout so we can keep drill-in files in sync.
const coworkFirst = sessions.find((s) => s.source === 'cowork' && s.transcriptPath);
const cliDirectFirst = sessions.find((s) => s.source === 'cli-direct' && s.transcriptPath);
const cliDesktopFirst = sessions.find((s) => s.source === 'cli-desktop' && s.transcriptPath);
console.log('cloud drill-in ids:', CLOUD_DRILLIN_IDS.join(', '));
console.log('cowork drill-in id:', coworkFirst?.id);
console.log('cli-direct drill-in id:', cliDirectFirst?.id);
console.log('cli-desktop drill-in id:', cliDesktopFirst?.id);
console.log(`Wrote ${sessions.length} entries to ${OUT}`);
