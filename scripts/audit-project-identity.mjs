#!/usr/bin/env node
/**
 * Post-rescan audit for Project Identity v2. Validates the LIVE on-disk
 * artifacts (the populated manifest + the v2 projects.json with its
 * authoritative per-session `attribution` map) against the targets in
 * the Project Identity v2 plan (§0 / §12).
 *
 * Reads (no writes):
 *   - <dataDir>/manifest.json
 *       { schemaVersion, generatedAt, counts,
 *         sessions: [ { id, source, cwd?, project?, cwdKind, userTurns,
 *                       assistantTurns?, scheduledTaskId?, sessionType?,
 *                       userSelectedFolders?, ... } ] }
 *   - <dataDir>/analysis/projects.json
 *       { generatedAt,
 *         projects: [ { id, displayName, sessionIds: string[], source } ],
 *         attribution: { [sessionId]: { projectId, resolvedVia, confidence } } }
 *     `attribution` is the authoritative per-session provenance. resolvedVia is
 *     one of: 'override' | 'project_field' | 'scheduled-task' | 'vm-folder' |
 *     'cwd_basename' | 'title_keyword' | 'unassigned'. The UNASSIGNED project
 *     id is '__unassigned__'.
 *
 * Assertions (each prints PASS/FAIL with the actual number; any FAIL → exit 1):
 *   a. UNASSIGNED residue ≤ 6, plus a coarse reason-distribution breakdown of
 *      the UNASSIGNED set (sums to the count; 'other' bucket bounded).
 *   b. no scheduledTaskId session falls below the routine bucket (every such
 *      session resolves via scheduled-task OR a higher rule — never lower).
 *   c. distinct routine projectIds (among scheduled-task sessions) in a tolerant
 *      band [10,20] (keyed on resolvedVia, NOT id-string prefixes).
 *   d. total projects (excluding __unassigned__) in [25,35].
 *   e. singleton projects (sessionIds.length===1, excluding __unassigned__) < 10.
 *   f. no `proj_outputs` project exists.
 *   g. 'proj_chat-arch' exists and retains ≥ 24 sessions.
 *   h. gated-drop equivalence — auto-reads the v2 rescan's parserSkips.count
 *      from analysis/meta.json (the exporter persists it) and compares to
 *      --prior-unassigned (default 563). A manual --dropped overrides the
 *      meta.json value. Printed as a NOTE and SKIPPED only when neither is
 *      available (e.g. a pre-parserSkips meta.json).
 *
 * Usage:
 *   node scripts/audit-project-identity.mjs [--data-dir <dir>] [--prior-unassigned 563] [--dropped <n>]
 *
 * Defaults match the standalone dev path:
 *   --data-dir          apps/standalone/public/chat-arch-data
 *   --prior-unassigned  563   (developer-corpus expected pre-v2 UNASSIGNED count)
 *   --dropped           (unset — supply to enable assertion h)
 *
 * Pure inspection — no writes.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- Thresholds (named consts — no magic numbers) ----------
const UNASSIGNED_PROJECT_ID = '__unassigned__';
const SCHEDULED_TASK_VIA = 'scheduled-task';

// (a) UNASSIGNED residue ceiling.
const MAX_UNASSIGNED = 6;
// (a) ceiling on the 'other' (turns>0, genuinely unidentifiable) reason bucket.
const MAX_UNASSIGNED_OTHER = 6;
// (c) routine project count tolerant band (key on resolvedVia).
const ROUTINE_PROJECT_MIN = 10;
const ROUTINE_PROJECT_MAX = 20;
// (d) total non-unassigned project count band (primary).
const TOTAL_PROJECT_MIN = 25;
const TOTAL_PROJECT_MAX = 35;
// (d) looser overall band from §12.
const TOTAL_PROJECT_LOOSE_MIN = 20;
const TOTAL_PROJECT_LOOSE_MAX = 40;
// (e) singleton project ceiling (exclusive).
const MAX_SINGLETONS = 10;
// (f) the basename bucket that the scheduled-task collapse must have eliminated.
const FORBIDDEN_PROJECT_ID = 'proj_outputs';
// (g) chat-arch retention.
const CHAT_ARCH_PROJECT_ID = 'proj_chat-arch';
const CHAT_ARCH_MIN_SESSIONS = 24;
// (h) developer-corpus expected pre-v2 UNASSIGNED count.
const DEFAULT_PRIOR_UNASSIGNED = 563;

// ---------- Args ----------
function parseArgs(argv) {
  const out = {
    dataDir: 'apps/standalone/public/chat-arch-data',
    priorUnassigned: DEFAULT_PRIOR_UNASSIGNED,
    dropped: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--data-dir' && next !== undefined) {
      out.dataDir = next;
      i += 1;
    } else if (a === '--prior-unassigned' && next !== undefined) {
      out.priorUnassigned = Number(next);
      i += 1;
    } else if (a === '--dropped' && next !== undefined) {
      out.dropped = Number(next);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

const HELP_TEXT = `project-identity audit — validate Project Identity v2 against live on-disk artifacts

Usage:
  node scripts/audit-project-identity.mjs [--data-dir <dir>] [--prior-unassigned 563] [--dropped <n>]

Options:
  --data-dir <dir>          dir holding manifest.json + analysis/projects.json
                            (default: apps/standalone/public/chat-arch-data)
  --prior-unassigned <n>    pre-v2 UNASSIGNED count for the gated-drop check
                            (default: ${DEFAULT_PRIOR_UNASSIGNED})
  --dropped <n>             0-turn-sidecars dropped by the v2 rescan; supply
                            with --prior-unassigned to enable assertion h
  -h, --help                show this help

Pure inspection — no writes. Exits 1 if any assertion FAILs, else 0.`;

// ---------- Result collector ----------
function makeReporter() {
  const failures = [];
  return {
    /** Record one assertion. ok=true → PASS, false → FAIL, null → SKIP/NOTE. */
    check(ok, label, detail) {
      if (ok === null) {
        console.log(`NOTE  ${label}${detail ? ` — ${detail}` : ''}`);
        return;
      }
      const tag = ok ? 'PASS' : 'FAIL';
      console.log(`${tag}  ${label}${detail ? ` — ${detail}` : ''}`);
      if (!ok) failures.push(label);
    },
    failures,
  };
}

// ---------- Coarse UNASSIGNED reason classifier (mirrors §12 intent) ----------
// Classifies a manifest entry for an unassigned session into one of three
// coarse reasons. NOT the exporter's resolver logic — a diagnostic bucketing
// so the residue is explainable rather than mysterious.
function classifyUnassignedReason(entry) {
  if (!entry) return 'other';
  const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : '';
  const usf = entry.userSelectedFolders;
  const hasUsf = Array.isArray(usf) && usf.length > 0;
  const turns = typeof entry.userTurns === 'number' ? entry.userTurns : 0;
  // The benign §12 residue is specifically the ZERO-turn VM-haiku-no-USF set.
  // A turns>0 VM session that lost its USF is NOT benign residue — it must
  // surface (fall through to the bounded 'other' bucket), per §12's
  // "surface instead of hiding in a count" intent.
  if (entry.cwdKind === 'vm' && !hasUsf && turns === 0) return 'vm-haiku-no-USF';
  if (cwd === '' && turns > 0) return 'no-cwd-no-title-match';
  return 'other';
}

async function readJsonOrExit(absPath, friendlyName) {
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch {
    console.error(`ERROR: ${friendlyName} not found at ${absPath}`);
    console.error('Run a rescan with the v2 exporter to populate the data dir, then re-run this audit.');
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: ${friendlyName} at ${absPath} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDirAbs = path.resolve(repoRoot, args.dataDir);

  const manifest = await readJsonOrExit(path.join(dataDirAbs, 'manifest.json'), 'manifest.json');
  const projectsFile = await readJsonOrExit(
    path.join(dataDirAbs, 'analysis', 'projects.json'),
    'analysis/projects.json',
  );

  const manifestSessions = Array.isArray(manifest.sessions) ? manifest.sessions : [];
  const projects = Array.isArray(projectsFile.projects) ? projectsFile.projects : [];
  const attribution = projectsFile.attribution;

  // v2 gate: the authoritative attribution map must be present.
  if (attribution === null || typeof attribution !== 'object' || Array.isArray(attribution)) {
    console.error('ERROR: analysis/projects.json has no `attribution` map (pre-v2 shape).');
    console.error('Run a rescan with the v2 exporter (it writes the per-session attribution map), then re-run this audit.');
    process.exit(1);
  }

  // ---------- Derived indexes ----------
  const manifestById = new Map();
  for (const s of manifestSessions) {
    if (s && typeof s.id === 'string') manifestById.set(s.id, s);
  }

  const attribEntries = Object.entries(attribution); // [sessionId, { projectId, resolvedVia, confidence }]

  const viaCounts = {};
  for (const [, rec] of attribEntries) {
    const via = rec && typeof rec.resolvedVia === 'string' ? rec.resolvedVia : '(missing)';
    viaCounts[via] = (viaCounts[via] ?? 0) + 1;
  }

  const projectById = new Map();
  for (const p of projects) {
    if (p && typeof p.id === 'string') projectById.set(p.id, p);
  }
  const unassignedProject = projectById.get(UNASSIGNED_PROJECT_ID);
  const unassignedSessionIds = Array.isArray(unassignedProject?.sessionIds)
    ? unassignedProject.sessionIds
    : [];

  // Sessions whose attribution resolvedVia === 'unassigned'.
  const unassignedViaSessionIds = attribEntries
    .filter(([, rec]) => rec && rec.resolvedVia === 'unassigned')
    .map(([sid]) => sid);

  const report = makeReporter();
  console.log('===== project-identity audit =====');
  console.log(`data-dir:              ${args.dataDir}`);
  console.log(`manifest sessions:     ${manifestSessions.length}`);
  console.log(`attribution entries:   ${attribEntries.length}`);
  console.log(`projects (incl __unassigned__): ${projects.length}`);
  console.log('');
  console.log('resolvedVia distribution:');
  for (const [via, n] of Object.entries(viaCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(via).padEnd(20)} ${n}`);
  }
  console.log('');

  // ---------- (a) UNASSIGNED residue ≤ MAX_UNASSIGNED + reason distribution ----------
  // Use the attribution map as authoritative; cross-check against the
  // __unassigned__ project's sessionIds.length.
  const unassignedCount = unassignedViaSessionIds.length;
  report.check(
    unassignedCount === unassignedSessionIds.length,
    '(a) UNASSIGNED count cross-check (attribution vs __unassigned__.sessionIds)',
    `via='unassigned'=${unassignedCount}, __unassigned__.sessionIds=${unassignedSessionIds.length}`,
  );
  report.check(
    unassignedCount <= MAX_UNASSIGNED,
    `(a) UNASSIGNED residue ≤ ${MAX_UNASSIGNED}`,
    `actual=${unassignedCount}`,
  );

  // Reason-distribution breakdown over the UNASSIGNED set (union of both
  // sources so nothing is silently dropped from the breakdown).
  const unassignedAll = new Set([...unassignedViaSessionIds, ...unassignedSessionIds]);
  const reasonCounts = { 'vm-haiku-no-USF': 0, 'no-cwd-no-title-match': 0, other: 0 };
  for (const sid of unassignedAll) {
    const reason = classifyUnassignedReason(manifestById.get(sid));
    reasonCounts[reason] += 1;
  }
  const reasonSum = reasonCounts['vm-haiku-no-USF'] + reasonCounts['no-cwd-no-title-match'] + reasonCounts.other;
  console.log('  UNASSIGNED reason-distribution:');
  for (const [reason, n] of Object.entries(reasonCounts)) {
    console.log(`    ${reason.padEnd(22)} ${n}`);
  }
  report.check(
    reasonSum === unassignedAll.size,
    '(a) reason-distribution sums to UNASSIGNED count',
    `sum=${reasonSum}, unassigned-set=${unassignedAll.size}`,
  );
  report.check(
    reasonCounts.other <= MAX_UNASSIGNED_OTHER,
    `(a) 'other' (genuinely unidentifiable) bucket ≤ ${MAX_UNASSIGNED_OTHER}`,
    `actual=${reasonCounts.other}`,
  );
  console.log('');

  // ---------- (b) no scheduledTaskId session silently MISSES the routine bucket ----------
  // §12 robust form: a session with a scheduledTaskId must resolve via
  // scheduled-task OR a strictly-higher rule (override / project_field) —
  // NEVER fall through to a lower rule (vm-folder / cwd_basename /
  // title_keyword / unassigned). Hard `===` against the raw scheduledTaskId
  // count would false-FAIL on a legitimately project_field-overridden
  // scheduled session, which §12 explicitly anticipates ("relax to ≥").
  const ALLOWED_FOR_SCHEDULED = new Set(['override', 'project_field', SCHEDULED_TASK_VIA]);
  const scheduledViaCount = viaCounts[SCHEDULED_TASK_VIA] ?? 0;
  const scheduledManifestIds = manifestSessions
    .filter((s) => typeof s.scheduledTaskId === 'string' && s.scheduledTaskId.trim() !== '')
    .map((s) => s.id);
  const missed = scheduledManifestIds.filter((sid) => {
    const via = attribution[sid]?.resolvedVia;
    return via === undefined || !ALLOWED_FOR_SCHEDULED.has(via);
  });
  report.check(
    missed.length === 0,
    '(b) no scheduledTaskId session falls below the routine bucket',
    `scheduledTaskId sessions=${scheduledManifestIds.length}, via='scheduled-task'=${scheduledViaCount}, ` +
      `higher-rule-overridden=${scheduledManifestIds.length - scheduledViaCount}, silently-missed=${missed.length}`,
  );
  console.log('');

  // ---------- (c) distinct routine projects in [ROUTINE_PROJECT_MIN, MAX] ----------
  const routineProjectIds = new Set();
  for (const [, rec] of attribEntries) {
    if (rec && rec.resolvedVia === SCHEDULED_TASK_VIA && typeof rec.projectId === 'string') {
      routineProjectIds.add(rec.projectId);
    }
  }
  const routineCount = routineProjectIds.size;
  report.check(
    routineCount >= ROUTINE_PROJECT_MIN && routineCount <= ROUTINE_PROJECT_MAX,
    `(c) distinct routine projects in [${ROUTINE_PROJECT_MIN},${ROUTINE_PROJECT_MAX}]`,
    `actual=${routineCount}`,
  );
  console.log('');

  // ---------- (d) total projects (excl __unassigned__) in [25,35] + loose band ----------
  const totalProjects = projects.filter((p) => p && p.id !== UNASSIGNED_PROJECT_ID).length;
  report.check(
    totalProjects >= TOTAL_PROJECT_MIN && totalProjects <= TOTAL_PROJECT_MAX,
    `(d) total projects (excl __unassigned__) in [${TOTAL_PROJECT_MIN},${TOTAL_PROJECT_MAX}]`,
    `actual=${totalProjects}`,
  );
  report.check(
    totalProjects >= TOTAL_PROJECT_LOOSE_MIN && totalProjects <= TOTAL_PROJECT_LOOSE_MAX,
    `(d) total projects within looser §12 band [${TOTAL_PROJECT_LOOSE_MIN},${TOTAL_PROJECT_LOOSE_MAX}]`,
    `actual=${totalProjects}`,
  );
  console.log('');

  // ---------- (e) singletons < MAX_SINGLETONS ----------
  const singletons = projects.filter(
    (p) => p && p.id !== UNASSIGNED_PROJECT_ID && Array.isArray(p.sessionIds) && p.sessionIds.length === 1,
  );
  report.check(
    singletons.length < MAX_SINGLETONS,
    `(e) singleton projects (excl __unassigned__) < ${MAX_SINGLETONS}`,
    `actual=${singletons.length}`,
  );
  console.log('');

  // ---------- (f) no proj_outputs ----------
  const hasForbidden = projectById.has(FORBIDDEN_PROJECT_ID);
  report.check(
    !hasForbidden,
    `(f) no \`${FORBIDDEN_PROJECT_ID}\` project exists`,
    hasForbidden ? 'FOUND — scheduled-task collapse did not eliminate the \\outputs basename bucket' : 'absent',
  );
  console.log('');

  // ---------- (g) chat-arch retention ≥ 24 ----------
  const chatArch = projectById.get(CHAT_ARCH_PROJECT_ID);
  const chatArchSessions = Array.isArray(chatArch?.sessionIds) ? chatArch.sessionIds.length : 0;
  report.check(
    chatArch !== undefined && chatArchSessions >= CHAT_ARCH_MIN_SESSIONS,
    `(g) \`${CHAT_ARCH_PROJECT_ID}\` exists and retains ≥ ${CHAT_ARCH_MIN_SESSIONS} sessions`,
    chatArch === undefined ? 'project MISSING' : `sessions=${chatArchSessions}`,
  );
  console.log('');

  // ---------- (h) gated-drop equivalence (skips unless both numbers supplied) ----------
  // Cannot be derived from the post-rescan manifest alone — the phantom
  // 0-turn sidecars are already gone. Try meta.json's parserSkips first,
  // then fall back to the CLI args.
  let droppedFromMeta;
  try {
    const metaRaw = await readFile(path.join(dataDirAbs, 'analysis', 'meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    const c = meta?.parserSkips?.count;
    if (typeof c === 'number') droppedFromMeta = c;
  } catch {
    // meta.json optional; ignore.
  }
  const droppedEffective = args.dropped !== undefined ? args.dropped : droppedFromMeta;
  if (droppedEffective !== undefined && args.priorUnassigned !== undefined && !Number.isNaN(args.priorUnassigned)) {
    report.check(
      droppedEffective === args.priorUnassigned,
      '(h) gated-drop equivalence: dropped === prior-unassigned',
      `dropped=${droppedEffective}${args.dropped === undefined ? ' (from meta.json)' : ''}, prior-unassigned=${args.priorUnassigned}`,
    );
  } else {
    report.check(
      null,
      '(h) gated-drop equivalence SKIPPED',
      'needs the rescan\'s parserSkips.count (logged as "0-turn-sidecars dropped=N") and the prior UNASSIGNED count; pass --dropped <n> [--prior-unassigned <n>] or provide analysis/meta.json',
    );
  }
  console.log('');

  // ---------- Summary ----------
  const failCount = report.failures.length;
  console.log('===== summary =====');
  if (failCount === 0) {
    console.log('All assertions PASSED.');
  } else {
    console.log(`${failCount} assertion(s) FAILED:`);
    for (const f of report.failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
