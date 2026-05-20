#!/usr/bin/env node
/**
 * Lint guard against bare numeric constants in the analysis pipeline.
 *
 * Per the plan's "Tunable parameters" section: every numeric guard
 * lives in `packages/analysis/src/thresholds.ts`. Adding a bare
 * `if (n > 8)` or `score > 0.4` somewhere in the kernel/builder/viewer
 * layer makes it ungreppable when the value needs re-tuning.
 *
 * This linter scans `packages/{analysis,exporter,viewer}/src/**\/*.{ts,tsx}`
 * and flags numeric literals (integer or float) that aren't either:
 *
 *   (a) reached via `THRESHOLDS.…` dotted-path access on the surrounding
 *       line (loose heuristic — if THRESHOLDS appears on the line, we
 *       trust it);
 *   (b) defined inside `packages/analysis/src/thresholds.ts` itself;
 *   (c) a clearly mathematical constant — 0, 1, -1, 2 (common loop step),
 *       100 (percentage), 0.5 (midpoint), 1000 (ms<->s conversion); plus
 *       trivial array indices and negative-one sentinels.
 *
 * False positives are inevitable on a heuristic scan (e.g. test fixture
 * data, hardcoded version markers, schema version literals). The script
 * is informational at violation-density level — it exits ZERO when the
 * total flagged count stays below a budget (`MAX_FLAGS`) and emits an
 * advisory report. It exits NON-ZERO only on a significant regression
 * past the budget. This is intentionally weaker than the causal-copy
 * linter, which has a clean signal.
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Budget for flagged occurrences before the script exits non-zero.
// Sized to absorb legitimate test-fixture noise + schema version
// literals. Tighten over time as the kernel's centralized-thresholds
// discipline matures.
const MAX_FLAGS = Number(process.env.THRESHOLDS_LINT_BUDGET ?? 1500);

const TARGET_GLOBS = [
  'packages/analysis/src',
  'packages/exporter/src',
  'packages/viewer/src',
];

// Numeric literal regex: int or float, with optional unary minus.
// Excludes hex (0x…) and scientific notation prefixes that aren't bare
// magic numbers (they almost always come from canonical math).
const NUM_RE = /(?<![\w.])-?\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?(?![\w.])/g;

const WHITELIST_VALUES = new Set([
  '0', '1', '-1', '2', '-2', '3', '4', '5', '10', '16', '32', '64',
  '0.0', '1.0', '0.5', '0.25', '0.75', '100', '1000', '1024',
]);

const IGNORE_LINE_HINTS = [
  /\/\//,           // line comment
  /^\s*\*/,         // jsdoc continuation
  /THRESHOLDS\./,   // already centralized
  /from ['"]/,      // import path
  /import\b/,
  /test\(/,         // vitest descriptions
  /describe\(/,
  /it\(/,
  /expect\b/,       // assertions reference literals legitimately
  /toBe\b/,
  /toEqual\b/,
  /toBeCloseTo\b/,
  /toHaveLength\b/,
  /toBeGreaterThan\b/,
  /toBeLessThan\b/,
  /toBeLessThanOrEqual\b/,
  /toBeGreaterThanOrEqual\b/,
  /\bversion\s*:/,  // schema version markers
  /^\s*version:/,
  /^\s*generatedAt:/,
];

const IGNORE_FILE_HINTS = [
  /\.test\.(ts|tsx)$/,
  /\bfixtures?\b/,
  /thresholds\.ts$/,
  /\.d\.ts$/,
];

async function findFiles() {
  const out = [];
  for (const rel of TARGET_GLOBS) {
    const root = path.join(REPO_ROOT, rel);
    for await (const entry of glob('**/*.{ts,tsx}', { cwd: root })) {
      const abs = path.join(root, entry);
      if (IGNORE_FILE_HINTS.some((re) => re.test(abs))) continue;
      out.push(abs);
    }
  }
  return out;
}

async function scanFile(absPath) {
  const text = await readFile(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const hits = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (inBlockComment) {
      const close = line.indexOf('*/');
      if (close < 0) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    const openIdx = line.indexOf('/*');
    if (openIdx >= 0 && !line.slice(openIdx).includes('*/')) {
      inBlockComment = true;
      line = line.slice(0, openIdx);
    }
    if (IGNORE_LINE_HINTS.some((re) => re.test(line))) continue;
    NUM_RE.lastIndex = 0;
    for (let m = NUM_RE.exec(line); m !== null; m = NUM_RE.exec(line)) {
      const val = m[0];
      if (WHITELIST_VALUES.has(val)) continue;
      hits.push({ line: i + 1, val, text: line.trim() });
    }
  }
  return hits;
}

async function main() {
  const files = await findFiles();
  let total = 0;
  const perFile = [];
  for (const f of files) {
    const hits = await scanFile(f);
    if (hits.length === 0) continue;
    total += hits.length;
    perFile.push({ f, hits });
  }

  // Sort by file with most hits first (easier to triage hot spots).
  perFile.sort((a, b) => b.hits.length - a.hits.length);

  // Advisory output, capped to top hot-spot files so we don't drown
  // CI logs.
  const topN = Math.min(perFile.length, 8);
  for (let i = 0; i < topN; i += 1) {
    const { f, hits } = perFile[i];
    const rel = path.relative(REPO_ROOT, f);
    console.error(`lint-thresholds-imports: ${rel} — ${hits.length} bare numeric literal(s)`);
  }

  console.error(
    `\nlint-thresholds-imports: ${total} bare numeric literal(s) across ${perFile.length} files (budget ${MAX_FLAGS}).`,
  );
  console.error(
    `Note: this is a coarse heuristic. False positives are expected on test descriptors / schema versions.`,
  );
  console.error(
    `Centralize new numeric guards into packages/analysis/src/thresholds.ts (per plan §"Tunable parameters").`,
  );

  if (total > MAX_FLAGS) {
    console.error(
      `\nlint-thresholds-imports: BUDGET EXCEEDED (${total} > ${MAX_FLAGS}). Consider centralizing new constants or raising the budget via env THRESHOLDS_LINT_BUDGET.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    `lint-thresholds-imports: fatal: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(2);
});
