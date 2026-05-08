#!/usr/bin/env node
/**
 * One-off audit for the heuristic correction-recall stage. Walks every
 * session's transcript the same way the exporter does, applies the
 * same `looksLikeUserPrompt` filter, runs the same regex families,
 * and reports:
 *
 *   - total user turns (pre / post wrapper-filter)
 *   - turns that fired ≥1 heuristic vs non-firing
 *   - non-firing turns ranked by "looks like a correction" weak signals
 *     (pronouns, modal verbs, soft-redirect markers, comparative tonals)
 *   - random sample of high-rank non-firing turns for spot-check
 *
 * Usage:
 *   node scripts/audit-correction-recall.mjs [--data-dir <path>] [--sample N] [--max-len 320]
 *
 * Defaults match the standalone dev path:
 *   --data-dir apps/standalone/public/chat-arch-data
 *   --sample   25
 *   --max-len  320  (truncate displayed turn text)
 *
 * Pure inspection — no writes.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- Patterns mirror packages/analysis/src/detectCorrectionCandidates.ts ----------
// MAINTENANCE NOTE: these regexes are duplicated from
// `packages/analysis/src/detectCorrectionCandidates.ts` deliberately —
// the script runs as a one-shot Node ESM with no build step and the
// analysis package's `dist/` may not exist on a fresh clone. If you
// change the patterns there, update them here too. A future cleanup
// could expose the patterns as a separate exported module so both
// places import the canonical source.
const STOP_PATTERNS = [
  /\b(stop|quit|cease)\b\s+(adding|generating|writing|using|making|doing|including)\b/i,
  /\bplease\s+(stop|don'?t)\b/i,
];
const NEGATION_EXCLUSIONS = '(?:worry|mind|think|know|believe|wanna|want|see|forget|hesitate|tell|matter)';
const NEGATION_PATTERNS = [
  /\b(don'?t|do not|never)\b\s+(add|generate|write|use|make|do|include|create|put)\b/i,
  /\bno+,?\s+(don'?t|not)\b/i,
  new RegExp(`\\b(don'?t|do not|never)\\b\\s+(?!${NEGATION_EXCLUSIONS}\\b)[a-z]{2,}\\b`, 'i'),
];
const INSTEAD_PATTERNS = [/\binstead of\b/i, /\brather than\b/i, /\bnot\b.+\bbut\b/i];
const IMPERATIVE_OVERRIDE_PATTERNS = [
  /^\s*(always|never|only|prefer|just|please)\b/i,
  /\b(use|prefer)\s+\w+\s+(not|over|instead of)\b/i,
];
const SOFT_REDIRECT_PATTERNS = [
  /^\s*(actually|wait|hmm+|hold on|hang on|nope|nah)\b/i,
  /^\s*let'?s\s+\w+/i,
];
const WANT_PREFER_PATTERNS = [
  /\bi\s+(want|need|prefer|wish)\b/i,
  /\bi'?d\s+(rather|prefer|like)\b/i,
  /\bi\s+would\s+(like|prefer|rather)\b/i,
];
const FRUSTRATION_PATTERNS = [
  /!{2,}/,
  /\?{2,}/,
  /\b(NO|STOP|DON'?T)\b/,
  /\b(again|still)\b.*\b(told|said|asked)\b/i,
];

const POSITIONAL_PREFIX_LEN = 300;

function firesHeuristic(userText) {
  const prefix = userText.slice(0, POSITIONAL_PREFIX_LEN);
  const tryAll = (pats, scope) => {
    const hay = scope === 'prefix' ? prefix : userText;
    for (const p of pats) if (p.test(hay)) return true;
    return false;
  };
  return (
    tryAll(STOP_PATTERNS, 'full') ||
    tryAll(NEGATION_PATTERNS, 'full') ||
    tryAll(INSTEAD_PATTERNS, 'prefix') ||
    tryAll(IMPERATIVE_OVERRIDE_PATTERNS, 'full') ||
    tryAll(FRUSTRATION_PATTERNS, 'full') ||
    tryAll(SOFT_REDIRECT_PATTERNS, 'prefix') ||
    tryAll(WANT_PREFER_PATTERNS, 'full')
  );
}

// ---------- looksLikeUserPrompt filter (mirrors corrections.ts) ----------
const WRAPPER_PREFIXES = [
  '<command-message>',
  '<command-name>',
  '<command-args>',
  '<system-reminder>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<scheduled-task',
  '<uploaded_files>',
  'Base directory for this skill:',
  '<file>',
  '<file_path>',
  '<file_uuid>',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  '[Request interrupted by user',
];
function looksLikeUserPrompt(text) {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  for (const prefix of WRAPPER_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false;
  }
  if (trimmed.length > 4000) return false;
  return true;
}

// ---------- Weak "this might be a correction" signals (NOT in current heuristic) ----------
const WEAK_SIGNAL_RULES = [
  { name: 'soft-redirect', pat: /^\s*(actually|wait|hmm|hold on|hang on|nope|nah)\b/i },
  { name: 'lets-construction', pat: /^\s*let'?s\b/i },
  { name: 'i-want-prefer', pat: /\bi('| )(want|need|prefer|rather|d like|would like|wish)\b/i },
  { name: 'tonal-comparative', pat: /\b(shorter|simpler|cleaner|tighter|more concise|less verbose|less formal|more direct|more terse|less wordy)\b/i },
  { name: 'be-more-less', pat: /\bbe\s+(more|less)\s+\w+/i },
  { name: 'make-it', pat: /\bmake it\s+(shorter|simpler|cleaner|less|more|smaller|bigger|tighter)\b/i },
  { name: 'without-clause', pat: /\bwithout\s+(using|adding|including|writing|generating|creating)\b/i },
  { name: 'broad-negation', pat: /\b(don'?t|do not|never)\b\s+(?!add\b|generate\b|write\b|use\b|make\b|do\b|include\b|create\b|put\b)[a-z]{2,}\b/i },
  { name: 'why-pushback', pat: /^\s*(why|why are you|why did you|why is)\b/i },
  { name: 'should-not', pat: /\b(should|shouldn'?t|shouldn't|ought)\b/i },
  { name: 'thats-not-this', pat: /\bthat'?s\s+(not|wrong|incorrect|backwards)\b/i },
  { name: 'i-said-told', pat: /\bi\s+(said|told|asked|already)\b/i },
  { name: 'second-person-imperative', pat: /^\s*(don'?t|stop|never|just|please)\s+\w+/i },
];

function weakSignals(userText) {
  const hits = [];
  for (const r of WEAK_SIGNAL_RULES) {
    if (r.pat.test(userText)) hits.push(r.name);
  }
  return hits;
}

// ---------- Transcript parsers (mirror corrections.ts) ----------
function extractCloudText(m) {
  if (typeof m.text === 'string' && m.text !== '') return m.text;
  if (Array.isArray(m.content)) {
    const parts = [];
    for (const part of m.content) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}
function parseCloudTurns(sessionId, raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  const out = [];
  let lastAssistant = null;
  let userIdx = 0;
  for (const m of j.chat_messages ?? []) {
    const text = extractCloudText(m);
    if (text === null) continue;
    if (m.sender === 'human') {
      out.push({ sessionId, userTurnIndex: userIdx, userText: text, precedingAssistantText: lastAssistant });
      userIdx += 1;
    } else if (m.sender === 'assistant') {
      lastAssistant = text;
    }
  }
  return out;
}
function extractJsonlText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}
function parseJsonlTurns(sessionId, raw) {
  const out = [];
  let lastAssistant = null;
  let userIdx = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object') continue;
    const type = obj.type;
    const msg = obj.message;
    if (msg === null || typeof msg !== 'object') continue;
    const role = msg.role;
    const text = extractJsonlText(msg.content);
    if (text === null) continue;
    if (type === 'user' && role === 'user') {
      out.push({ sessionId, userTurnIndex: userIdx, userText: text, precedingAssistantText: lastAssistant });
      userIdx += 1;
    } else if (type === 'assistant' && role === 'assistant') {
      lastAssistant = text;
    }
  }
  return out;
}

// ---------- Args ----------
function parseArgs(argv) {
  const out = {
    dataDir: 'apps/standalone/public/chat-arch-data',
    sample: 25,
    maxLen: 320,
    minLen: 12,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--data-dir' && next !== undefined) {
      out.dataDir = next;
      i += 1;
    } else if (a === '--sample' && next !== undefined) {
      out.sample = Number(next);
      i += 1;
    } else if (a === '--max-len' && next !== undefined) {
      out.maxLen = Number(next);
      i += 1;
    } else if (a === '--min-len' && next !== undefined) {
      out.minLen = Number(next);
      i += 1;
    }
  }
  return out;
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirAbs = path.resolve(repoRoot, args.dataDir);

  const manifestRaw = await readFile(path.join(dataDirAbs, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  const stats = {
    sessions: 0,
    sessionsScanned: 0,
    sessionsMissing: 0,
    rawUserTurns: 0,
    droppedByWrapperFilter: 0,
    droppedByLength4000: 0,
    survivingTurns: 0,
    firedHeuristic: 0,
    nonFiring: 0,
    nonFiringWithWeakSignal: 0,
  };
  const weakSignalTallies = {};
  const candidates = []; // non-firing turns with ≥1 weak signal

  for (const entry of manifest.sessions ?? []) {
    stats.sessions += 1;
    if (!entry.transcriptPath) {
      stats.sessionsMissing += 1;
      continue;
    }
    const abs = path.resolve(dataDirAbs, entry.transcriptPath);
    const rel = path.relative(dataDirAbs, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      stats.sessionsMissing += 1;
      continue;
    }
    let raw;
    try {
      raw = await readFile(abs, 'utf8');
    } catch {
      stats.sessionsMissing += 1;
      continue;
    }
    stats.sessionsScanned += 1;
    const turns =
      entry.source === 'cloud' ? parseCloudTurns(entry.id, raw) : parseJsonlTurns(entry.id, raw);
    for (const t of turns) {
      stats.rawUserTurns += 1;
      const trimmed = t.userText.trim();
      // Track which side of the filter cuts what.
      let dropped = false;
      if (trimmed === '') {
        dropped = true;
      } else if (WRAPPER_PREFIXES.some((p) => trimmed.startsWith(p))) {
        stats.droppedByWrapperFilter += 1;
        dropped = true;
      } else if (trimmed.length > 4000) {
        stats.droppedByLength4000 += 1;
        dropped = true;
      }
      if (dropped) continue;
      stats.survivingTurns += 1;

      if (firesHeuristic(t.userText)) {
        stats.firedHeuristic += 1;
        continue;
      }
      stats.nonFiring += 1;
      const weak = weakSignals(t.userText);
      if (weak.length === 0) continue;
      if (t.userText.length < args.minLen) continue;
      stats.nonFiringWithWeakSignal += 1;
      for (const w of weak) {
        weakSignalTallies[w] = (weakSignalTallies[w] ?? 0) + 1;
      }
      candidates.push({
        sessionId: t.sessionId,
        turnIndex: t.userTurnIndex,
        weak,
        text: t.userText,
        precedingAssistant: t.precedingAssistantText,
      });
    }
  }

  // Pretty-print stats.
  const pct = (a, b) => (b === 0 ? '0%' : `${Math.round((a / b) * 100)}%`);
  console.log('===== correction-recall audit =====');
  console.log(`data-dir:              ${args.dataDir}`);
  console.log(`sessions:              ${stats.sessions}`);
  console.log(`  scanned:             ${stats.sessionsScanned}`);
  console.log(`  missing transcript:  ${stats.sessionsMissing}`);
  console.log('');
  console.log(`raw user turns:        ${stats.rawUserTurns}`);
  console.log(`  wrapper-filtered:    ${stats.droppedByWrapperFilter}`);
  console.log(`  length>4000 dropped: ${stats.droppedByLength4000}`);
  console.log(`  survived filter:     ${stats.survivingTurns}`);
  console.log('');
  console.log(`fired heuristic:       ${stats.firedHeuristic}  (${pct(stats.firedHeuristic, stats.survivingTurns)} of survivors)`);
  console.log(`non-firing:            ${stats.nonFiring}  (${pct(stats.nonFiring, stats.survivingTurns)} of survivors)`);
  console.log(`  with weak signal:    ${stats.nonFiringWithWeakSignal}  (${pct(stats.nonFiringWithWeakSignal, stats.nonFiring)} of non-firing)`);
  console.log('');
  console.log('weak-signal hits among non-firing turns:');
  const sortedSig = Object.entries(weakSignalTallies).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sortedSig) {
    console.log(`  ${name.padEnd(28)} ${n}`);
  }
  console.log('');

  // Random sample of weak-signal non-firing turns. Sort by signal-count
  // desc first, then shuffle within tier so the user sees the densest
  // candidates first but with variety across sessions.
  candidates.sort((a, b) => b.weak.length - a.weak.length);
  const top = candidates.slice(0, Math.min(candidates.length, args.sample * 4));
  // Fisher-Yates shuffle for the slice (deterministic-ish: based on indices).
  for (let i = top.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [top[i], top[j]] = [top[j], top[i]];
  }
  const sample = top.slice(0, args.sample);

  console.log(`===== random sample of ${sample.length} non-firing turns with weak signals =====`);
  for (const c of sample) {
    console.log('');
    console.log(`-- session ${c.sessionId} · turn ${c.turnIndex} · signals: ${c.weak.join(', ')}`);
    if (c.precedingAssistant) {
      console.log(`   ASSISTANT: ${truncate(c.precedingAssistant.replace(/\s+/g, ' '), Math.floor(args.maxLen / 2))}`);
    }
    console.log(`   USER:      ${truncate(c.text.replace(/\s+/g, ' '), args.maxLen)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
