#!/usr/bin/env node
/**
 * Lint guard against real-looking PII inside test migration fixtures.
 *
 * Per the plan's "Fixture PII constraint" subsection
 * (ship-readiness review iter-3): every identifier in
 * `packages/exporter/test/migration/fixtures/**` must use reserved /
 * fake values. Real-looking 40-char hex SHAs, the user's name slug, or
 * production-shaped GitHub URLs in a checked-in fixture risk
 * cross-pollinating test runs with personal data.
 *
 * Scope: `packages/exporter/test/migration/fixtures/**` only. Other
 * fixtures (e.g. cowork session mocks) have their own discipline and
 * are out of scope.
 *
 * Grep-rejects (exit code 1 on any hit):
 *   - 40-char hex SHAs not starting with `deadbeef`
 *   - the literal `bryceewatson`, `bryce-watson`
 *   - GitHub URLs whose org segment doesn't start with `example-`
 *   - the literal string `chat-arch` as a repo name (`/chat-arch.git`
 *     or `chat-arch/` repo segment in a GitHub URL — NOT as a path
 *     prefix `chat-arch/packages/...`)
 *
 * Skips `.bin` and binary files (matched by extension only).
 */

import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FIXTURE_ROOT = path.join(
  REPO_ROOT,
  'packages',
  'exporter',
  'test',
  'migration',
  'fixtures',
);

// 40-char hex SHA not starting with deadbeef.
const REAL_SHA_RE = /\b(?!deadbeef)[0-9a-f]{40}\b/g;

// Real-looking GitHub PR/repo URL — capture the org segment.
const GH_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/g;

const NAME_PATTERNS = [
  /\bbryceewatson\b/gi,
  /\bbryce-watson\b/gi,
];

// `chat-arch` as a repo segment — github.com/<org>/chat-arch or .../chat-arch.git.
// NOT as a path prefix: chat-arch/packages/... is legitimate.
const CHAT_ARCH_REPO_RE = /\/chat-arch(?:\.git\b|\/(?!packages\b)|\b)/g;

const BIN_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bin', '.zip']);

async function findFixtureFiles() {
  const out = [];
  try {
    for await (const entry of glob('**/*', { cwd: FIXTURE_ROOT, withFileTypes: false })) {
      const abs = path.join(FIXTURE_ROOT, entry);
      const ext = path.extname(abs).toLowerCase();
      if (BIN_EXTENSIONS.has(ext)) continue;
      out.push(abs);
    }
  } catch {
    // Fixture root may not exist yet — that's OK, return empty.
  }
  return out;
}

async function scanFile(absPath) {
  let text;
  try {
    text = await readFile(absPath, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Real-SHA check.
    REAL_SHA_RE.lastIndex = 0;
    for (let m = REAL_SHA_RE.exec(line); m !== null; m = REAL_SHA_RE.exec(line)) {
      hits.push({
        line: i + 1,
        kind: 'real-sha',
        match: m[0],
        text: line.trim(),
      });
    }

    // Name pattern check.
    for (const re of NAME_PATTERNS) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m !== null; m = re.exec(line)) {
        hits.push({
          line: i + 1,
          kind: 'real-name',
          match: m[0],
          text: line.trim(),
        });
      }
    }

    // GitHub URL — org must start with example-.
    GH_URL_RE.lastIndex = 0;
    for (let m = GH_URL_RE.exec(line); m !== null; m = GH_URL_RE.exec(line)) {
      const org = m[1];
      if (!org.startsWith('example-')) {
        hits.push({
          line: i + 1,
          kind: 'real-github-org',
          match: m[0],
          text: line.trim(),
        });
      }
    }

    // chat-arch as repo name (NOT as path prefix).
    CHAT_ARCH_REPO_RE.lastIndex = 0;
    for (let m = CHAT_ARCH_REPO_RE.exec(line); m !== null; m = CHAT_ARCH_REPO_RE.exec(line)) {
      hits.push({
        line: i + 1,
        kind: 'chat-arch-as-repo',
        match: m[0],
        text: line.trim(),
      });
    }
  }
  return hits;
}

async function main() {
  const files = await findFixtureFiles();
  let hadHits = false;
  for (const f of files) {
    const hits = await scanFile(f);
    if (hits.length === 0) continue;
    hadHits = true;
    const rel = path.relative(REPO_ROOT, f);
    for (const h of hits) {
      console.error(`${rel}:${h.line} — PII violation (${h.kind}): '${h.match}'  ⇒  ${h.text}`);
    }
  }
  if (hadHits) {
    console.error(
      '\nlint-fixture-pii: migration fixtures must use only fake/reserved identifiers (example-*, deadbeef-* SHAs, RFC-2606 hosts).',
    );
    process.exit(1);
  }
  console.log(
    `lint-fixture-pii: scanned ${files.length} fixture file(s), no PII violations.`,
  );
}

main().catch((err) => {
  console.error(`lint-fixture-pii: fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
