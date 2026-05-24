#!/usr/bin/env node
/**
 * Lint guard against causal-flavored copy in viewer surfaces.
 *
 * Per the plan's statistical-methodology disclosure (PII / methodology
 * section): every viewer surface is a "descriptive contrast, not a
 * causal estimate". The user's confounded-by-indication corpus does
 * not support clean causal claims. Surfacing prose like "X causes Y"
 * or "Y is the effect of X" misleads.
 *
 * Scope: `packages/viewer/src/**\/*.tsx` (JSX files only — non-JSX
 * `.ts` files are technical plumbing that legitimately discusses
 * causation in code comments / error messages). Checks JSX text
 * content and string literals (single/double/backtick). Skips line +
 * block comments, `import` lines, and lines marked with an explicit
 * `// allow-causal` suppression comment (for the methodology
 * disclosure that has to name the forbidden tokens by reference).
 *
 * Forbidden tokens (whole-word, case-insensitive):
 *   - because
 *   - causes
 *   - caused by
 *   - due to
 *   - effect of
 *
 * Exit code 1 with a `file:line` report on any match.
 *
 * Wired into `pnpm lint` at the repo root.
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Whole-word matches; case-insensitive. The `\b` word boundary stops us
// from flagging substrings like 'database' (no false positive on 'cause').
// Two-word phrases use `\s+` to tolerate non-breaking whitespace.
const FORBIDDEN = [
  { pattern: /\bbecause\b/i, label: 'because' },
  { pattern: /\bcauses\b/i, label: 'causes' },
  { pattern: /\bcaused\s+by\b/i, label: 'caused by' },
  { pattern: /\bdue\s+to\b/i, label: 'due to' },
  { pattern: /\beffect\s+of\b/i, label: 'effect of' },
];

/**
 * Strip line comments (`// …`) and block comments (`/* … *\/`) from a
 * single line. Conservative — does not attempt to track multi-line block
 * comments across lines (false negatives there are acceptable; the user
 * has not asked us to write a full TS tokenizer).
 *
 * Also strips `import` statements wholesale — module names can contain
 * forbidden tokens (e.g. `becausejs/utils`).
 */
function maskNonProse(line) {
  // Drop import statements wholesale.
  if (/^\s*import\b/.test(line)) return '';
  // Drop the rest of the line after a `//`.
  const lineCommentIdx = line.indexOf('//');
  let work = lineCommentIdx >= 0 ? line.slice(0, lineCommentIdx) : line;
  // Strip inline block comments that open + close on the same line.
  work = work.replace(/\/\*[\s\S]*?\*\//g, '');
  return work;
}

/** Walk packages/viewer/src and return matching JSX files. */
async function findViewerFiles() {
  const root = path.join(REPO_ROOT, 'packages', 'viewer', 'src');
  const out = [];
  for await (const entry of glob('**/*.tsx', { cwd: root })) {
    // Skip test files — they may include "because" in test descriptions.
    if (/\.test\.tsx$/.test(entry)) continue;
    out.push(path.join(root, entry));
  }
  return out;
}

async function scanFile(absPath) {
  const text = await readFile(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const hits = [];
  // Track whether we're inside a multi-line block comment (open on a
  // prior line, not yet closed). Conservative tracker.
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    // Handle multi-line block comments by tracking state across lines.
    if (inBlockComment) {
      const close = line.indexOf('*/');
      if (close < 0) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    // Open without close on this line — mask the trailing part.
    const openIdx = line.indexOf('/*');
    if (openIdx >= 0 && !line.slice(openIdx).includes('*/')) {
      inBlockComment = true;
      line = line.slice(0, openIdx);
    }
    // Allow-suppression: a line tagged with `// allow-causal` is the
    // escape hatch for self-referential text (e.g. the methodology
    // disclosure that has to NAME the forbidden tokens to disavow them).
    if (/allow-causal/i.test(line)) continue;
    const masked = maskNonProse(line);
    if (masked === '') continue;
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(masked)) {
        hits.push({ line: i + 1, label, text: line.trim() });
      }
    }
  }
  return hits;
}

async function main() {
  const files = await findViewerFiles();
  let hadHits = false;
  for (const f of files) {
    const hits = await scanFile(f);
    if (hits.length === 0) continue;
    hadHits = true;
    const rel = path.relative(REPO_ROOT, f);
    for (const h of hits) {
      // Format: file:line — forbidden token: 'label'  ⇒  surrounding text
      console.error(`${rel}:${h.line} — forbidden causal token '${h.label}': ${h.text}`);
    }
  }
  if (hadHits) {
    console.error(
      '\nlint-causal-copy: viewer surfaces must use descriptive-contrast language, not causal claims.',
    );
    console.error(
      'Allowed: "associated with", "co-occurs with", "the contrast between", etc.',
    );
    process.exit(1);
  }
  console.log(`lint-causal-copy: scanned ${files.length} files, no forbidden tokens.`);
}

main().catch((err) => {
  console.error(`lint-causal-copy: fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
