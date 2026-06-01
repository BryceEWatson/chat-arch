#!/usr/bin/env node
/**
 * Lint guard for the "Centralize data processing" plan: viewer
 * components should be thin renderers. `data → view-model` derivations
 * belong in `packages/analysis/src/selectors/` (schema-typed) or
 * `packages/viewer/src/selectors/` (client-state-coupled) — NOT inline
 * in a component.
 *
 * This scans `packages/viewer/src/components/**\/*.tsx` and flags lines
 * that look like data-derivation done in-component:
 *
 *   (a) `.reduce(` / `.sort(` / `new Map(` / `.flatMap(` — the structural
 *       transform primitives. Inside a renderer they almost always mean a
 *       view-model is being built where a selector should be.
 *   (b) The inline-Wilson fingerprint (`1.96`, `z * z`, `Math.sqrt(` near
 *       a `/ denom`) — the one hard stat duplication the plan calls out.
 *       A selector must call `wilsonCI` from `@chat-arch/analysis` instead.
 *
 * Heuristic, so false positives are expected (a `.sort()` on a UI-local
 * list is fine). Like `lint-thresholds-imports.mjs`, it is BUDGET-based:
 * exits ZERO while the flag count stays at-or-under `MAX_FLAGS`, NON-ZERO
 * on a regression past it. The budget starts at the pre-refactor count
 * and is RATCHETED DOWN one phase at a time as derivations move into
 * selectors. Override via `DATA_PROCESSING_LINT_BUDGET`.
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Budget for flagged occurrences before the script exits non-zero.
// Starts at the Phase-0 baseline (the pre-refactor count) so the scaffold
// PR is green; ratcheted DOWN each phase as derivations migrate into
// selectors. The plan's terminal state is a budget at the irreducible
// (UI-coupled) floor.
const MAX_FLAGS = Number(process.env.DATA_PROCESSING_LINT_BUDGET ?? 33);

const TARGET_GLOB_ROOT = 'packages/viewer/src/components';

// Structural transform primitives — building a view-model in-component.
const TRANSFORM_RE = /\.reduce\(|\.flatMap\(|\bnew Map\(|\.sort\(/;
// Inline-Wilson / hand-rolled-stat fingerprints (the plan's lone hard dup).
const STAT_FINGERPRINT_RE = /\b1\.96\b|\bz\s*\*\s*z\b|Math\.sqrt\(/;

const IGNORE_FILE_HINTS = [/\.test\.(ts|tsx)$/, /\.d\.ts$/];

const IGNORE_LINE_HINTS = [
  /^\s*\/\//, // line comment
  /^\s*\*/, // jsdoc continuation
  /^\s*import\b/,
  /from ['"]/,
];

async function findFiles() {
  const out = [];
  const root = path.join(REPO_ROOT, TARGET_GLOB_ROOT);
  for await (const entry of glob('**/*.tsx', { cwd: root })) {
    const abs = path.join(root, entry);
    if (IGNORE_FILE_HINTS.some((re) => re.test(abs))) continue;
    out.push(abs);
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
    if (TRANSFORM_RE.test(line)) {
      hits.push({ line: i + 1, kind: 'transform', text: line.trim() });
    }
    if (STAT_FINGERPRINT_RE.test(line)) {
      hits.push({ line: i + 1, kind: 'stat', text: line.trim() });
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

  perFile.sort((a, b) => b.hits.length - a.hits.length);

  const topN = Math.min(perFile.length, 10);
  for (let i = 0; i < topN; i += 1) {
    const { f, hits } = perFile[i];
    const rel = path.relative(REPO_ROOT, f);
    const stat = hits.filter((h) => h.kind === 'stat').length;
    console.error(
      `lint-data-processing: ${rel} — ${hits.length} in-component derivation(s)` +
        (stat > 0 ? ` (incl. ${stat} hand-rolled-stat fingerprint(s))` : ''),
    );
  }

  console.error(
    `\nlint-data-processing: ${total} in-component derivation flag(s) across ${perFile.length} file(s) (budget ${MAX_FLAGS}).`,
  );
  console.error(
    `Move data → view-model transforms into packages/analysis/src/selectors (schema-typed) or`,
  );
  console.error(
    `packages/viewer/src/selectors (client-state-coupled). Components render; never reimplement a stat.`,
  );

  if (total > MAX_FLAGS) {
    console.error(
      `\nlint-data-processing: BUDGET EXCEEDED (${total} > ${MAX_FLAGS}). ` +
        `Migrate the new derivation into a selector, or (if intentional/UI-coupled) raise ` +
        `the budget via env DATA_PROCESSING_LINT_BUDGET.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    `lint-data-processing: fatal: ${err instanceof Error ? err.stack : String(err)}`,
  );
  process.exit(2);
});
